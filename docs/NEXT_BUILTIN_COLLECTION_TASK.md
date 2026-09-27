# 新窗口任务：验证并内置真实公众号列表与互动指标采集

## 最新交接与提交授权（2026-09-27）

用户本轮再次手动更新目标号，仍显示“公开合集在线取得32篇（新增0，更新32，合并已核验重复0），共4页”，且阅读、点赞、收藏未获取。该提示准确描述旧合集路径，**不是近期完整更新已修复**。下轮任务是取得真实新来源并完成内置采集验收，不能只修改提示、重启或再跑相同合集。

用户已明确要求现在把全部项目源码、迁移、测试和进度文档同步 GitHub，作为未完成开发的检查点；此授权覆盖下文旧的“完整验收后再同步”限制。数据库、备份、环境配置、会话、截图及本机原始证据继续不提交。当前版本与远端状态以 `git log -1`、`git status` 和 `origin/main` 为准；详见 `docs/DEVELOPMENT_HANDOFF.md`。模型建议为 GPT-6 Astra，思考程度 Max，作为复杂通道调查与实现的配置建议，不保证能突破微信上游限制。

## 执行检查点：2026-09-27 13:36

已按下述新账号条件完成独立 Edge 扫码、后台类型确认、真实目标号搜索和列表首屏实测。登录与 searchbiz 成功；appmsgpublish 目标首屏两次（间隔 142.448 秒）均返回 `200013 / freq control`，当前第一方脚本保留的另一 appmsg/list_ex 方法一次也相同。没有真实列表，不能继续分页或接入正式采集；不能无依据重复扫码/密集重试。当前超链接与引用 UI 已无他号文章列表选择，详见 `docs/MP_BACKEND_RESEARCH.md` 与 `docs/MP_BACKEND_ACCEPTANCE.md`。

指标线已独立实测南模公开页：正文和三元身份有效，阅读/赞字段为空。用户在电脑微信打开该篇后，在已授权近期 HTTP 缓存范围内仍未取得这篇会话，未扩大读取范围，收藏仍缺失。详见 `docs/ARTICLE_METRICS_RESEARCH.md`；新增只读探针 `scripts/probe-article-metrics.cjs`，不能当作生产指标采集器。

13:35 最终只读数据库对本轮13:30新基线零差异，仍为12号/1425篇、目标180篇/8篇正文。两篇其他号的既存发布时间变化已纳入新基线，不应回滚。此次未写库、未新增生产适配器、未构建重启、未提交同步；原未提交修改保留。官方后台首页留在独立 Edge，空白编辑器已关闭，会话未导出。后续必须提出有新证据支持的列表或文章会话来源，不把本次登录成功当作完成。

## 最新条件变更：已注册个人公众号后台

用户已注册个人版本的公众号后台。此前“没有公众号后台账号”是旧条件，现在应优先验证本人后台扫码会话的文章搜索/列表通道。先确认该账号已完成注册、能进入公众号后台（不是小程序），再通过本机独立浏览器让本人扫码；不得向第三方网站交付会话。

第一步用真实后台会话验证目标号搜索或文章链接识别，以及当前实际列表请求、近期条目和分页。优先审查 we-mp-rss 的后台登录和 wechat-article-exporter 的 searchbiz/appmsgpublish 实现，参数以当前页面真实请求为准。账号前提满足不证明上游接口当前可用；维护者停服报告和旧接口限制仍须考虑，但之前“缺少后台账号”已不能作为排除这条路线的理由。若编辑器中存在搜索其他公众号文章的入口，可只读查询验证，不发布文章或改变账号设置。

本人新公众号的官方统计权限不等于能读取“妈妈部落畅聊阁”的私有后台统计。目标号的阅读、点赞继续独立验证 Credential/文章页来源；收藏总数仍需独立可信来源。后台列表成功后，在 WeWe-RSS 内置扫码、会话保存/失效提示、列表采集和定时更新，不能要求长期另开第三方采集器。

