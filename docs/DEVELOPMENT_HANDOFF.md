# 自建微信公众号订阅：当前精简交接（2026-09-30）

## 2026-09-30 当前续研

- [总控状态](coordination/STATUS.md)已撤回“只剩外部条件”和“目标无合集 ID”两项错误判断。[2026-09-27 真实核查](CHANNEL_INVESTIGATION.md#公开合集的真实多篇列表验证)早已从目标原文发现两个官方合集，四页共 32 个不同文章键；本轮又从八份保存的目标原文 HTML 和生产 feed 的 `public_album_ids` 只读交叉核对。两个合集只是局部来源，不能证明全号覆盖。
- [目标合集 Probe](coordination/TARGET_ALBUM_PROBE.md)对已核验的“复旦数学营”合集取得当日两页，HTTP 200、业务码与验证状态均为 0，10+9 个不同文章键，19/19 个链接身份匹配。当前集合与 2026-09-27 相同；六篇与当日保存原文逐项匹配并核对原文 `ct`，相差 0–34 秒，因此单一合集的五篇身份和发布时间样本及分页已过。**没有观察到自然新增，也没有证明全号覆盖。**六篇旧原文均有正文，五篇有 28 张 `data-src` 图片，今天仅部分读取其中一张。生产库只读，未切换订阅。
- A [认证来源研究](coordination/RESEARCH_BOOK_ARTICLES_AUTH.md)追到 Mac 客户端同主机 `vid/skey`、移动/Web/Rust 登录链，但未证明当前 Windows 有可用于 `/book/articles` 的独立凭据；B [全局候选矩阵](coordination/SOURCE_CANDIDATE_MATRIX.md)追到真实腾讯请求行并按能力缩限；C [公开页面发现](coordination/PUBLIC_PAGE_DISCOVERY.md)核验了原文到合集的代码与八份目标 HTML，尚未发现全号目录。以下前轮记录保留当时状态，遇矛盾以上述当前证据为准。
- 修复了现有公开合集通道的两个数据断点：原文补取可在严格身份核验下校正不超过 60 秒的合集列表时间偏差；空封面不覆盖旧值。列表请求还检查 `verify_status`、不跟随验证跳转、每页间隔 2 秒。隔离 SQLite/Jest 三套 62 项及服务端构建通过；尚未生产写库、完成完整文章图片导出或自然更新验收。
- [真实字段副本演练](coordination/TARGET_ALBUM_REHEARSAL.md)把旧目标合集两页 JSON 注入当前采集代码，在生产库的只读一致性副本连续导入两次，均得 19 篇且 12/1447 基数、旧 ID、可信时间、正文、指标和非空封面保持。C 对一篇未缓存目标原文做一次有界只读请求，但 `biz/mid/idx` 未解析闭环，未计入验收；当前解析器已安全支持公开页 `window.cgiDataNew`，八份旧目标 HTML 离线回归 8/8。B 已缩限 `profile_ext` 短期会话来源及未证实的后台 `free_publish` 兜底。C 另从腾讯静态 JS 定位 `/mp/relatedarticle`，八份目标旧页相关标志均为零，尚未请求该数据端点。
- [搜狗微信索引专项](coordination/SOGOU_PUBLIC_INDEX.md)用固定开源代码验证本目标四次有界首屏；最近一次 9 条卡片中 8 条作者昵称匹配，同会话 `/link` 给出签名腾讯 `/s` 形状。唯一一次腾讯签名页 HTTP 200 但缺 `#js_content`，**没有目标 `biz/mid/idx/ct`、正文和图片证据**，已停止该候选。移动入口仍是未验候选。当前不能接入全号 Provider；继续追合法认证和独立取文来源。
- 最近远端 CI 的 `Format check` 曾因三份研究文档失败，`6d4de92` 修复后 [运行 36613922766](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36613922766) 两个 job 成功。新合入的研究提交仍须按最新远端运行复核。
- B 又找到有当前源码与一手响应记录的[微信读书 Web 搜索代理](coordination/SOURCE_CANDIDATE_MATRIX.md)：同源页面直连腾讯 `POST /web/wx_search_broker_proxy`，与旧失败列表及 Gateway 搜索不同。[一次性隔离探针](coordination/WEB_SEARCH_BROKER_PROBE.md)已准备并通过八项离线自检，当前未确认本人有效 Web 登录页面，目标 POST 仍为 **0 次**；本人正常登录后才验证首屏。B 继续查其分页、作者过滤和持续更新依据；此候选尚不能充当完整订阅目录。主分支 `128bf88` 的 [CI 运行 36618790436](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36618790436) 两个 job 均成功。
- B 又核到[官方搜索页自然滚动的独立实现](coordination/SOURCE_CANDIDATE_MATRIX.md)：2026-07 四个其他号三跑 35/35/33 条及原文链接，和直接 POST 搜索代理重复约 15 条首屏的流程不同。独立[单滚动探针](coordination/WEREAD_NATURAL_SCROLL_PROBE.md)已通过 17 项离线断言，目标页在线导航/滚动为零；须本人正常登录并确认官方目标搜索首屏后才可实测。搜索卡片相对时间不能替代原文 `ct`，单次滚动也不证明全号历史或持续更新。
- C 对有限合集的另一篇目标原文只发一次匿名请求，HTTP 200 HTML 有正文节点，但解析身份与合集记录至少一项不符；该次未保留差异字段，不能判断原因或认作真实新文章，不重试同一 URL。四页旧列表与八份旧原文的四字段离线对照 8/8 一致；见[公开页面记录](coordination/PUBLIC_PAGE_DISCOVERY.md)。
- A 从[腾讯公开搜索页 JS](coordination/RESEARCH_BOOK_ARTICLES_AUTH.md#新专项正常-web-登录到搜一搜的会话链)确认真实 `withCredentials` 请求发向 `weread.qq.com/web/wx_search_broker_proxy`，首屏和续页 body 用 `query/offset/searchid/searchcookies`，`continueFlag` 控制继续加载；不是把 `wr_vid` Cookie 发给 `search.weixin.qq.com`。页面只按关键词搜索，卡片的来源名和时间仍须用原文 `biz/ct` 核验，且登录态会过期。B 同时把腾讯元宝“7/7”缩限为已有标题的单篇补链，不能充当订阅目录。`3e79dcf` 的 [CI 运行 36621435420](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36621435420) 已成功。
- [真实旧原文副本导出](coordination/TARGET_ALBUM_EXPORT_REHEARSAL.md)已把六篇已保存目标 HTML 接到当前采集和 RSS/Markdown/Obsidian/ZIP 路径：RSS/浏览器 Markdown 6/6 有正文、28 个图片引用；禁网下 Obsidian 仅无图 1 篇完成，限定 19 篇 ZIP 仅 1 篇完整。旧 ID、正文、时间和指标未覆盖；图片字节及其余 13 篇正文未取得。C 对另一个已保存真文章做唯一当前页 GET，HTTP 200 且见 `#js_content`，但探针在合并解析异常处停止，具体字段未留；与前一篇的四字段不符不能合并推理，两个 URL 都不重试，详见[页面报告](coordination/PUBLIC_PAGE_DISCOVERY.md)。
- B 已用腾讯第一方搜索页 JS 核对真实续页 `searchid/searchcookies`，旧开源直连项目重复首屏的参数并非该形状；本目标实际首屏与续页均未请求。[独立可见 Edge 登录窗口](coordination/WEREAD_LOGIN_WINDOW_PLAN.md)已在空会话成功启动并清理，CDP 仅监听本机回环且归属该进程；普通关闭超时，需关闭可见窗口后清理。尚未扫码或取得有效 Web 会话，目标 POST/滚动为零；A/B/C 同时继续独立源码研究。

## 2026-09-30 前轮总控续记（历史状态）

- 本轮总控创建 [协调状态](coordination/STATUS.md)，由 A/B/C 三位子 Agent 在独立 worktree/branch 并行执行，总控独占 main 做 review、测试、cherry-pick 和推送。Codex 独立 task 曾延迟注册并与子 Agent 重复，已停止；托管 worktree 工具因扫描大量忽略目录失败，当前三条执行分支为实际独立 Git worktree。生产 SQLite 一直只读，仍是 12 个订阅、1447 篇文章；未切换线上服务。
- [微信读书研究](coordination/RESEARCH_WEREAD.md)确认旧 WeBook 的 /book/articles 与已失败的 /mp/chapters 确是不同腾讯路径，但前者需要的 skey/vid 没有可审查、合法正常登录且能续期的来源；2025 登录示例是占位资料。B [探针与离线核查](coordination/PROBE_RESULTS.md)只见既有 wrk- Key/旧 accessToken 等字段名，未证明有同一认证体系的 skey/vid，因此没有发目标真实请求。
- [公开微信来源研究](coordination/RESEARCH_WECHAT_PUBLIC.md)找到 MIT 许可、直接请求腾讯公开合集列表的实际源码；非目标号匿名读到两页 20+10 个不同 key。该入口要求该号自己发布的 **biz+album_id 合集链接，单个合集也不等于全号。目标旧库 194 行有 46 行含 **biz，却无 album_id/hid；非目标公开原文页单次请求遇腾讯验证 302 后停止，未证明可反查合集。目标号尚无五篇新来源文章。
- [工程准备](coordination/INTEGRATION_READY.md)合入 Provider 页和规范 URL 校验、旧短 ID 跨 sn 去重、只补空正文/图片/来源、SQLite 保护快照 v3；在一致性副本上旧订阅/文章 12/1447、0 保护违反。探针 Mock 24/24、保护 Python 16/16、服务端全量 Jest 19 套/156 项和构建通过；总控主线针对性 Jest 15/15。远端 [CI c908337](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596331010) 与 [CI 874ac44](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596723918) 的 lint-test、private-image 均成功。
- **2026-09-30 纠偏：真实订阅仍未恢复，研究继续。**旧“仅剩外部来源条件”的判断已撤回。新一轮 A/B/C 独立研究分别追 `/book/articles` 的 `skey/vid` 合法来源、其他有公开取文代码的腾讯列表入口、从已有原文发现公开主页/合集的机制；见 [总控状态](coordination/STATUS.md)。不猜 album_id/凭据、不重复旧 -2041/499 请求、不接 Provider/生产库。有源码、明确认证和实质差异的候选可先做一次低频隔离只读验证；五篇目标文章是接入前验收门槛。当前实际模型设置仍无可查询值，记未核实。

## 接手事实

- 当前执行入口是 [私人线上自主管理订阅任务](PRIVATE_ONLINE_DELIVERY_TASK.md)与 [自建路线证据](WEREAD_SELF_HOSTED_RESEARCH.md)；[完整客户端审计](WEREAD_CLIENT_FLOW_AUDIT.md)是旧实验事实来源。用户已暂停 Wechat2RSS 采购、授权与部署，改以可审查、可自行构建部署、无第三方开发者闭源中转的微信读书订阅核心为主线；旧付费部署卡和 [Provider 设计](SUBSCRIPTION_PROVIDER_DESIGN.md)仅作历史参考。本轮接手时本地 `main` 为 `542bc70`，与 `origin/main` 一致且工作区干净；下次接手重新核对 Git。
- 本机实际生产库 `apps/server/data/wewe-rss.db` 只读核对 `quick_check=ok`，12 个订阅、1447 篇文章、44 篇缓存正文；目标 `MP_WXS_3895431412` 原库有 194 篇不同 ID、194 个非空发布时间、20 个 `verified_source_url`，仅可用作比对基线，**不是新来源取到五篇**。`provider_refresh_attempt_time` 列尚未进生产。没有生产写库或服务切换；前轮两次官方 Gateway 只读实验之外，本轮只新增一次 `/_list` 能力发现。
- 用现有在线备份脚本生成一致性备份，报告 `integrityCheck=ok`、12/1447、SHA-256 已核对；备份仅在 Git 忽略的 `output/subscription-implementation/backups/`。又从生产 SQLite 在线复制隔离库，应用新增迁移后比较 `feeds` 和 `articles` 所有旧列逐行摘要，完全一致、`quick_check=ok`。隔离库额外加入一篇测试文章用于 ZIP 验收，绝非真实上游文章。
- 用户此前明确没有现成服务器或域名，现不以租服务器或取得 Wechat2RSS 授权为研究前提；其私有实例未启动。已新建 Git 忽略的 `.env.weread-gateway`，本人已填腾讯官方 Agent API Key；代理不得读取或输出 Key 原值。Windows 旧配置保留，WSL/Docker 不是研究前置。当前窗口实际模型/思考设置无可查询的已应用值，记为未核实。

## 已有证据的缺口与本轮研究

- 真正实测的旧流程：本人墨水屏同类客户端扫码、`/login`、书架与续期成功，目标 `MP_WXS_3895431412` 的 `/mp/chapters` 首屏仍 HTTP 499 / `-2041`；Node Web 人工验证后 `/web/mp/articles` 仍 `-2041`；本人官方 Edge 书架成功、Reader 自发同一 Web 列表首屏为 HTTP 200 / 业务 `-2041`，后续验证码没有成功响应记录。旧 `weread-omni` 只做源码对照，未运行。失败仅覆盖本人账号、目标号、当时时点与已测流程，不能推永久关闭、所有账号/号或所有自建路线。旧脱敏摘要没有保留官方 Reader 请求头，`x-wr-ticket` 是否存在或有效未知。
- 逐项读公开取文源码：`wechrss` 仍走旧 `/mp/chapters`；`weread-mp` 和 `we-mp-rss` 的新模式仍走旧 `/web/mp/articles`，后者近月另一用户取得真实 reviewId，反证“全球永久关闭”，却不是本目标成功。`we-mp-rss` 的 `/api/mp/cover` 只取最新一篇，入库时间是抓取时刻，不能满足五篇及可信发布时间门槛。KOReader 票据说法仅是未附成功输出的假设。PC 微信加 MITM 路线排除；WeWe/Wechat2RSS 的闭源中转或授权依赖不符合新目标。来源与边界见 [研究记录](WEREAD_SELF_HOSTED_RESEARCH.md)。
- **官方 Gateway 两个假设已实测并停止**：其服务端未开源，本项目自建调用侧可直连腾讯而无第三方开发者中转。本人私有 Key 下，目标 `/book/chapterinfo` 请求一次得到成功但 `chapters=[]`，故没有第二个 `/book/info` 请求；准确号名 `scope=4` 搜索一次得 HTTP 499，未见文章结果，也没有重试。首次受限网络尝试仅是传输失败，无 HTTP/业务响应，随后允许联网才有上述两项结果。这些结果不说明其他账号、目标或关键词的情况，更不是 `-2041` 的通用解释。下一条最有依据的源码线索是旧 `/book/articles`：2021 年加入的开源实现确实以 `MP_WXS_*` 请求该路径，2026 客户端端点目录仍列出不同服务类，但没有本目标真实文章证据；无生产写库。
- **本轮排除“缺 skill 导致失败”**：按腾讯官方方式全局安装 `weread-skills`，当前会话可直接读取 `SKILL.md`、`book.md`、`search.md`；三文件与腾讯仓库 HEAD `315698a8` 的 Git blob 一致，实际版本 `1.0.4`。旧探针认证、参数层级、版本号符合官方规范。修复非 200 丢正文的诊断后，本地模拟测试 19/19 通过；旧 HTTP 499 正文当时未保存，不能恢复，未重放旧搜索。
- **本轮新增一次官方能力实测**：用已有私有 `wrk-` Key 对文档列出的 `/_list` 发一次只读请求，成功得到 17 个 Gateway 操作，含 `/book/chapterinfo` 和 `/store/search`，**不含 `/book/articles`**；没有把客户端路径猜成 Gateway 操作。生产 SQLite 重新只读核对 `quick_check=ok`，12 个订阅、1447 篇文章、1 个账户，未写库。
- **`/book/articles` 的具体差异与当前缺口**：固定旧版 `WeBook.get_urls` 确实以 GET、`bookId/count/offset/synckey` 请求 `i.weread.qq.com/book/articles`，预期 `reviews[].review`；2026 Eink 端点目录将其列于 ArticleService，区别于旧失败的 MPListService `/mp/chapters`，但标记 SDK 未使用。WeBook 要求自定义 `skey/vid`，源码没给凭据获取链；官方 Gateway `wrk-`、Web Cookie 与移动 `accessToken` 不能凭名字互换。本机生产账户中的 `wr_skey` 与 `accessToken` 值相同，来自旧 Web 登录赋值，不能证明为 WeBook `skey`。目前没有发 `/book/articles` 请求，也没有取得新文章。旧文档所写“必须先找近期成功五篇回包才能实验”已被用户明确取消；真正待满足的是来源可核验且适用于该端点的本人认证条件。

## 保留的实现与验证（前轮）

- 新增 `PRIVATE_ONLINE_MODE=1`：至少 24 字符登录码换取 HttpOnly、Secure、SameSite 严格会话 cookie，匿名 RSS、文章 API、图片代理、ZIP 下载和私有页面被挡住；登录页/静态资源可加载。线上禁用旧微信读书账号管理/登录接口，不把上游凭据交给普通站点使用者。
- 新增 `GET /download/feed/:id.zip` 与“下载本号 ZIP”：浏览器得到附件响应，Markdown 引用相对路径 `attachments/` 图片；每号 `README.md` 明示完整/未完整数。只有有缓存正文且附件成功落地的篇目计为完整；旧库很多正文缺失，不能宣称全部可离线阅读。线上隐藏旧服务器目录导出入口。
- Wechat2RSS Provider 在保存正文前受限下载并内嵌允许的图片，图片失败则保留旧正文、新正文标为缺失以便重试；容器网络的固定服务名 `wechat2rss` 纳入私有地址校验。真实上游字段、图片和目标号仍待实测。
- 新增单机 Docker Compose 线上配置：主应用与固定 digest 上游分别持久化，只绑定 `127.0.0.1`；Tailscale Serve 提供私人 HTTPS。部署脚本在迁移前备份并停应用；备份脚本对 SQLite 在线备份、上游数据短暂停机归档。本机无 Docker；GitHub Actions 的 `private-image` 已成功构建 `Dockerfile.private-online`，尚未做容器运行验收。
- 前轮曾形成 DigitalOcean + Tailscale + Wechat2RSS 的 [部署操作卡](PRIVATE_ONLINE_DEPLOYMENT.md)；该方案现已暂停，仅作历史工程资料，尚未购买或部署。
- 本机 HTTP 验收使用迁移后的隔离库和测试文章：匿名内容路由 401、私有页 302 登录、错误登录 401、成功登录后 RSS 200、ZIP 200；下载的 47 MB ZIP 经过解压检查，570 个条目中 157 个 Markdown 图片引用对应 ZIP 内相对路径文件。所选旧号 195 篇中 28 篇离线完整、167 篇明确标未完整（含一篇测试夹具）。这仅证明副本上的下载与保护链路。
- 服务端完整 Jest **18 套 / 148 项通过**，服务端与网页构建、两端 lint、格式与 Git diff 检查通过。隔离库上的本机 HTTP 验收在服务重启后复测，六类匿名入口被拒、旧账号接口 403、RSS 200、ZIP 200。远端 [CI 运行 36521304651](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36521304651) 的 `lint-test` 和 `private-image` 均成功；Docker 镜像已构建，尚未在目标服务器运行。

## 下一步与门槛

1. 继续核实 `/book/articles` 当前版本的合法 `skey/vid` 来源，或找另一条有公开取文代码、与旧失败流程真正不同的路径。若能核对本人已有凭据与该接口认证条件，按固定源码请求形状做一次低频隔离只读首屏，首先记录有无真实条目和字段名；遇认证拒绝、验证码或频控即停。近期成功案例可增强证据，但不是实验前置条件；不把 `wrk-`、Web Cookie 或 `accessToken` 猜成旧 `skey`。
2. 单一目标合集已通过五篇身份/原文发布时间与两页分页样本；继续按 canonical URL 低频核验未保存原文的正文、图片和完整下载，验证该合集自然新文章及多次更新，同时查其他合集或全号目录。不得用这 19 篇推断目标全史。近期订阅与订阅前全史独立记录。
3. 现有 `public-album` Provider 仅表达所选合集的局部订阅；在生产启用前，先在 SQLite 一致性副本用真实字段演练重复更新、旧字段保护、正文图片、RSS/Markdown/Obsidian/ZIP 与重启，再核验备份。最终还需干净环境构建部署、私有凭据、依赖版本追溯、故障诊断、回归测试及全部旧文章/导出保留；当前无线上可用入口。
4. 每个实质单元跑相关测试、查敏感文件、提交推送并核远端 CI。有可执行研究就继续；仅余用户正常登录/官方验证或其他外部条件时保存检查点、列明缺口，不再反复修改报告或自动转回付费方案，也不创建空转后继任务。
