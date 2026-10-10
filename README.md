<div align="center">
<img src="https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/logo.png" width="80" alt="预览"/>

# [WeWe RSS](https://github.com/cooderl/wewe-rss)

更优雅的微信公众号订阅方式。

![主界面](https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/preview1.png)

</div>

## 本机 Wechat2RSS 配置准备（2026-10-09）

本轮继续准备现有 Wechat2RSS Provider 的本机接入，密钥由用户随后在本机填写。准确文件入口、字段及检查命令见[本机填写与接入检查](docs/WECHAT2RSS_LOCAL_SETUP.md)：实例配置使用已有 `.env.wechat2rss`，WeWe 配置使用已有 `apps/server/.env.local`，保留其他设置，不用模板覆盖私有文件。

小红书按用户选择准备 Rnote Web＋蒲公英源码包及同产品免费测试 Key。独立空目录、私有候选配置和离线检查命令见[本机接入准备](docs/paid-sources/XHS_SOURCE_PREPARATION.md)；真实来源尚未注册，配置格式通过不会启用刷新。

填写后可在项目根目录执行 `node scripts/acceptance-wechat2rss.cjs --deployment-config`，仅核两端配置一致性，不启动、联网、启用来源或写库。需要与源码对应的后台构建；不能与 `--execute` 混用。来源启用、目标绑定和受控部署另行处理，授权、正常登录、最新十篇完整正文与实际图片、原刷新去重仍待真实验收。下面的历史方向与配置说明保留供追溯，当前填写操作以新指南为准。

## 当前方向与验收（2026-10-04）

微信读书自建模块已接回原手动刷新。妈妈部落畅聊阁最新10篇真实正文及图片已保存，原入口重复刷新新增0；八篇补齐媒体后1450篇文章、账号、旧ID、时间、文字和指标保留。离线导出保存89个图片附件，真实Edge打开10篇及97处图片引用通过。仅本机回环4000，自动刷新关闭；其他11订阅、未来自然新文及用户单篇短链直接保存Obsidian仍分别待验收。暂停 Wechat2RSS 采购，运行时不依赖闭源中转。准确版本与验收边界见[验收记录](docs/LATEST_TEN_IMAGE_ACCEPTANCE.md)、[交付任务](docs/PRIVATE_ONLINE_DELIVERY_TASK.md)和[精简交接](docs/DEVELOPMENT_HANDOFF.md)。

## 历史方案：公众号订阅恢复实施状态

> 以下 Wechat2RSS 配置、授权与部署说明是前轮记录，现已暂停，不作为当前操作步骤。

前轮曾按[当时的实施任务书](docs/SUBSCRIPTION_IMPLEMENTATION_TASK.md)推进，Wechat2RSS 私有实例当时是第一候选；已有的 RSS、Markdown、Obsidian、SQLite 与按号批量导出继续由本项目负责。

代码已增加显式 Provider 路由和默认关闭的 Wechat2RSS 接线；本机尚无授权实例，目标公众号五篇、正文、图片、持续新文和订阅前历史均未真实验证。生产库仍是只读核对的 12 号、1447 篇，本轮不修改生产数据。模拟测试或构建通过不表示订阅已恢复。

本机服务在 `apps/server/.env.local` 填写 `WECHAT2RSS_ENABLED=1`、`WECHAT2RSS_BASE_URL`、`WECHAT2RSS_TOKEN`，并用 `WECHAT2RSS_FEED_IDS` 逐号放行已有订阅。密钥不进入 Git。私有实例可参照独立的 `docker-compose.wechat2rss.yml`；授权、Docker、本人扫码齐备后才启动。实例图片代理在模板中关闭，使正文使用原始微信图片地址；真实附件仍须单篇核验。定时仍需显式启用，并先通过 SQLite 副本和备份验收。

Wechat2RSS 官方文档说明只抓当时最新 20 篇、只收录群发消息；本地旧文章不会因此删除。订阅前未被上游抓到的历史和非群发内容是独立能力缺口，不以近期订阅通过代替全历史完成。

