import re
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, RedirectResponse, PlainTextResponse

app = FastAPI()

# 安全加固：严格限制字符集，防止路径穿越和伪造域名导致的 SSRF 攻击
VALID_PATTERN = re.compile(
    r'^(?:https?://)?('
    r'github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/(?:releases|archive|blob|raw|info|git-|tags).*|'
    r'raw\.(?:githubusercontent|github)\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/.+|'
    r'gist\.(?:githubusercontent|github)\.com/[a-zA-Z0-9_.-]+/.+'
    r')$',
    re.IGNORECASE
)

# 稳定性加固：全局异步客户端配置连接池、复用限制和超时熔断机制
CLIENT = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=100, max_connections=500),
    timeout=httpx.Timeout(10.0, read=60.0),
    follow_redirects=False # 手动安全处理重定向
)
CHUNK_SIZE = 65536

@app.get("/")
async def index(q: str = None):
    if q:
        return RedirectResponse(f"/{q}")
    return PlainTextResponse("GitHub Proxy is running securely.")

@app.route("/{u:path}", methods=["GET", "POST", "OPTIONS"])
async def handler(request: Request, u: str):
    if not u.startswith("http"):
        u = "https://" + u
    u = u.replace("s:/", "s://", 1)

    # 严格校验请求目标的合法性
    if not VALID_PATTERN.match(u):
        return PlainTextResponse("Forbidden: Invalid GitHub resource target.", status_code=403)

    u = u.replace("/blob/", "/raw/", 1)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ["host", "origin", "referer"]}

    if request.method == "OPTIONS":
        return PlainTextResponse("", headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
            "Access-Control-Max-Age": "1728000",
        })

    try:
        body = await request.body()
        req = CLIENT.build_request(request.method, u, headers=headers, content=body)
        resp = await CLIENT.send(req, stream=True)

        # 安全重定向追踪，防止无限循环重定向攻击
        redirect_count = 0
        while resp.is_redirect and redirect_count < 3:
            location = resp.headers.get("location")
            if not location or not VALID_PATTERN.match(location):
                break
            # 释放上一个请求的流连接
            await resp.aclose() 
            req = CLIENT.build_request(request.method, location, headers=headers)
            resp = await CLIENT.send(req, stream=True)
            redirect_count += 1

        resp_headers = dict(resp.headers)
        resp_headers["access-control-expose-headers"] = "*"
        resp_headers["access-control-allow-origin"] = "*"
        for k in ["content-security-policy", "content-security-policy-report-only", "clear-site-data", "transfer-encoding"]:
            resp_headers.pop(k, None)

        async def generate():
            try:
                async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                    yield chunk
            finally:
                await resp.aclose() # 确保异常断开时释放资源

        return StreamingResponse(generate(), status_code=resp.status_code, headers=resp_headers)

    except httpx.RequestError as e:
        return PlainTextResponse(f"Bad Gateway: Target server error or timeout.", status_code=502)