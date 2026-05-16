# 高性能 GitHub 代理服务 (gh-proxy)

一个纯粹、极简且高并发的 GitHub 资源加速代理服务。移除了所有通用化复杂配置，专注于提供稳定、安全的代码拉取及项目文件加速服务。

## ✨ 核心特性

* **多源站点支持**：不仅支持 GitHub（包含 `raw`、`gist`、`api`），还横向扩展支持了 `git.io` 与 `gitlab.com` 的代理转发。
* **双版本架构**：提供基于现代 ES Module 语法的 Cloudflare Workers 版本，以及基于 FastAPI + HTTPX 全异步流式转发的 Python 版本，大幅降低内存占用并提升并发吞吐量。
* **深层嵌套解析**：首创解决 Linux 一键安装脚本内部 `wget/curl` 无法走代理的痛点，支持 Shell 脚本执行时的动态内网穿透（实时下发正则替换脚本内部下载链接）。
* **极高安全防御**：内置严格的域名正则表达式边界过滤，有效防御 SSRF（服务端请求伪造）、ReDoS（正则拒绝服务）、恶意重定向死循环及自我无限嵌套漏洞。

---

## 🚀 使用方法

直接在您要下载的资源 URL 前拼接您的代理服务地址即可。

### 1. 常规文件与 Clone 加速
假设您的代理服务域名为 `https://proxy.example.com/`：

* **分支源码**：`https://proxy.example.com/https://github.com/user/repo/archive/master.zip`
* **Release 文件**：`https://proxy.example.com/https://github.com/user/repo/releases/download/v1.0.0/file.zip`
* **Raw 文件**：`https://proxy.example.com/https://raw.githubusercontent.com/user/repo/master/file.txt`
* **Git Clone**：`git clone https://proxy.example.com/https://github.com/user/repo.git`

### 2. Linux 一键安装脚本加速 (高级功能)
当执行类似 `bash <(curl -L ...)` 的一键安装脚本时，脚本内部通常会去拉取 GitHub 的其他依赖导致二次阻断。本代理支持自动重写脚本内部逻辑，确保全局走代理：

```bash
# 在普通脚本执行命令的 URL 前加上您的代理地址即可，代理会自动处理深层嵌套的下载
bash <(curl -L [https://proxy.example.com/https://raw.githubusercontent.com/user/repo/master/install.sh](https://proxy.example.com/https://raw.githubusercontent.com/user/repo/master/install.sh))

```

---

## 🛠️ 部署指南

### 方式一：Cloudflare Workers 部署 (Serverless)

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **Workers & Pages**。
2. 创建一个新的 Worker。
3. 将项目中的 `index.js` 代码完整复制到编辑器中。
4. 点击 **Save and deploy**（保存并部署）即可获取分配的域名。

### 方式二：Python / Docker 部署 (推荐私有化)

项目剔除了臃肿的 Nginx/uWSGI 方案，提供基于高性能 ASGI 服务器 Uvicorn 的极简镜像构建。

#### 使用 Docker 一键运行：

```bash
# 自动构建并启动异步高性能服务
docker build -t gh-proxy-async .
docker run -d --name gh-proxy -p 80:80 --restart=always gh-proxy-async
```

#### 本地直接运行：

1. 安装现代化依赖：

```bash
pip install fastapi uvicorn httpx
```

2. 启动服务：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 80 --workers 2
```

---

## 📜 版权与致谢

本项目的诞生离不开开源社区的优秀探索：

* 核心路由匹配与基础代理转发逻辑源自 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy) 的优秀开源贡献。
* Shell 脚本深层嵌套解析 (`perl-pe-para`) 以及部分域名支持思路源自 [crazypeace/gh-proxy](https://www.google.com/search?q=https://github.com/crazypeace/gh-proxy)。

本项目在上述先驱者的基础上，进行了**全异步架构现代化重构**、**极端瘦身精简**与**全面安全加固**。基于 MIT 协议分发。
