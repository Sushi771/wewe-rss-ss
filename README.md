<div align="center">
<img src="https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/logo.png" width="80" alt="预览"/>

# [WeWe RSS](https://github.com/cooderl/wewe-rss)

更优雅的微信公众号订阅方式。

![主界面](https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/preview1.png)
</div>

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
- **历史回溯能力**：支持获取公众号历史发布文章，不再错过任何精彩内容。

### 🛡️ 核心与稳定
- **V2.x 接口重构**：使用全新接口体系，运行更加稳定，显著降低封控风险。
- **科学更新策略**：优化连续更新延迟策略，默认间隔 3s，在效率与安全之间实现完美平衡。
- **全格式 RSS 支持**：生成标准微信公众号 RSS (支持 `.atom`, `.rss`, `.json` 格式)，完美适配各类阅读器。
- **所有订阅源一键导出**：支持导出全量订阅源为 OPML 格式。


### 高级功能

- **标题过滤**：支持通过`/feeds/all.(json|rss|atom)`接口和`/feeds/:feed`对标题进行过滤
  ```
  {{ORIGIN_URL}}/feeds/all.atom?title_include=张三
  {{ORIGIN_URL}}/feeds/MP_WXS_123.json?limit=30&title_include=张三|李四|王五&title_exclude=张三丰|赵六
  ```

- **手动更新**：支持通过`/feeds/:feed`接口触发单个feedid更新
  ```
  {{ORIGIN_URL}}/feeds/MP_WXS_123.rss?update=true
  ```

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

为了确保本项目的持久运行，某些接口请求将通过 `weread.111965.xyz` 进行转发。请放心，该转发服务不会保存任何数据。

## ❤️ 赞助

如果觉得 WeWe RSS 项目对你有帮助，可以给我来一杯啤酒！

**PayPal**: [paypal.me/cooderl](https://paypal.me/cooderl)

## 👨‍💻 贡献者

<a href="https://github.com/cooderl/wewe-rss/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=cooderl/wewe-rss" />
</a>

## 📄 License

[MIT](https://raw.githubusercontent.com/cooderl/wewe-rss/main/LICENSE) @cooderl
