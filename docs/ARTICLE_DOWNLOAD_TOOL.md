# 工具 → 文章下载

## 使用

在导航中打开「工具」，粘贴单篇 `https://mp.weixin.qq.com/s/...` 短链接，或含 `__biz`、`mid`、`idx`、`sn` 的公众号文章长链接，点击「下载正文和图片」。成功后点击「保存下载文件」，解压 ZIP，打开 `index.html` 即可离线阅读。

ZIP 同时包含 `index.md` 和 `attachments/` 图片文件，保留原文来源。移动或收藏时保留整个解压目录，避免单独移动 HTML 后丢失图片。

工具独立于订阅，不添加公众号，不改变文章库、订阅更新状态或账号配置。只处理一篇公开图文；不支持批量、音视频、登录或验证码操作。遇到不可访问、验证页、身份不一致或任一图片失败时，不提供成功下载文件，可查看页面错误提示。

## 开发与交接

- 页面：`apps/web/src/pages/tools/article-download.tsx`；路由 `/dash/tools` 和 `/dash/tools/article-download`。
- 接口：`POST /download/article`，JSON `{ "url": "..." }`；成功返回 ZIP，错误返回中文 JSON `message`。接口复用现有访问密码或私人站点会话。
- `article-export.ts` 是从 `TrpcRouter.getArticleMarkdown` / `downloadImage` 抽出的既有正文与图片导出代码。原 Markdown、Obsidian 和公众号 ZIP 仍调用相同方法；默认图片下载逻辑不变。
- `offline-archive.ts` 抽出原 `OfflineExportController` 的 ZIP 打包代码，公众号 ZIP 与工具共用。
- `article-download.ts` 只连接单篇 URL 与上述导出方法，复用 `articleIdentity`、`articleContentHtml`、`publicArticleRequestUrl`、`allowedImageUrl`、`decodeInlineImage`。离线 HTML 使用导出方法已本地化的同一正文。
- 无数据库依赖。每次请求使用系统临时目录；响应完成或失败后清理。前端用 Blob 提供保存按钮，切换输入或离开页面时释放 Blob。

安全边界：只接受 HTTPS 微信文章 URL；只保留文章身份和内容签名参数；不传递微信 Cookie、账号令牌或用户输入的会话参数。文章与图片均禁止自动重定向、代理和重试，网络连接时校验并固定 DNS 地址，拒绝内网及保留地址。正文上限 5 MB，图片最多 60 张、单张 10 MB、总计 20 MB，复用已有图片容器校验。清除执行型 HTML、正文外链与动态属性，离线 HTML 使用限制性 CSP。现有 `WEWE_ACCEPTANCE_MODE=1` 会阻止工具网络下载。

一次只允许一个工具下载请求；并行请求返回 409。工具不调用订阅 Provider、微信读书账号、生产 SQLite 或 Obsidian 配置目录。暂无真实文章下载验收；须由用户提供具体文章链接后另行验证，不把合成测试通过称为真实平台能力恢复。

## 构建与离线回归

沿用项目锁文件、已有依赖和构建命令，无新增项目依赖。本轮执行环境为 Node.js 24.11.1。

```sh
pnpm install --frozen-lockfile
pnpm --filter server build
pnpm --filter web build
pnpm --filter server exec jest --runInBand article-download.spec.ts article-download.controller.spec.ts collection/article-page.spec.ts collection/image-fetch.spec.ts collection/archive-provider-images.spec.ts
```

测试只使用合成正文和 1×1 PNG，在系统临时目录运行；覆盖正文/图片文件、长短链接、身份校验、非法 URL、验证失败、危险 HTML、坏图片、内网 DNS、访问控制、并行请求、临时文件清理，以及原订阅导出行为。Jest 29 无法加载 archiver 8 的原生 ESM，因此 HTTP 单测仅替代 ZIP 打包边界；下面浏览器验收执行真实打包和解压。

本地浏览器回归使用现有 Playwright 安装，或在独立临时目录安装固定版本 `playwright-core@1.58.2`，不修改项目依赖。设置 `PLAYWRIGHT_MODULE_PATH` 为该模块目录；如没有 Playwright 浏览器，可用 `BROWSER_EXECUTABLE` 指定本机 Edge 可执行文件。

```sh
node scripts/acceptance-article-download.cjs
```

该脚本启动仅含工具控制器的临时本地服务和无账号浏览器，正文/图片资源由内存合成 fixture 提供，阻止真实上游与浏览器外网请求，不启动生产应用、不加载生产配置或数据库。验证独立导航、非法链接、连续点击、成功保存 ZIP、真实解压、断网打开 HTML 和图片、验证失败与图片失败提示、移动端入口。合成截图及结果写入已忽略的 `output/playwright/article-download/`，不提交原始证据或下载文件。

## 本轮结果（2026-10-04）

- 服务端全量回归：36 个测试套件、466 项测试全部通过，其中相关导出／图片／工具测试 58 项通过。
- 前后端构建通过；改动文件格式检查、服务端和前端 ESLint 检查通过。
- 浏览器合成验收通过：真正生成并下载 ZIP，解压后断网打开正文和本地 PNG；非法 URL 不调用接口取文，连续点击只发起一个工具下载，验证／图片失败不提供保存按钮，移动端可进入工具页。
- 真实微信平台请求 0，数据库使用 0，生产启动／部署 0。测试结果不代表真实公开文章访问已成功；真实链接验收仍待用户提供具体链接。
- 独立分支 `codex/article-download-tool` 从 `155503b` 创建。订阅刷新模块由主线线程管理，本分支不改 Provider、账号会话或共享任务交接文档，产品和开发说明集中在本页，供父会话统一集成。
