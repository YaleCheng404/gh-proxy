# 高性能 GitHub 代理服务 (gh-proxy)

一个纯粹、极简且高并发的 GitHub 资源加速代理服务。移除了所有通用化复杂配置，专注于提供稳定、安全的 `clone`、`release`、`archive` 及项目文件加速服务。

## 核心特性
* **双版本支持**：提供基于现代 ES Module 语法的 Cloudflare Workers 版本，以及基于 FastAPI + HTTPX 异步架构的 Python 版本。
* **安全加固**：内置严格的针对 GitHub 域名的正则表达式过滤，有效防御 SSRF（服务器端请求伪造）、恶意重定向循环及滥用风险。
* **极致性能**：Python 版本采用全异步流式转发（StreamingResponse），抛弃了传统的 Nginx+uWSGI 繁重架构，大幅降低内存占用并提升并发吞吐量。

---

## 使用方法

直接在您要下载的 GitHub 资源 URL 前拼接您的代理服务地址即可。

### 示例（假设您的服务域名为 `proxy.example.com`）：
* **分支源码**：`https://proxy.example.com/https://github.com/user/repo/archive/master.zip`
* **Release 文件**：`https://proxy.example.com/https://github.com/user/repo/releases/download/v1.0.0/file.zip`
* **Raw 文件**：`https://proxy.example.com/https://raw.githubusercontent.com/user/repo/master/file.txt`
* **Git Clone**：`git clone https://proxy.example.com/https://github.com/user/repo.git`

---

## 部署指南

### 1. Cloudflare Workers 部署
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 Workers & Pages。
2. 创建一个新的 Worker。
3. 将项目中的 `index.js` 代码完整复制到编辑器中。
4. 点击 **Save and deploy**（保存并部署）即可。

### 2. Python / Docker 部署（推荐）
项目提供了基于高性能 ASGI 服务器 Uvicorn 的轻量化镜像构建方案。

#### 使用 Docker 一键运行：
```bash
# 自动构建并启动异步高性能服务
docker build -t gh-proxy-async .
docker run -d --name gh-proxy -p 80:80 --restart=always gh-proxy-async

```

#### 本地直接运行：

1. 安装依赖：
```bash
pip install fastapi uvicorn httpx

```


2. 启动服务：
```bash
uvicorn app.main:app --host 0.0.0.0 --port 80 --workers 2

```



---

## 版权与致谢

本项目的核心路由匹配与代理转发逻辑源自 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy) 的优秀开源贡献，基于 MIT 协议分发。本项目在其基础上进行了全异步架构现代化重构与安全加固。