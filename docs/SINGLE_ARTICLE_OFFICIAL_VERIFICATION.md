# 单篇下载：本次官方验证地址（2026-10-05）

单篇下载在原文返回验证重定向时仍立即停止。只有本次响应实际返回、通过安全检查的微信官方 `Location`，工具页面才显示“打开本次官方验证”，由用户点击后在新标签页打开。页面同时显示本次待验证文章。按钮不调用下载接口，不自动重试，也不把浏览器验证成功标记为后台下载成功。

现有受挑战文章的脱敏记录只有 HTTP 302 和验证类别，没有保留 `Location`。不能从这些字段恢复真实验证地址；本轮没有再次请求该文章，也没有猜测验证码参数或用微信读书主页代替验证页。因此这次历史失败仍显示地址缺失，不能声称已有可用按钮或真实下载通过。

## 地址与请求的关联

`requestDownloadResource` 从同一次响应读取地址，以不可枚举的私有属性交给 `ArticleDownloadError`。原有 `diagnostic` 字段及日志只包含错误代码、阶段、HTTP 状态和跳转类别。完整地址不进入日志、数据库、设置、浏览器持久化存储或公开文档。

原有受密码保护的回环 `POST /download/article` 在原文阶段 `VERIFICATION_REDIRECT` 错误中返回可选 `verification`：

- 可用：`status: available`、本次 `articleUrl`、实际 `url`、`expiresAt`。
- 不可用：`status: unavailable`、本次 `articleUrl`、`reason`，不携带地址。原因分别为地址缺失、未通过安全检查、包含可能敏感的参数。

控制器再次核对请求文章与响应上下文，并设置 `Cache-Control: private, no-store` 和 `Referrer-Policy: no-referrer`。目录、设置和图片阶段错误不提供验证链接。没有增加公开跳转路由、浏览器凭据读取或账号授权流程。

`packages/shared/src/article-verification.ts` 是无网络、存储或导航的纯函数，供服务端和前端共用。仅允许 HTTPS、精确 `mp.weixin.qq.com` 域名及已知验证路径；拒绝用户信息、非默认端口、片段、未知参数、重复参数和危险编码。嵌套目标必须是相同公众号文章的公开身份。潜在 Cookie、令牌、票据、密钥、签名等参数不交给浏览器。未知官方格式需取得实际响应依据后另行审查，不自动放宽。

前端再次验证地址及文章关联，标签只显示公开文章身份，不显示用户输入的会话参数。原生链接使用 `_blank`、`noopener noreferrer` 和 `no-referrer`。可用地址保留五分钟；到期、修改文章或开始下一操作时移除，点击时也检查到期，防止休眠标签页使用旧地址。五分钟是本工具的展示期限，不代表微信票据有效期或服务端撤销保证。

## 回归与剩余验收

所有新增测试使用虚构文章与响应地址。服务端覆盖实际模拟响应头的传递、仅一次原文请求、不跟随跳转、无成功文件、日志不含地址、HTTP 上下文绑定、敏感或不安全地址不返回。前端五项离线测试检查 API 解析、React 输出、链接属性、缺失地址、过期及休眠后的点击阻止；没有浏览器真实交互或微信请求。CI 增加相同的前端离线步骤。

本地最终回归：服务端 47 套、735 项通过，前端离线 5 项通过；变更文件 ESLint、格式检查、服务端编译、前端类型检查及 Vite 构建通过。先前工具在权限切换时中断的校验不计作通过；恢复后另行运行上述检查。原始错误记录及本地校验输出仅保留在忽略目录，不提交到 Git。

```sh
pnpm --filter server exec jest --runInBand article-download.spec.ts article-download.controller.spec.ts article-verification.spec.ts
node --test scripts/acceptance-article-verification.test.cjs
pnpm --filter server build
pnpm --filter web build
```

用户正常完成官方验证、页面正文和图片实际可读、受支持且已授权的浏览器内容传输，仍是单篇真实保存的独立条件。本轮按钮没有补齐浏览器会话到后台取文的连接。不得复制 Cookie、提取浏览器秘密或绕过工具安全停止；不采用 ZIP 或人工 HTML 导入替代直接保存。

本轮独立分支 `codex/single-article-official-verification` 从已提交 `bbb8d5324e4e965349b1788bcf1b68d11c0205ba` 建立。未修改主工作区、生产数据库、账号/订阅、定时刷新、用户保存目录或原生目录设置，未启动服务、占用 4000 或部署。整合 owner 负责组合构建与部署；代码交付不等于真实验证和下载验收。
