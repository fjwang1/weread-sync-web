# weread-sync-web

微信读书评论的独立 H5 版本。

目标是复刻 `weread-sync demo` 的浏览体验，并通过 Cloudflare Pages Functions 部署一个无数据库的轻量服务：登录、同步、浏览缓存都在浏览器侧完成。

## 架构

- `public/`：静态 H5 页面、样式、脚本和 favicon
- `functions/api/`：Cloudflare Pages Functions API
- `src/shared/`：前后端同步链路复用的微信读书请求和渲染逻辑

Cloudflare Pages 负责托管前端静态资源；Pages Functions 负责执行 `/api/*` 后端接口。浏览器不会直接请求微信读书接口，而是请求同域名下的 `/api/*`，再由 Cloudflare Function 去请求微信读书。

## API

- `POST /api/login/start`：生成微信读书登录二维码
- `GET /api/login/poll?uid=...`：等待扫码结果并返回登录凭证
- `POST /api/books`：实时拉取首页书籍列表，返回封面、标题、作者和笔记数量，由浏览器缓存
- `POST /api/book`：实时拉取单本书详情，返回划线、书评和渲染后的正文，由浏览器按书籍缓存

## 浏览器缓存

IndexedDB 使用以下 key：

- `auth`：微信读书登录凭证
- `booksIndex`：首页书籍列表缓存
- `bookDetail:{bookId}`：单本书详情缓存

默认优先读浏览器缓存，用户点击“更新”时才实时拉取。

## 本地开发

```bash
npm install
npm run dev
```

`npm run dev` 会通过 Wrangler 同时启动前端静态资源和 Pages Functions。

本地访问：

```text
http://127.0.0.1:8788
```

语法检查：

```bash
npm run build
```

## Cloudflare 部署

这个项目应该创建 Cloudflare Pages 项目，不需要手动创建 Worker。

Pages 构建配置：

```text
Framework preset: None
Build command: npm run build
Build output directory: public
Root directory: /
Production branch: main
```

`functions/api/` 会被 Cloudflare Pages 自动识别为 Pages Functions。

## 环境和分支

注意：`*.pages.dev` 域名和绑定的正式域名，如果都指向 production deployment，它们只是同一份部署的两个入口，不是测试/正式两套环境。

推荐分支约定：

- `dev`：测试分支，触发 Cloudflare Preview deployment
- `main`：正式分支，触发 Cloudflare Production deployment

推荐流程：

```bash
git checkout dev
# 修改代码
git push origin dev
# 在 Cloudflare Preview URL 或测试域名验证

git checkout main
git merge dev
git push origin main
# 正式域名更新
```

如果需要自己的测试域名，例如 `d.example.com`，应该把它绑定到 `dev` 分支对应的 preview/branch alias，而不是绑定到 production deployment。
