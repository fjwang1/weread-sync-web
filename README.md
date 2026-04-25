# weread-sync-web

微信读书评论的独立 H5 版本。

目标是复刻 `weread-sync demo` 的浏览体验，并通过 Cloudflare Pages Functions 部署一个无数据库的轻量服务：登录、同步、浏览缓存都在浏览器侧完成。

## 架构

- `public/`：静态 H5 页面、样式、脚本和 favicon
- `functions/api/`：Cloudflare Pages Functions API
- `src/shared/`：前后端同步链路复用的微信读书请求和渲染逻辑

## API

- `POST /api/login/start`：生成微信读书登录二维码
- `GET /api/login/poll?uid=...`：等待扫码结果并返回登录凭证
- `POST /api/sync`：实时拉取书籍、划线和书评，返回完整快照，由浏览器缓存
