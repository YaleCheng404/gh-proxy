# gh-proxy

GitHub 资源代理，支持 Cloudflare Workers 和 FastAPI/Docker 部署。打开首页粘贴链接即可下载，也可以在资源 URL 前加上代理地址：

```text
https://proxy.example.com/https://github.com/user/repo/archive/main.zip
https://proxy.example.com/https://raw.githubusercontent.com/user/repo/main/file.txt
```

```bash
git clone https://proxy.example.com/https://github.com/user/repo.git
```

## 支持范围

- GitHub Release、源码压缩包、单个文件、tags 和 Git smart HTTP。
- `raw.githubusercontent.com`、`raw.github.com`、`gist.githubusercontent.com`、`gist.github.com`。
- `api.github.com`、`git.io`、`gitlab.com`、`gitlab.net`、`*.github.io`、`*.gitlab.io`。

链接可以省略协议头，HTTP 自动升级为 HTTPS，GitHub `/blob/` 自动改写为 `/raw/`。不支持直接下载项目文件夹；其它主机、非标准 HTTPS 端口和不匹配的 GitHub 路径返回 `403`。

首页支持 `/?q=<资源链接>`；`/healthz` 提供健康检查，`/perl-pe-para` 提供安装脚本的 Perl 重写规则。

## Cloudflare Workers

使用 Node.js 24 LTS 和 npm 12，在仓库根目录运行：

```bash
npm ci
npm run dev
```

部署：

```bash
npm run check
npm run deploy
```

`check` 仅执行打包检查。首页及图标由 Workers Static Assets 部署，无需配置外部静态站点。

## Python / Docker

推荐 Python 3.14。在仓库根目录创建并激活虚拟环境：

```bash
python -m venv .venv
```

Windows PowerShell 使用 `.venv\Scripts\Activate.ps1`，Linux/macOS 使用 `source .venv/bin/activate`。然后运行：

```bash
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Docker：

```bash
docker build -t gh-proxy .
docker run -d --name gh-proxy -p 80:80 --restart=always gh-proxy
```

## 限制

- 每 IP 每分钟 10 次，每个进程或 Worker 实例每秒共 5 次代理请求，超限返回 `429`。计数存于内存，多进程或多实例之间不共享；首页、静态资源和健康检查不计数。
- 请求或上游响应声明的 `Content-Length` 超过 100 MiB 时返回 `413`。未声明或无效的长度不触发此检查，流式传输不会累计检查总字节数。
- 最多在服务端跟随 3 次 GitHub 官方下载域名重定向；白名单资源重定向会改写为代理链接，其它地址交由客户端处理。
- 首次上游请求保留 `Authorization`，服务端跟随下载重定向时移除。Cookie、代理认证和客户端转发头不会传给上游。

## 测试

```bash
npm test
npm run check
python -m unittest discover -s tests -p "test_*.py"
python -m pip check
```

[MIT License](LICENSE)