独立部署模板使用 [官方部署指南](https://wechat2rss.xlab.app/deploy/deploy)中的 `ttttmr/wechat2rss` 镜像，固定到 2026-09-29 从 [Docker Hub 标签接口](https://hub.docker.com/v2/repositories/ttttmr/wechat2rss/tags/latest)核对的 digest `sha256:000c3243ebdc5d7edc30cb00e52981b600f02d11f85fefcec27e2226c208082f`。模板仅绑定本机 `127.0.0.1:18080`，使用独立的忽略目录持久化；`RSS_KEEP_OLD_COUNT=-1` 只保留以后已抓到的文章，不补订阅前缺口。用户完成授权与本人登录后，可用 `node --env-file=apps/server/.env.local scripts/acceptance-wechat2rss.cjs --execute MP_WXS_<数字ID>` 做获准后的受控只读字段探测；默认无参数模式只核 WeWe 配置格式，`--deployment-config` 则离线核对实例与 WeWe 两端配置一致性，不能与 `--execute` 混用。

## ✨ 功能

### 🎨 极致视觉与交互

- **macOS 原生品质体验**：深度参考 macOS 系统设计语言，全站采用 Glassmorphism 玻璃拟态效果，搭配 SF Pro 系统字体，提供极具品质感的视觉反馈。
- **智能动态交互**：引入骨架屏加载动画与丝滑交互动效，确保从加载到阅读的每一个环节都流畅自然。
- **自适应系统主题**：完美适配深色模式，色彩配比经过精心调优，缓解长时间阅读的视觉疲劳。

### 🔍 智慧搜索与管理

- **集成式文章搜索**：顶部工具栏内置可折叠搜索框，支持键盘快捷键 (ESC) 快速关闭，在大规模订阅源中也能瞬间定位目标内容。
- **多维文章列表**：采用响应式百分比布局 (50/25/15/10 黄金比例)，彻底解决小屏幕下的文字截断问题，信息呈现错落有致。
- **侧边栏极简高效**：支持鼠标拖拽自由排序，内置批量管理模式，支持一键清空或导出。

### 🚀 跨平台协作增强

- **Obsidian 深度联动**：增强版导出功能，支持批量将文章一键保存至 Obsidian，自动处理图片本地化，补全知识管理闭环。
- **同步进度可视化**：实时反馈公众号更新状态，批量同步进度与结果一目了然。
- **阅读体验智能优化**：内置正文 HTML 自动清理与排版引擎，还原最清爽的阅读感受。
- **历史文件迁移**：显式一次性导入已有 CSV/HTML，保留存量资料；不绑定外部目录，也不代表在线历史采集恢复。

### 🛡️ 微信读书原生直连架构与文章同步升级

- **彻底告别外部代理（解耦 502 问题）**：移除旧版依赖已离线的外部中转平台（`weread.111965.xyz`），直接对接微信读书官方 Native 扫码网关，实现全本地化无中转直连。
- **官方 Native 扫码登录**：基于微信读书最新 Web 鉴权规范（`/api/auth/getLoginUid` 与 `/api/auth/getLoginInfo`），支持微信扫码在手机端一键确认登录，无需复杂抓包。
- **微信文章短链算法精准还原**：解决微信读书内部字符转写问题（自动剥离 `MP_WXS_` 复合前缀并将 `~` 还原为 `_`），修复生成的公众号短链打开显示“参数错误”的问题。
- **双重全文读取与 Obsidian 导出**：微信直连与微信读书官方 `/web/mp/content` 全文接口双重兜底，在线获取受微信验证和接口状态限制；导入本地 HTML 后优先从本地正文导出。
- **全格式 RSS 支持**：生成标准微信公众号 RSS (支持 `.atom`, `.rss`, `.json` 格式)，完美适配各类阅读器。
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

## 🛠️ 开发者生产力 (Developer Productivity)

为了提升开发效率与工程化质量，项目引入了以下优化方案：

### 🍱 脚本归档与统一

- **统一脚本目录**：将所有运维、检查与测试脚本从根目录迁移至 `scripts/` 目录，保持根目录整洁。
- **标准化命令**：在根目录 `package.json` 中统一封装了常用任务：
  - `pnpm accounts:check`: 快速检查库中账号状态。
  - `pnpm feed:check`: 验证订阅源可用性。
  - `pnpm feed:debug`: 开启详细日志调试特定订阅源。
  - `pnpm lint`: 一键执行全站代码静态检查。

### 🤖 自动化质量门禁

- **持续集成 (CI)**：新增 GitHub Actions 工作流，覆盖所有 Pull Request 的格式化、Lint 与构建检测，确保主干代码稳定性。
- **提交前置检查**：集成 `husky` 与 `lint-staged`，在 `git commit` 时自动触发 Prettier 格式化，强制维持代码风格一致。

### 💅 极致工程化体验

- **CSS 自动规范**：引入 `prettier-plugin-tailwindcss` 插件，自动对 Tailwind CSS 类名进行排序，极大提升样式代码的可读性。
- **开发指南**：新增 [DEVELOPMENT.md](./DEVELOPMENT.md) 文档，为新贡献者提供快速上手说明。

## 🚀 部署

### 一键部署

- [Deploy on Zeabur](https://zeabur.com/templates/DI9BBD)
- [Railway](https://railway.app/)
- [Hugging Face部署参考](https://github.com/cooderl/wewe-rss/issues/32)

### Docker Compose 部署

参考 [docker-compose.yml](https://github.com/cooderl/wewe-rss/blob/main/docker-compose.yml) 和 [docker-compose.sqlite.yml](https://github.com/cooderl/wewe-rss/blob/main/docker-compose.sqlite.yml)

### Docker 命令启动

#### MySQL (推荐)

1. 创建docker网络

   ```sh
   docker network create wewe-rss
   ```

2. 启动 MySQL 数据库

   ```sh
   docker run -d \
     --name db \
     -e MYSQL_ROOT_PASSWORD=123456 \
     -e TZ='Asia/Shanghai' \
     -e MYSQL_DATABASE='wewe-rss' \
     -v db_data:/var/lib/mysql \
     --network wewe-rss \
     mysql:8.3.0 --mysql-native-password=ON
   ```

3. 启动 Server
   ```sh
   docker run -d \
     --name wewe-rss \
     -p 4000:4000 \
     -e DATABASE_URL='mysql://root:123456@db:3306/wewe-rss?schema=public&connect_timeout=30&pool_timeout=30&socket_timeout=30' \
     -e AUTH_CODE=123567 \
     --network wewe-rss \
     cooderl/wewe-rss:latest
   ```

[Nginx配置参考](https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/nginx.example.conf)

#### SQLite (不推荐)

```sh
docker run -d \
  --name wewe-rss \
  -p 4000:4000 \
  -e DATABASE_TYPE=sqlite \
  -e AUTH_CODE=123567 \
  -v $(pwd)/data:/app/data \
  cooderl/wewe-rss-sqlite:latest
```

### 本地部署

使用 `pnpm install && pnpm run -r build && pnpm run start:server` 命令 (可配合 pm2 守护进程)

**详细步骤** (SQLite示例)：

```shell
# 需要提前声明环境变量,因为prisma会根据环境变量生成对应的数据库连接
export DATABASE_URL="file:../data/wewe-rss.db"
export DATABASE_TYPE="sqlite"
# 删除mysql相关文件,避免prisma生成mysql连接
rm -rf apps/server/prisma
mv apps/server/prisma-sqlite apps/server/prisma
# 生成prisma client
npx prisma generate --schema apps/server/prisma/schema.prisma
# 生成数据库表
npx prisma migrate deploy --schema apps/server/prisma/schema.prisma
# 构建并运行
pnpm run -r build
pnpm run start:server
```

## ⚙️ 环境变量

| 变量名                   | 说明                                                                    | 默认值                      |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------- |
| `DATABASE_URL`           | **必填** 数据库地址，例如 `mysql://root:123456@127.0.0.1:3306/wewe-rss` | -                           |
| `DATABASE_TYPE`          | 数据库类型，使用 SQLite 时需填写 `sqlite`                               | -                           |
| `AUTH_CODE`              | 服务端接口请求授权码，空字符或不设置将不启用 (`/feeds`路径不需要)       | -                           |
| `SERVER_ORIGIN_URL`      | 服务端访问地址，用于生成RSS完整路径                                     | -                           |
| `MAX_REQUEST_PER_MINUTE` | 每分钟最大请求次数                                                      | 60                          |
| `FEED_MODE`              | 输出模式，可选值 `fulltext` (会使接口响应变慢，占用更多内存)            | -                           |
| `CRON_EXPRESSION`        | 定时更新订阅源Cron表达式                                                | `35 5,17 * * *`             |
| `UPDATE_DELAY_TIME`      | 连续更新延迟时间，减少被关小黑屋                                        | `60s`                       |
| `ENABLE_CLEAN_HTML`      | 是否开启正文html清理                                                    | `false`                     |
| `PLATFORM_URL`           | 基础服务URL                                                             | `https://weread.111965.xyz` |

> **注意**: 国内DNS解析问题可使用 `https://weread.965111.xyz` 加速访问

## 🔔 钉钉通知

进入 wewe-rss-dingtalk 目录按照 README.md 指引部署

## 📱 使用方式

1. 进入账号管理，点击添加账号，微信扫码登录微信读书账号。

   **注意不要勾选24小时后自动退出**

   <img width="400" src="./assets/preview2.png"/>

2. 进入公众号源，点击添加，通过提交微信公众号分享链接，订阅微信公众号。
   **添加频率过高容易被封控，等24小时解封**

   <img width="400" src="./assets/preview3.png"/>

## 🔑 账号状态说明

| 状态       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 今日小黑屋 | 账号被封控，等一天恢复。账号正常时可通过重启服务/容器清除小黑屋记录 |
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

原作者的 `weread.111965.xyz` 已经停止维护，需要的话可以登录wechat2rss进行购买部署。

## 如果你觉得对你有帮助可以给我来杯可乐~https://wise.com/pay/me/jinn175

## 📄 License

[MIT](https://raw.githubusercontent.com/cooderl/wewe-rss/main/LICENSE) @cooderl