请直接执行下面任务，不只给方案。使用多个子 agents 分工：列表通道研究与实测、单篇指标研究与实测、主线内置实现、独立验收；遵守可用并发数，明确文件归属，共享工作区不能互相覆盖。先验证真实来源，再决定正式实现。不要把状态提示、重启成功、测试通过当成采集修复。

## 项目与最终产品目标

- 工作区：`C:\Users\ss\.gemini\antigravity\playground\sparse-comet\wewe-rss-ss`
- 仓库：https://github.com/Sushi771/wewe-rss-ss.git
- 本轮检查点以前的 main 为 `a5da13576001813cd5cf8bbdaa30f10f1c189279`；用户已授权同步后续修改。开始时读取实际 HEAD/远端状态，不把这个历史 SHA 当最新版本，保留后续未提交修改。
- 目标号：妈妈部落畅聊阁，`MP_WXS_3895431412`，biz=`Mzg5NTQzMTQxMg==`。
- 页面：http://localhost:4000/dash/feeds/MP_WXS_3895431412
- 用户在 WeWe-RSS 添加公众号、完成必要的本人授权后，点击更新或运行定时任务，由应用自身取得列表、分页、正文、真实指标并入库；授权状态、失效、失败和有限覆盖准确显示。
- 已有新注册的个人公众号后台，优先免费。不依赖 WeChatDownload 或其他外部下载器，不包装其 MCP，不先下载 CSV/HTML 再导入，不轮询外部文章目录作为订阅。
- 可以审查并按许可证移植开源代码，但不能把第三方项目的广告、Mock 或历史演示当成当前可用证明。新增 Python/helper 等依赖必须说明用途、打包方式和维护风险，不能要求用户另开下载程序。

## 必须继承的事实与文件

先读 `docs/REAL_COLLECTION_ACCEPTANCE.md`、`docs/CHANNEL_INVESTIGATION.md`、`docs/LOCAL_COLLECTION.md`，以及 `scripts/probe-builtin-channel.cjs`、`scripts/acceptance-builtin.py`、`scripts/acceptance-recent.py`。

本机证据在 `output/playwright/channel-builtin/` 和 `output/playwright/builtin-acceptance/`，均为 Git 忽略目录。最近已验收基线（2026-09-27 13:09）是12个公众号、1425篇文章，目标180篇、8篇正文。用户随后手动更新过其他号，开始时必须重新只读盘点，不能假定数据库没变化。原1401个ID全保留。任何写库、迁移、真实更新前重新一致性备份，禁止 reset。

上一轮已完成并正式构建、迁移、重启的修改：

- 普通更新、历史和定时不再读取 localDirectory；显式文件导入仅一次性操作，不改在线绑定、不自动启用定时。
- Feed.lastCollectionResult 持久化 pending/running、partial、blocked、failed；按号互斥，前端重载可见结果。
- 合集和封面均 complete:false。保留旧ID、带sn原文、正文和指标；短长链合并须有原文身份核验。
- 后端9套52项测试、项目lint与前后端构建通过，但完整公众号订阅未通过。
- 两个已绑定合集各2页，共32篇，页面两次更新新增0。只有所选合集，不覆盖目标近期全部内容；不要继续靠增加合集或硬编码缺失链接宣称修复。
- 南模篇真实时间2026-09-26 13:21:31。RSS、Markdown/Obsidian、7张JPEG本地化已真实回归通过。

用户最近启动日志是正常启动；随后两个其他公众号仍显示 Fetching WeRead cover、articles:1。这说明仍在封面路径，不能通过重启解决列表和指标缺失。CRON_EXPRESSION未设置会使用代码默认计划，不是此次采集失败原因。

## 已做过的通道实验：不得无依据重跑

