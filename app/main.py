import re
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, RedirectResponse, PlainTextResponse

app = FastAPI()

# 终极安全正则：严格锚定域名边界，拒绝 SSRF 与 ReDoS 攻击
VALID_PATTERN = re.compile(
    r'^(?:https?://)?('
    r'github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/(?:releases|archive|blob|raw|info|git-|tags)[^ ]*|'
    r'raw\.(?:githubusercontent|github)\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/[^ ]+|'
    r'gist\.(?:githubusercontent|github)\.com/[a-zA-Z0-9_.-]+/[^ ]+|'
    r'api\.github\.com/[^ ]+|'
    r'git\.io/[^ ]+|'
    r'gitlab\.com/[^ ]+'
    r')$',
    re.IGNORECASE
)

# 生产级连接池配置：防止被海量小文件请求击穿
CLIENT = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=200, max_connections=1000),
    timeout=httpx.Timeout(15.0, read=60.0),
    follow_redirects=False 
)
CHUNK_SIZE = 65536

@app.get("/")
async def index(q: str = None):
    if q:
        return RedirectResponse(f"/{q}")
    return PlainTextResponse("GitHub Proxy is running securely.")

@app.route("/{u:path}", methods=["GET", "POST", "OPTIONS"])
async def handler(request: Request, u: str):
    # 1. 深度防自循环嵌套：自动剔除恶意或错误的多重代理前缀
    base_url = str(request.base_url)
    while u.startswith(base_url):
        u = u[len(base_url):]

    # 2. Shell脚本内网穿透：动态生成替换命令，拦截深层调用
    if u == 'perl-pe-para':
        origin = base_url.rstrip('/')
        response_text = (
            f's#(bash.*?\\.sh)([^/\\w\\d])#\\1 | perl -pe "\\$(curl -L {origin}/perl-pe-para)" \\2#g; '
            f's# (git)# https://\\1#g; '
            f's#(http.*?git[^/]*?/)#{origin}/\\1#g'
        )
        return PlainTextResponse(response_text, headers={"Cache-Control": "max-age=300"})

    # 3. 协议头自我修复
    if u.startswith("git"):
        u = "https://" + u
    elif not u.startswith("http"):
        u = "https://" + u
    u = u.replace("s:/", "s://", 1)

    if not VALID_PATTERN.match(u):
        return PlainTextResponse("Forbidden: Invalid resource target.", status_code=403)

    u = u.replace("/blob/", "/raw/", 1)
    
    # 剔除危险的透传头
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ["host", "origin", "referer", "connection", "accept-encoding"]}

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

        # 重定向追踪与熔断 (最大3次)
        redirect_count = 0
        while resp.is_redirect and redirect_count < 3:
            location = resp.headers.get("location")
            if not location or not VALID_PATTERN.match(location):
                break
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
                # 无论客户端正常下载完毕还是强制掐断，确保连接池资源被释放
                await resp.aclose()

        return StreamingResponse(generate(), status_code=resp.status_code, headers=resp_headers)

    except httpx.RequestError:
        return PlainTextResponse("Bad Gateway: Target server error or timeout.", status_code=502)