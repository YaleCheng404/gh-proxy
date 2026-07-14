# gh-proxy

一个小型 GitHub 资源代理，提供 Cloudflare Workers 与 FastAPI 两种实现。两端使用相同的目标白名单、HTTPS 升级、有限重定向和流式响应策略。

## 支持范围

- `github.com/<owner>/<repo>/releases|archive|blob|raw|info|git-|tags`
- `raw.githubusercontent.com`、`raw.github.com`
- `gist.githubusercontent.com`、`gist.github.com`
- `api.github.com`、`git.io`、`gitlab.com`
- GitHub 官方下载重定向域名（最多跟随 3 次）

其它主机、非标准 HTTPS 端口和不匹配的 GitHub 路径会返回 `403`。首次上游请求保留 `Authorization`；跨主机下载重定向会移除它，并始终移除 `Proxy-Authorization`、Cookie、客户端 IP、转发链和逐跳头部。

## 使用

把资源 URL 放到代理地址后：

```text
https://proxy.example.com/https://github.com/user/repo/archive/main.zip
https://proxy.example.com/https://raw.githubusercontent.com/user/repo/main/file.txt
git clone https://proxy.example.com/https://github.com/user/repo.git
```

GitHub 的 `/blob/` 路径会自动改写为 `/raw/`。`/perl-pe-para` 保留了嵌套安装脚本的 Perl 重写规则。

## Cloudflare Workers

要求 Node.js 20 或更高版本：

```bash
npm install
npm test
npm run check
npm run deploy
```

`wrangler.jsonc` 使用当前兼容日期、`nodejs_compat` 和结构化日志观测配置。`npm run check` 只做 Wrangler dry-run，不会部署。

## Python / Docker

本地运行：

```bash
python -m venv .venv
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 80 --workers 2
```

Docker：

```bash
docker build -t gh-proxy .
docker run -d --name gh-proxy -p 80:80 --restart=always gh-proxy
```

Python 实现使用 HTTPX 的原始字节流和 Starlette `BackgroundTask` 关闭上游响应，避免缓存大文件或错误解压响应体。

## 测试

测试只使用 Node.js 与 Python 标准库，不引入额外测试框架：

```bash
npm test
python -m unittest discover -s tests -p "test_*.py"
```

## 固定依赖

| 组件 | 版本 | 来源 |
| --- | ---: | --- |
| Python | 3.14.6 | [python.org](https://www.python.org/downloads/) |
| FastAPI | 0.139.0 | [PyPI](https://pypi.org/project/fastapi/) |
| Uvicorn | 0.51.0 | [PyPI](https://pypi.org/project/uvicorn/) |
| HTTPX | 0.28.1 | [PyPI](https://pypi.org/project/httpx/) |
| Wrangler | 4.110.0 | [npm](https://www.npmjs.com/package/wrangler) |
| pip（镜像构建） | 26.1.2 | [PyPI](https://pypi.org/project/pip/) |

Python 的直接与解析依赖、基础镜像补丁版本均已固定；npm 的完整解析结果由 `package-lock.json` 保存。

## 致谢

核心代理思路来自 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy)；`perl-pe-para` 与扩展域名思路来自 [crazypeace/gh-proxy](https://github.com/crazypeace/gh-proxy)。当前实现保留这些成熟方案的行为，并缩小了可代理目标与转发头部范围。

MIT License。