1. WeRead封面仅一篇；两条列表此前在登录及本人验证后仍为-2041。无新请求依据不得反复重试，不能声称全球永久关闭。
2. 无会话 profile_ext home 要求微信客户端，getmsg为ret=-3/no session。
3. 用户已明确同意一次受限探针，并在电脑微信内置浏览器打开官方home。只检查最近30分钟微信网页HTTP缓存，找到1个目标号会话候选，未保存或打印凭据，未读聊天数据库。
4. 使用候选访问home返回34,408字节页面和6个Cookie，内嵌msgList={list:[]}；完整回传这些Cookie后getmsg仍为ret=0、msg_count=0、can_msg_continue=0、home_page_list=[]，没有general_msg_list。
5. home引用的第一方 appmsg/profile80ec10.js 与 pages_new/photo_account_profile/index80ec10.js 调用原生profile(username,scene=298)后closeWindow，没有网页列表分页。
6. HTTP200、Set-Cookie或ret0不证明完整列表权限有效。已知有180篇和截图近期内容，所以空响应不能被当成完整结束。原生跳转是重要线索，也不能据此断言所有其他通道无效。

下一轮必须提出与上述实验不同、由当前源码或真实请求支持的假设。不要再次只让用户打开同一home，然后重复相同参数。可以核对现代内容类型、真实请求参数、文章页与首页会话作用域差异；必须从实际页面/源码找到依据，不盲猜端点、批量枚举或用改User-Agent冒充新通道。

## GitHub研究起点（2026-09-27核查；均非目标号可用保证）

### A. 单篇正文和指标：优先做最小真实验证

- https://github.com/hjyl-cheng/wechat-pcspider
- 重点文件：wechatarticles/ArticlesInfo.py、extract_stats_from_html.py、download_full_html.py、capture_new_wechat.py、remove_favorite_count.py。
- ArticlesInfo.py存在getappmsgext以及read_num/like_num/old_like_num解析，可研究“单篇文章授权→指标请求”的协议。源码存在不代表本机当前可用；字段对应点赞/喜欢/在看必须按当前微信原始响应和界面逐项核验。
- 此项目默认采用mitmproxy、系统代理及微信PC自动化，不能原样照搬。README示例含favorite_count，另有脚本删除与like_count重复的favorite_count，字段说明也有混称；绝不能据此声称支持真实收藏总数。其README用途限制与LICENSE也需核对后再移植。

### B. Credential接口、内容类型和导出解析：仅参考可验证模块

- https://github.com/wechat-article/wechat-article-exporter
- 重点文件：server/api/web/mp/profile_ext_getmsg.get.ts、types/credential.d.ts、public/plugins/credential.py、server/api/web/mp/appmsgpublish.get.ts，以及文章/图片消息解析。
- 维护者在 https://github.com/wechat-article/wechat-article-exporter/issues/200 宣布2026-07-30停止维护，称核心后台接口受限、Credential路线未接入主流程。这是维护者报告，不是所有微信接口永久不可用的证明。
- Credential插件使用代理并把会话写文件，不能直接复制其凭据落盘和网络处理方式；历史getmsg路线很可能与已失败路径相同，须证明差异后才测。

### C. 授权与任务调度设计：不能忽略账号前提

- https://github.com/rachelos/we-mp-rss
- 重点文件：driver/wx_api.py、driver/wx.py、driver/wxarticle.py、driver/extdata/like.py。
- 本次检查wx_api.py/wx.py确实访问mp.weixin.qq.com公众号后台登录。用户现已有个人公众号后台，此路线提升为列表验证优先项；同时可参考生命周期和调度。最近有提交不证明本机目标号采集可用，必须对新注册账号实测。

### D. 本人网页会话捕获的已有研究

- https://github.com/tingaidehua/wechat-article-downloader-skill
- docs/protocol-principles.md及capture/provider代码可以帮助理解会话边界；上一轮已借鉴思路完成受限实测但列表为空，其测试为Mock，不要重复将其列作已解决方案。

为每个候选记录：具体commit、入口函数、真实上游、所需账号/会话、是否需要外部程序或代理、内容类型覆盖、指标语义、许可证、当前验证结果。先读代码，不安装运行未知第三方EXE，不把凭据发送给第三方代理/API。

## 两条验证线与实施门槛

