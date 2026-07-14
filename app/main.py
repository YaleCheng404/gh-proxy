import re
from contextlib import asynccontextmanager
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse, RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask

MAX_REDIRECTS = 3
CHUNK_SIZE = 64 * 1024
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
HEALTH_TEXT = "GitHub Proxy is running securely."
FORBIDDEN_TEXT = "Forbidden: Invalid resource target."

OWNER_REPO = r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
TARGET_PATHS = {
    "github.com": re.compile(rf"^/{OWNER_REPO}/(?:releases|archive|blob|raw|info|git-|tags)(?:/|$)", re.I),
    "raw.githubusercontent.com": re.compile(rf"^/{OWNER_REPO}/.+", re.I),
    "raw.github.com": re.compile(rf"^/{OWNER_REPO}/.+", re.I),
    "gist.githubusercontent.com": re.compile(r"^/[A-Za-z0-9_.-]+/.+", re.I),
    "gist.github.com": re.compile(r"^/[A-Za-z0-9_.-]+/.+", re.I),
    "api.github.com": re.compile(r"^/.+"),
    "git.io": re.compile(r"^/.+"),
    "gitlab.com": re.compile(r"^/.+"),
}
REDIRECT_HOSTS = {
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
}
REQUEST_HEADERS_TO_DROP = {
    "cf-connecting-ip",
    "cf-ipcountry",
    "connection",
    "cookie",
    "forwarded",
    "host",
    "origin",
    "proxy-authorization",
    "referer",
    "transfer-encoding",
    "true-client-ip",
    "upgrade",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
}
RESPONSE_HEADERS_TO_DROP = {
    "clear-site-data",
    "content-security-policy-report-only",
    "set-cookie",
    "transfer-encoding",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(
        limits=httpx.Limits(max_keepalive_connections=200, max_connections=1000),
        timeout=httpx.Timeout(15, read=60),
        follow_redirects=False,
    ) as client:
        app.state.client = client
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index(q: str | None = None):
    return RedirectResponse(f"/{q.lstrip('/')}", 301) if q else PlainTextResponse(HEALTH_TEXT)


@app.api_route("/{raw_target:path}", methods=METHODS)
async def handler(request: Request, raw_target: str):
    if is_preflight(request):
        return preflight(request)

    target = strip_nested_proxy(raw_target, str(request.base_url).rstrip("/"))
    if not target:
        return PlainTextResponse(HEALTH_TEXT)
    if target == "perl-pe-para":
        return perl_rewrite(str(request.base_url).rstrip("/"))

    target_url = parse_target(target, request.url.query)
    if not target_url or not is_allowed(target_url):
        return PlainTextResponse(FORBIDDEN_TEXT, 403)
    if target_url.host == "github.com":
        target_url = target_url.copy_with(path=target_url.path.replace("/blob/", "/raw/", 1))

    try:
        return await proxy(request, target_url)
    except httpx.RequestError:
        return PlainTextResponse("Bad Gateway: Target server error or timeout.", 502)


def strip_nested_proxy(target: str, origin: str) -> str:
    for own_url in (origin, origin.replace("://", ":/")):
        while target.startswith(own_url):
            target = target[len(own_url) :].lstrip("/")
    return target


def parse_target(raw_target: str, query: str = "") -> httpx.URL | None:
    target = raw_target.strip()
    if not target or (re.match(r"^[a-z][a-z\d+.-]*:", target, re.I) and not re.match(r"^https?:", target, re.I)):
        return None

    target = re.sub(r"^https?:/*", "https://", target, count=1, flags=re.I)
    if not target.startswith("https://"):
        target = f"https://{target}"
    if query and "?" not in target:
        target = f"{target}?{query}"

    try:
        return httpx.URL(target)
    except httpx.InvalidURL:
        return None


def is_allowed(url: httpx.URL) -> bool:
    path = TARGET_PATHS.get((url.host or "").lower())
    return url.scheme == "https" and url.port in {None, 443} and bool(path and path.match(url.path))


def can_follow(url: httpx.URL, method: str) -> bool:
    return method in {"GET", "HEAD"} and (
        is_allowed(url)
        or (url.scheme == "https" and url.port in {None, 443} and (url.host or "").lower() in REDIRECT_HOSTS)
    )


async def proxy(request: Request, target: httpx.URL, redirects: int = 0):
    response = await send_upstream(request, target, redirects == 0)
    location = response.headers.get("location")
    redirect = parse_redirect(location, str(target)) if location else None

    if redirect and is_allowed(redirect):
        return stream_response(response, f"/{redirect}")
    if redirect and redirects < MAX_REDIRECTS and can_follow(redirect, request.method):
        await response.aclose()
        return await proxy(request, redirect, redirects + 1)
    return stream_response(response, str(redirect) if redirect else None)


async def send_upstream(
    request: Request,
    target: httpx.URL,
    forward_authorization: bool,
) -> httpx.Response:
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in REQUEST_HEADERS_TO_DROP
    }
    if not forward_authorization:
        headers.pop("authorization", None)
    content = request.stream() if request.method not in {"GET", "HEAD"} else None
    upstream = request.app.state.client.build_request(request.method, target, headers=headers, content=content)
    return await request.app.state.client.send(upstream, stream=True)


def parse_redirect(location: str, base: str) -> httpx.URL | None:
    return parse_target(urljoin(base, location))


def stream_response(response: httpx.Response, location: str | None) -> StreamingResponse:
    headers = dict(response.headers)
    if location:
        headers["location"] = location
    for header in RESPONSE_HEADERS_TO_DROP:
        headers.pop(header, None)
    headers.update({
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "*",
    })
    return StreamingResponse(
        response.aiter_raw(CHUNK_SIZE),
        status_code=response.status_code,
        headers=headers,
        background=BackgroundTask(response.aclose),
    )


def is_preflight(request: Request) -> bool:
    return request.method == "OPTIONS" and "access-control-request-headers" in request.headers


def preflight(request: Request) -> Response:
    return Response(status_code=204, headers={
        "access-control-allow-origin": "*",
        "access-control-allow-methods": ",".join(METHODS),
        "access-control-allow-headers": request.headers.get("access-control-request-headers", "*"),
        "access-control-max-age": "1728000",
    })


def perl_rewrite(origin: str) -> PlainTextResponse:
    script = "; ".join([
        rf's#(bash.*?\.sh)([^/\w\d])#\1 | perl -pe "\$(curl -L {origin}/perl-pe-para)" \2#g',
        r"s# (git)# https://\1#g",
        rf"s#(http.*?git[^/]*?/)#{origin}/\1#g",
    ])
    return PlainTextResponse(script, headers={"cache-control": "max-age=300"})
