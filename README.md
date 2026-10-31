<div align="center">
<img src="https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/logo.png" width="80" alt="预览"/>

# [WeWe RSS](https://github.com/cooderl/wewe-rss)

更优雅的微信公众号订阅方式。

![主界面](https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/preview1.png)

</div>

## 当前产品边界与证据入口

公众号与小红书标题打开合法原文；平台内正文阅读器已移除。订阅、筛选和指标管理保留，正文图片下载到本地/Obsidian 阅读；ZIP仅为兼容入口。暂停新评论正文与回复采集，保留评论总数字段、历史数据和用户文件。未核验的视频来源不能称为完整归档。

以[产品范围](docs/xiaohongshu/PRODUCT.md)、[交互设计](docs/xiaohongshu/DESIGN.md)、[技术与接口契约](docs/xiaohongshu/TECHNICAL.md)、[验收标准](docs/xiaohongshu/ACCEPTANCE.md)和[开发维护](docs/xiaohongshu/DEVELOPMENT.md)为当前入口。版本与交付状态集中见[本次交付状态](docs/xiaohongshu/DEVELOPMENT.md#本次交付状态2026-10-28)。下列能力描述不代表候选已安装；历史设计不构成来源启用、扩大额度或生产操作授权。

## ✨ 功能

### 🎨 界面与交互

- 支持明暗主题、列表加载反馈和任务状态展示。

### 🔍 搜索与管理

- **文章搜索与列表**：可折叠搜索框、Escape关闭、筛选和响应式列表；具体范围与交互按对应产品文档及浏览器验收核对。
- **侧边栏管理**：支持拖拽排序、批量管理和导出。

### 🚀 跨平台协作增强

- **Obsidian 本地保存**：支持批量保存Markdown和相对媒体附件；完成状态以实际目录回执为准。
- **同步进度**：展示公众号更新和批量任务的进度与结果。
- **本地归档**：正文转换与相对媒体附件供本地/Obsidian 阅读，平台不提供正文阅读器。
- **历史文件迁移**：显式一次性导入已有 CSV/HTML，保留存量资料；不绑定外部目录，也不代表在线历史采集恢复。

### 🛡️ 微信读书与RSS

- **登录与链接**：保留扫码登录和公众号链接处理能力；登录成功不等于列表、正文或图片接口可用。
- **正文导出**：在线获取受所选来源、微信验证及接口状态限制；已有本地HTML可用于离线导出。来源恢复须有对应实测，不以候选实现或旧说明宣称已恢复。
- **RSS输出**：支持 `.atom`、`.rss`、`.json`。
- **所有订阅源一键导出**：支持导出全量订阅源为 OPML 格式。

### 高级功能

- **标题过滤**：支持通过`/feeds/all.(json|rss|atom)`接口和`/feeds/:feed`对标题进行过滤

  ```
  {{ORIGIN_URL}}/feeds/all.atom?title_include=张三
  {{ORIGIN_URL}}/feeds/MP_WXS_123.json?limit=30&title_include=张三|李四|王五&title_exclude=张三丰|赵六
  ```

  ```
  {{ORIGIN_URL}}/feeds/MP_WXS_123.rss?update=true
  ```

## 🛠️ 开发与检查

根目录`package.json`提供`pnpm lint`、`pnpm fmt.check`等命令，工作流按实际分支和事件触发，不保证覆盖所有PR。检查最终SHA的具体job结果；CI通过不等于已部署或真实来源可用。开发入门见[DEVELOPMENT.md](./DEVELOPMENT.md)，本轮受影响测试及发布顺序见[开发维护](docs/xiaohongshu/DEVELOPMENT.md)。来源诊断脚本不因列在package.json中就获得联网执行授权。

## 🚀 部署

### 一键部署

- [Deploy on Zeabur](https://zeabur.com/templates/DI9BBD)
- [Railway](https://railway.app/)
- [Hugging Face部署参考](https://github.com/cooderl/wewe-rss/issues/32)

### Docker Compose 部署

参考 [docker-compose.yml](https://github.com/cooderl/wewe-rss/blob/main/docker-compose.yml) 和 [docker-compose.sqlite.yml](https://github.com/cooderl/wewe-rss/blob/main/docker-compose.sqlite.yml)

### Docker 与本地部署

使用与所选代码版本一致的部署模板和构建入口。数据库连接与接口认证值由部署者在本机私有配置中设置；本文不提供已填写的密码、认证码或连接串，也没有默认可用的外部中转地址。

仅在全新隔离环境按模板配置数据库类型、生成匹配的Prisma client、应用所需迁移，再构建并启动。现有实例升级遵循[发布与恢复说明](docs/xiaohongshu/DEVELOPMENT.md)，核对恢复点、源码/构建/迁移配对，不直接删除schema目录或覆盖运行配置。开发启动与生产安装分开，不因示例命令而恢复来源请求。

## ⚙️ 环境变量

| 变量名                   | 说明                                                                    | 默认值                      |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------- |
| `DATABASE_URL` | 数据库连接，由部署者通过私有配置提供；不在公共文档填写连接值 | 无公共值 |
| `DATABASE_TYPE`          | 数据库类型，使用 SQLite 时需填写 `sqlite`                               | -                           |
| `AUTH_CODE`              | 服务端接口请求授权码，空字符或不设置将不启用 (`/feeds`路径不需要)       | -                           |
| `SERVER_ORIGIN_URL`      | 服务端访问地址，用于生成RSS完整路径                                     | -                           |
| `MAX_REQUEST_PER_MINUTE` | 每分钟最大请求次数                                                      | 60                          |
| `FEED_MODE`              | 输出模式，可选值 `fulltext` (会使接口响应变慢，占用更多内存)            | -                           |
| `CRON_EXPRESSION`        | 定时更新订阅源Cron表达式                                                | `35 5,17 * * *`             |
| `UPDATE_DELAY_TIME`      | 连续更新延迟时间，减少被关小黑屋                                        | `60s`                       |
| `ENABLE_CLEAN_HTML`      | 是否开启正文html清理                                                    | `false`                     |
| `PLATFORM_URL` | 可选基础服务地址，依所选部署方式单独配置；不提供外部默认端点 | 无公共值 |


## 🔔 钉钉通知

进入 wewe-rss-dingtalk 目录按照 README.md 指引部署

## 📱 使用方式

1. 进入账号管理，点击添加账号，微信扫码登录微信读书账号。

   **注意不要勾选24小时后自动退出**

   <img width="400" src="./assets/preview2.png"/>

2. 进入公众号源，点击添加，通过提交微信公众号分享链接，订阅微信公众号。
   来源拒绝或要求验证时停止，按实际状态处理；不承诺固定等待时间后恢复。

   <img width="400" src="./assets/preview3.png"/>

## 🔑 账号状态说明

| 状态       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 今日小黑屋 | 来源访问受限；核对实际错误与授权，不以重启清记录证明限制解除 |
| 禁用       | 不使用该账号                                                        |
| 失效       | 账号登录状态失效，需要重新登录                                      |

## 💻 本地开发

1. 安装 nodejs 20 和 pnpm
2. 修改环境变量：
   ```
   cp ./apps/web/.env.local.example ./apps/web/.env
   cp ./apps/server/.env.local.example ./apps/server/.env
   ```
3. 执行 `pnpm install && pnpm run build:web && pnpm dev`

   ⚠️ **注意：此命令仅用于本地开发，不要用于部署！**

4. 前端访问 `http://localhost:5173`，后端访问 `http://localhost:4000`

## ⚠️ 风险声明

外部来源的可用性和数据处理方式依所选部署与服务而定；本项目不替外部服务保证可用或不留存数据。凭据仅保存在获准私有配置中，遇认证、权限、验证或未知派发结果时停止，不自动换端点或重放。

## 📄 License

[MIT](https://raw.githubusercontent.com/cooderl/wewe-rss/main/LICENSE) @cooderl

### 自动更新与缓存恢复

定时轮次动态覆盖全部启用的中转订阅，已有完整文章跳过，新增走受保护的差量保存。单号本地失败不会拖停其他订阅；鉴权、风控及未知提交仍停止。已受理任务可按[本地缓存恢复说明](docs/AUTO_REFRESH_RECOVERY_20261012.md)零外部请求续接，未受理项保持未发送，媒体补齐单独处理。

## 本机文章保存与周期导出（2026-10-13）

同目录完整文章在媒体准备前跳过，缺图按回执补齐并保留原正文；界面区分新增、跳过、补齐、失败。全周期操作使用“导出当前筛选全部”，ZIP独立区分整号与当前筛选快照。产品行为、回执保护、取消边界与离线验收见[导出说明](docs/INCREMENTAL_ARTICLE_EXPORT.md)。

### 测试与备份空间

离线演练默认使用小合成数据库，真实副本需显式 `--real-copy`。生成前检查空间、总字节与副本数量；超限停止且不会自动删除生产恢复点。输出根、预算、生命周期和恢复点规则见 [空间防护说明](docs/SPACE_GUARD.md)。