**列表线：** 找到覆盖目标近期“全部”内容的真实来源。先取得至少一页确实含近期漏采项的原始列表及下一页，再验证选定时间范围的终止条件。区别群发文章、非群发文章、贴图、转载、转发；如果是他号原文的转发，目标号发布事件与原文身份必须分开，不把外号原文冒充本号文章。没有完整列表前，不大规模重构采集架构。

**指标线：** 不被列表阻塞拖住。使用目标号已知南模篇 https://mp.weixin.qq.com/s/K_oKauPpwhSyavBWQXFMKw 验证一篇真实阅读与点赞来源。必要时由WeWe-RSS提供清楚授权入口，请用户在微信打开该篇；不要以先导文件为前提。取得真实响应后校验biz/mid/idx、字段语义与观测时间，再处理第二篇和刷新。单篇指标验证通过可先集成上线，但明确它不解决全号发现。

收藏总数必须找到独立、可信原始字段才能实现。没有来源则null并标记unsupported/unavailable，不能用点赞、在看、喜欢、个人是否收藏、朋友转发或截图人工数字代替；读取失败也不能写成0。各指标存source、fetchedAt、原始字段名、值/下限及缺失原因，失败不抹掉历史有效值。阅读/点赞语义验证通过后才启用相应排序。

任一真实通道验证通过后，才把HTTP请求、分页、身份核验、正文缓存、指标存储、速率限制和重试接进现有服务；手动与定时共用。授权失效停止并提示重新授权；列表完成、正文部分失败、指标不可用分别显示，不能合成一个成功标志。不要以两套未经验证的适配器或假二维码作为交付。

## 漏采与最终验收

用户截图来自手机微信：
- C:\Users\ss\AppData\Local\Temp\codex-clipboard-71e6442e-382d-480d-9430-404d1b13e1c6.png
- C:\Users\ss\AppData\Local\Temp\codex-clipboard-199bb6c6-e81d-4b37-92ef-e80663f3737c.png

逐项核验“思维100秋季开始报名！”、“华二断层领先，2026年物理竞赛上海省队和获奖情况解析”、“上岸四校八大的路径其实很清晰”、周一化学竞赛内容（只见封面，完整标题未知）。截图选中全部，另有贴图和文章；类型不可猜。思维100封面2026-09-24 21:02是嵌入原内容时间，不是目标号发布时间。

- 用原文biz/mid/idx和canonical去重；不按标题或模糊时间合并，保留旧ID/带sn链接/已有正文/指标。
- 从WeWe-RSS页面更新证明漏项入库，再次更新新增0；保留脱敏分页和终止证据。
- 取得真实idx>1再声称次条已验证；没有样本明确未验证。
- 真实阅读/点赞响应不能由截图或合成fixture充当；收藏若不可得，验收缺失状态而非伪造功能。
- 保留并实际验证RSS、Markdown/Obsidian、正文、图片本地化。
- 新通道实现后构建并重启实际服务，独立验收复核数据库与页面。允许按用户最新授权提交未完成的开发检查点，但必须明确未完成项，不将提交同步当成完整采集通过。

## 操作边界与停止条件

可用请求级127.0.0.1:7890代理；不可改全局代理、Defender、证书信任，不读取聊天数据库或整个用户目录。已有授权只涉及目标号近期网页HTTP缓存；若新方法需要不同敏感范围，先完成代码审查与具体方案，再说明新增读取对象和必要性，请用户决定。已有独立配置真实Edge的Playwright授权保留，不修改用户原Edge配置。

后台账号前提已由用户新注册账号满足，但权限与接口仍待实测。若唯一候选还要求付费接口、微信客户端持续常驻或原生程序注入，明确前提与维护成本，不能悄悄把它算进“免费内置即用”。若确实无满足约束的可用通道，给出具体响应和源码依据、已排除路线、真正尚缺条件；不要再以新增状态文案、文件导入、合集数量或重启结束本次开发。禁止承诺未经验证的全号采集或收藏获取能力。
