import re
from typing import AsyncIterator
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, RedirectResponse, StreamingResponse

app = FastAPI()

MAX_REDIRECTS = 3
CHUNK_SIZE = 65536
HEALTH_TEXT = "GitHub Proxy is running securely."
FORBIDDEN_TEXT = "Forbidden: Invalid resource target."
ALLOWED_METHODS = "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS"

OWNER_REPO_PATH = r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
ALLOWED_TARGETS = (
    ({"github.com"}, re.compile(rf"^/{OWNER_REPO_PATH}/(?:releases|archive|blob|raw|info|git-|tags)(?:/|$)", re.I)),
    ({"raw.githubusercontent.com", "raw.github.com"}, re.compile(rf"^/{OWNER_REPO_PATH}/.+", re.I)),
    ({"gist.githubusercontent.com", "gist.github.com"}, re.compile(r"^/[A-Za-z0-9_.-]+/.+", re.I)),
    ({"api.github.com", "git.io", "gitlab.com"}, re.compile(r"^/.+", re.I)),
)
FOLLOW_REDIRECT_HOSTS = {
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
}
STRIPPED_REQUEST_HEADERS = {
    "connection",
    "host",
    "origin",
    "referer",
    "transfer-encoding",
    "upgrade",
}
STRIPPED_RESPONSE_HEADERS = {
    "clear-site-data",
    "content-security-policy",
    "content-security-policy-report-only",
    "transfer-encoding",
}

CLIENT = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=200, max_connections=1000),
    timeout=httpx.Timeout(15.0, read=60.0),
    follow_redirects=False,
)


@app.get("/")
async def index(q: str | None = None):
    if q:
        return RedirectResponse(f"/{q}", status_code=301)
    return PlainTextResponse(HEALTH_TEXT)


@app.route("/{raw_target:path}", methods=["GET", "POST", "PUT", "PATCH", "TRACE", "DELETE", "HEAD", "OPTIONS"])
async def handler(request: Request, raw_target: str):
    if is_preflight(request):
        return preflight_response(request)

    target = strip_nested_proxy(raw_target, str(request.base_url))
    if not target:
        return PlainTextResponse(HEALTH_TEXT)

    if target == "perl-pe-para":
        return perl_rewrite_response(str(request.base_url).rstrip("/"))

    target_url = normalize_target(target, request.url.query)
    if not target_url or not is_allowed_target(target_url):
        return PlainTextResponse(FORBIDDEN_TEXT, status_code=403)

    if target_url.host == "github.com":
        target_url = target_url.copy_with(path=target_url.path.replace("/blob/", "/raw/", 1))

    try:
        return await proxy(request, target_url)
    except httpx.RequestError:
        return PlainTextResponse("Bad Gateway: Target server error or timeout.", status_code=502)


def strip_nested_proxy(target: str, base_url: str) -> str:
    while target.startswith(base_url):
        target = target[len(base_url):]
    return target


def normalize_target(raw_target: str, query: str) -> httpx.URL | None:
    target = raw_target.strip()
    target = re.sub(r"^https?:/(?!/)", lambda match: f"{match.group(0)}/", target, count=1, flags=re.I)

    if target.startswith("git"):
        target = f"https://{target}"
    elif not re.match(r"^https?://", target, re.I):
        target = f"https://{target}"
    if query and "?" not in target:
        target = f"{target}?{query}"

    try:
        url = httpx.URL(target)
    except httpx.InvalidURL:
        return None

    return url if url.scheme in {"http", "https"} else None


def is_allowed_target(url: httpx.URL) -> bool:
    if not url.host:
        return False

    host = url.host.lower()
    return any(host in hosts and path.match(url.path) for hosts, path in ALLOWED_TARGETS)


def can_follow_redirect(url: httpx.URL, method: str) -> bool:
    return method in {"GET", "HEAD"} and (
        is_allowed_target(url) or url.host.lower() in FOLLOW_REDIRECT_HOSTS
    )


async def proxy(request: Request, target_url: httpx.URL):
    response = await send_upstream(request, target_url)
    redirect_count = 0

    while response.is_redirect and redirect_count < MAX_REDIRECTS:
        location = response.headers.get("location")
        redirect_url = parse_redirect(location, str(target_url)) if location else None

        if not redirect_url or not can_follow_redirect(redirect_url, request.method):
            break

        await response.aclose()
        target_url = redirect_url
        response = await send_upstream(request, target_url)
        redirect_count += 1

    return stream_response(response, target_url)


async def send_upstream(request: Request, target_url: httpx.URL) -> httpx.Response:
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in STRIPPED_REQUEST_HEADERS
    }
    content = request.stream() if request.method not in {"GET", "HEAD"} else None
    upstream_request = CLIENT.build_request(request.method, target_url, headers=headers, content=content)
    return await CLIENT.send(upstream_request, stream=True)


def parse_redirect(location: str, base_url: str) -> httpx.URL | None:
    try:
        return httpx.URL(urljoin(base_url, location))
    except httpx.InvalidURL:
        return None


def stream_response(response: httpx.Response, request_url: httpx.URL) -> StreamingResponse:
    headers = dict(response.headers)
    location = headers.get("location")

    if location:
        redirect_url = parse_redirect(location, str(request_url))
        if redirect_url and is_allowed_target(redirect_url):
            headers["location"] = f"/{redirect_url}"
        elif redirect_url:
            headers["location"] = str(redirect_url)

    headers["access-control-expose-headers"] = "*"
    headers["access-control-allow-origin"] = "*"
    for header in STRIPPED_RESPONSE_HEADERS:
        headers.pop(header, None)

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes(CHUNK_SIZE):
                yield chunk
        finally:
            await response.aclose()

    return StreamingResponse(body(), status_code=response.status_code, headers=headers)


def is_preflight(request: Request) -> bool:
    return request.method == "OPTIONS" and "access-control-request-headers" in request.headers


def preflight_response(request: Request) -> PlainTextResponse:
    requested_headers = request.headers.get("access-control-request-headers", "*")
    return PlainTextResponse(
        "",
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": ALLOWED_METHODS,
            "Access-Control-Allow-Headers": requested_headers,
            "Access-Control-Max-Age": "1728000",
        },
    )


def perl_rewrite_response(origin: str) -> PlainTextResponse:
    script = "; ".join(
        [
            rf's#(bash.*?\.sh)([^/\w\d])#\1 | perl -pe "\$(curl -L {origin}/perl-pe-para)" \2#g',
            r"s# (git)# https://\1#g",
            rf"s#(http.*?git[^/]*?/)#{origin}/\1#g",
        ]
    )
    return PlainTextResponse(script, headers={"Cache-Control": "max-age=300"})
