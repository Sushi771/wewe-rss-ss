# 微信公众号订阅恢复：总控状态（2026-09-30）

## 最终目标

实现可自行审查、构建、部署的微信公众号订阅核心，支持添加公众号、后台与手动/定时更新、正文及图片保存、RSS、Markdown、Obsidian 与浏览器 ZIP，保留旧数据；运行时不依赖第三方开发者闭源中转或商业授权服务器。

## 2026-09-30 续研与当前状态

- **目标号不是没有公开合集 ID。**前轮仅检查目标旧库文章 URL，漏读了 [2026-09-27 真实通道核查](../CHANNEL_INVESTIGATION.md#公开合集的真实多篇列表验证)：目标两篇公开原文分别指向“徐汇区”和“复旦数学营”官方合集，四页共 32 个不同 `(msgid,itemidx)`，其中 13 条在 2026-08-19 后。生产 feed 的 `public_album_ids` 只读核验也含这两个 ID；八份当日保存的目标原文 HTML 均能静态发现所属合集。它们只证明两个合集的有限范围，不能推成全号列表。
- [本轮独立 Probe](TARGET_ALBUM_PROBE.md)对已核验的目标“复旦数学营”合集先做一次首屏，再经离线门禁复核后做一次当前首屏及真实游标下一页：两页 HTTP 200、业务码和验证状态均为 0，10+9 个不同文章键，19/19 个链接的目标 `__biz/mid/idx` 与列表一致。当前键集合与 2026-09-27 同合集相同，故**本次未观察到新增**。其中 6 篇与已保存原文的 `biz/mid/idx/sn/ct` 精确对应，原文时间比合集时间晚 0–34 秒，达到此**有限合集**的五篇身份和发布时间首轮样本门槛；这不是全号覆盖或持续增量验收。
- 六份 2026-09-27 原文 HTML 均有正文，五篇共 28 张 `data-src` 图片；今天只匿名部分读取其中一张，确认该样本 HTTP 206、PNG 签名。其余图片、当前其他文章的在线正文和完整离线导出尚未逐篇验证。现有公开合集只覆盖已知两个专辑，不能代表所有历史或未来更新。
- A [认证研究](RESEARCH_BOOK_ARTICLES_AUTH.md)追到 Mac 腾讯客户端同主机 `vid/skey` 日志、移动 token 到 Web Cookie 桥接及 Rust Web 登录生命周期；仍无证据将本人现有 Windows 凭据直接用于 `/book/articles`。B [候选矩阵](SOURCE_CANDIDATE_MATRIX.md)按真实腾讯请求排除旧端点换壳、闭源中转与禁止的桌面数据路径。C [公开页面发现](PUBLIC_PAGE_DISCOVERY.md)核验了原文 `appmsgalbuminfo` 到官方合集的代码链和八份目标 HTML；该链找到两个已知合集，尚无全号主页/全量目录。
- 三个 Codex 独立 task 创建请求只先返回 `clientThreadId`，三个 worktree 实际生成，但正式 ID 长时间未出现在任务列表；按用户指定回退到各自 worktree 的子 Agent。A 的延迟 task 仅合并独立 Rust 增量，避免重复研究。A/B/C 和 Probe 输出均经总控 review 合入 main。生产 SQLite 未写入。
- 工程核对发现：合集 `create_time` 与原文 `ct` 相差数十秒时，已有正文补取会错误拒绝；现仅对未绑定原文且规范身份一致、时间差不超过 60 秒的文章接受原文时间并校正。公开合集请求严格检查 `verify_status`、不跟随验证跳转、页间隔 2 秒；空合集封面不覆盖旧封面。相关隔离 SQLite/Jest 62 项与服务端构建通过，仍未在生产库启用该通道。
- [生产 SQLite 副本演练](TARGET_ALBUM_REHEARSAL.md)用旧保存的真实目标两页 JSON 离线回放当前代码，两次均解析 19 篇；副本 12 个订阅、1447 篇不变，旧文章 ID/时间/正文/指标和非空封面保护检查均为 0 异常。旧 JSON 键集合与今日在线结果相同，但演练不能代替自然新增或全部导出验收。生产库只读。
- C 对一篇此前未保存 HTML 的当前列表文章作一次匿名原文 GET，返回正文页并见到两个已知合集之一；[报告](PUBLIC_PAGE_DISCOVERY.md)明确旧 `var biz/mid/idx` 解析未形成身份闭环，未将其计入真实文章验收，也未为补证据重发。B 对 [`profile_ext` 凭据链](SOURCE_CANDIDATE_MATRIX.md)追到个人微信短期会话来源；已核实现依赖项目禁止的客户端缓存或抓包，尚无合法独立续期链，不据此探针。
- [搜狗微信索引专项](SOGOU_PUBLIC_INDEX.md)追到可审查的桌面 `/weixin`、同会话 `/link` 和腾讯签名 `/s` 请求。本目标四次有界首屏均 HTTP 200；最近一次索引 9 条中 8 条作者昵称匹配，`/link` 生成签名形状正确的腾讯 URL，但**唯一一次腾讯签名页 HTTP 200 且没有 `#js_content`**，故未取得或核对 `biz/mid/idx/ct`、正文和图片，不能算真实目标文章。已停止该候选请求并继续离线追原因；移动 `/weixinwap` 的十篇作者案例尚缺公开解析代码及本目标验证。
- B [后台候选复核](SOURCE_CANDIDATE_MATRIX.md)确认近期 `free_publish` 兜底 PR 只证明接线和构建，没有当前跨号成功回包；另一新包装仍调用本机已测 `200013` 的 `appmsg/list_ex`，不重发。C [腾讯相关文章脚本](PUBLIC_PAGE_DISCOVERY.md#相关文章与页面导航新的腾讯端点尚未请求)发现 `/mp/relatedarticle` 的真实两阶段请求，但八份目标旧页相关标志全为 0，匿名认证与同号覆盖未证，不以推荐列表冒充订阅目录。
- 2026-09-30 最近几次远端 CI 因三份研究文档未格式化而在 `Format check` 失败；提交 `6d4de92` 修复后，[运行 36613922766](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36613922766) 的 `lint-test` 与 `private-image` 均成功。此前将这些失败运行口头称为成功的判断已纠正。
- C 线在八份旧目标原文中追到 `window.cgiDataNew` 的 `bizuin/mid/idx/sn` 和原始时间均 8/8 与已核验来源相符；[当前解析器](../../apps/server/src/collection/article-page.ts)已加入单脚本、平衡对象、有界唯一标量读取，拒绝与旧 `var` 字段冲突。不执行页面 JS；移除旧字段后的八份离线回归仍 8/8 精确匹配。一次性未保存的 9 月 30 日新页不能因此被追认。
- B 找到不同于旧列表和 Gateway 搜索的[微信读书 Web 搜索代理](SOURCE_CANDIDATE_MATRIX.md)：固定开源实现从已登录的 `weread.qq.com` 页面直连腾讯 `POST /web/wx_search_broker_proxy`，作者 2026-09 的一手响应记录含文章 URL、来源名与时间字段。它是相关性搜索，尚无目标号回包，也没有全号分页/持续更新证明。[隔离探针](WEB_SEARCH_BROKER_PROBE.md)已完成八项离线自检；因当前没有可确认的本人有效 Web 登录页面，目标准确号名 POST **0 次**。本人正常登录后只拟发一次首屏请求；当前继续离线追同源实现与分页能力，不把这一个待登录实验扩展成项目外部阻塞。
- 最近主分支 `128bf88` 的 [CI 运行 36618790436](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36618790436) 已完成，`lint-test` 与 `private-image` 均成功。此后提交仍分别核验。
- C 对官方合集中的另一篇 2026-09-14 原文仅发一次匿名 GET：HTTP 200 且进入有正文的页面解析，但解析身份与合集 `biz/mid/idx/sn` 至少一项不符，未保存可追溯的差异字段；该篇身份、原文时间和图片均**未验收**，同 URL 不重试。[离线诊断](PUBLIC_PAGE_DISCOVERY.md)在四页 32 条旧合集记录与八份已保存原文上四字段 8/8 相同，只排除了旧样本的普遍比较错误，不能推断这次具体原因。
- B 另找到[官方微信读书搜索页自然滚动](SOURCE_CANDIDATE_MATRIX.md)的开源实证：2026-07 四个其他公众号按页面号名筛选，三次取得 35/35/33 条及原文直链；较 2026-09 直接搜索代理 POST 重复首屏的结果有实质差异，但目标号、当前滚动增量及全史覆盖仍未证。[单滚动隔离探针](WEREAD_NATURAL_SCROLL_PROBE.md)17 项离线断言通过，当前目标页导航/滚动均 0；只在本人正常登录且确认官方目标搜索页后作一次自然滚动，不监听网络或批量点击文章。
- A 进一步从[腾讯搜索页公开静态 JS](RESEARCH_BOOK_ARTICLES_AUTH.md#新专项正常-web-登录到搜一搜的会话链)核到 PC 页面直接 `POST weread.qq.com/web/wx_search_broker_proxy`，显式带浏览器凭据，请求体为 `query/offset/searchid/searchcookies`；响应 `offset/searchID/cookies/continueFlag` 驱动后续滚动。此为实际客户端请求代码，解释页面续页与此前手写参数重放的差异；源码没有按目标 `biz` 过滤，`source.dateTime` 仍只是展示时间，本账号结果与会话有效性尚未在线核验。B 另核实腾讯元宝 Web 的 7/7 仅为**已有标题补原文链接**，不能按号发现新文章，不为订阅列表探测。
- 主分支 `3e79dcf` 的 [CI 运行 36621435420](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36621435420) 两个 job 均成功；后续提交仍逐次核远端。
- [六篇真实旧原文的 SQLite 副本导出演练](TARGET_ALBUM_EXPORT_REHEARSAL.md)再次证明两页 19 条回放不改 12/1447 基数或旧 ID、正文、可信时间、指标。限定六篇 RSS 和浏览器 Markdown 均 6/6 含正文、28 个图片引用；在完全禁网时 Obsidian 仅无图 1 篇完成，限定 19 篇的 ZIP 仅 1 篇完整、18 篇明确未完整，说明图片**字节**和其他正文仍欠在线验收。六篇旧短 ID 的 `verified_source_url` 为空，显式正文重试门禁 6/6 拒绝；未放宽保护或用旧 HTML 伪作今天采集。
- C 另用一篇已保存、四字段及原文时间离线核验过的目标旧文章作唯一一次当前页面对照：HTTP 200、`#js_content` 存在，但当时探针把身份解析/规范化/时间异常合成 `parser_stop`，不能断言具体失败层，也不能验收当前正文。与前次“解析后四字段至少一项不符”是不同检查点；两个 URL 均不重试。[报告](PUBLIC_PAGE_DISCOVERY.md)及改进的分阶段离线探针已合入，并把三个已请求摘要永久列入禁止重复集合。
- B 将[腾讯第一方搜索页 JS 的续页字段](SOURCE_CANDIDATE_MATRIX.md)核进候选矩阵：实际 POST 用小写 `searchid` 和由上次 `content.cookies` 得来的 `searchcookies`；此前开源直连实现的 `searchID/conversationID` 重复 15 条只排除那个请求形状。目标号当前是否真有下一页仍未验证。对 `/weixinwap` 的多语言公开代码检索未命中可审查的近期文章 HTTP/解析实现，只限定本轮检索覆盖。A/B/C 已开始下一轮有区别的源码研究。
- [独立可见 Edge 登录窗口预案](WEREAD_LOGIN_WINDOW_PLAN.md)已做空会话启动/清理冒烟验证：随机私有 profile、本机回环且进程归属可核的动态 CDP 端口成功；普通关闭未在 10 秒内完成，经核对只终止本次 profile 进程后清理，端口与 profile 均消失。本人扫码、有效 Web 会话、目标 POST 和搜索页滚动仍为 **0**，需要本人正常登录时再做一次低频只读验证；其他源码研究继续。
- A 的[独立 Python 登录实现](RESEARCH_BOOK_ARTICLES_AUTH.md#第三轮旧-skey-映射的独立复核2026-09-30)确认移动 `accessToken` 曾作为 Web `/web/login/session/init` 请求体中的 `skey`，但没有证明它等于旧 `/book/articles` 自定义头；正在核对本机旧凭据的来源与有效期元数据，尚未读取原值或发送认证请求。B 的[非 PC 腾讯静态 JS](SOURCE_CANDIDATE_MATRIX.md)只给原生桥 `/wxsearch/broker` 相对路径，未给可自建直连的 HTTP 域名/认证；找到的 `/weixinwap` 历史 JSONP 仅分页搜**公众号账号**，不是文章目录。C [公开文章静态链](PUBLIC_PAGE_DISCOVERY.md#公开页面静态-js-的实际发现链与全号边界离线补核)显示 `/mp/publictag` 仅在有 `tagId` 且无合集 `link` 时回退；八份目标页没有该种子，已检查的合集、主页、相关文章 JS 均未给全号目录。上述只排除各自已查源码形状，继续保留其他有依据来源。
- `b62d757` 的远端 `Format check` 因新表格排版失败，已由 `be8750a` 修正；[CI 36626605290](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36626605290) 两个 job 成功。B 增量主分支 `26152c0` 的 [CI 36627037368](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36627037368) 亦成功。所有这些提交仍只有研究/探针准备，不能称真实订阅恢复。
- [移动凭据→官方 Web 会话桥接](WEREAD_MOBILE_TO_WEB_PROBE.md)已按公开 Go/Python 实现从生产 SQLite **只读**取唯一账号独立 `mobile` 对象，向腾讯 `/web/login/session/init` 只发一次请求：HTTP 200 JSON，下发 `wr_vid/wr_skey/wr_rt`，`wr_vid` 与移动账号一致。Cookie/凭据/响应正文均未输出或保存；生产库事后 `quick_check=ok`、12/1447 未变。此为**候选 Web Cookie 下发**，并未单独证明其能访问搜索或其他 Web 接口。
- [同进程首次 Web 搜索](MOBILE_WEB_SEARCH_PROBE.md)按固定开源请求形状只做一次 init 和一次目标准确号名 `POST /web/wx_search_broker_proxy`：init HTTP 200 JSON，再次下发 `wr_vid/wr_skey/wr_rt` 且身份一致；搜索 HTTP 200 JSON、`errCode=-2012`，未返回 `content` 或目标文章，随即停止，未翻页/重试/写库。该结果只排除这组新 Cookie 从 Node 直连搜索的具体请求上下文；不能推成整个 Web 搜索、浏览器同源上下文或旧 `/book/articles` 均不可用。A 正追查 `-2012` 与 Cookie 生命周期，B/C 继续独立来源研究；没有新源码依据前不重发同形状请求。
- 已修复公开合集采集的旧短链正文绑定：只有旧短链原文解析出可信时间、它与官方合集的**完整带 `sn` 原文链接相同**时，才在采集事务中填入此前为空的 `verifiedSourceUrl`；现有可信绑定、旧正文和指标保留。隔离 SQLite 测试证实匹配后正文重试门禁开放，`sn` 不同仍拒绝。尚未在生产库执行该采集，不能称六篇旧文已补正文或图片；后续仍须单篇在线与副本导出验收。
- A 已把搜索 `-2012` 的[认证边界与下次对照](RESEARCH_BOOK_ARTICLES_AUTH.md#2026-09-30-web-搜索--2012-的认证边界)追到开源页面内 `fetch` 和完整浏览器 Cookie jar：前次 Node 只发送五个服务器 Cookie 中的三个，原因仍未判定。B [候选矩阵](SOURCE_CANDIDATE_MATRIX.md)又核对了带临时浏览器票据的旧 `/web/mp/articles` 包装及近期后台 fork，未发现可直接接入的独立新列表协议；继续以本人合法会话、非持久浏览器上下文和健康门禁做实质不同的单次对照，不使用抓包运行方式。
- C 从生产库只读找到 14 条不在**已保存**两合集 32 键内的已核验长链种子。[独立 Probe](VERIFIED_ARTICLE_SEED_PROBE.md)选一条无本轮已请求记录的旧文章，仅匿名 GET 官方 `/s` **一次**，得到 HTTP 302 后未跟随；页面、身份、原文时间、图片和所属合集均未取得，私有尝试哨兵禁止同 URL 重试。该结果只覆盖此精确 URL 此时的匿名直连，不证明其他公开页没有合集或全号目录；旧库种子不算新增文章。
- [完整浏览器 Cookie jar 对照](BROWSER_CONTEXT_COOKIE_JAR_PROBE.md)在非持久 Context 中只做一次 Web init 和一次书架健康检查：init HTTP 200、五个 Cookie 均适用且 `wr_vid` 与 mobile 账号匹配；书架 HTTP 200、`errCode=-2012`，因此目标搜索 **0 次**。这说明本次桥接会话未通过书架门禁，尚不能确定 `-2012` 的官方含义、移动 token 是否已失效，也不能把直接搜索或官网页面路径一并排除。A 线正在核对移动 Refresh 的合法来源与轮换语义；无审查结论前不重试旧形状。
- C 线再对八份旧目标原文做离线邻接核查：15 条非空前后篇链接解码后为 11 个不同 `(mid,idx)`，全部落在已保存两合集 32 键中，与 14 个列表外已核验种子零匹配。它只限制这八页的邻接扩展，不证明其他文章不能发现合集。图片字节与离线导出仍需单独真实验证。
- A 找到旧浏览器扩展对 `/book/articles` 的**无显式认证头**首屏发送行；[本机按该形状的匿名 Node 单次只读 Probe](ANONYMOUS_BOOK_ARTICLES_PROBE.md)得 HTTP 401 后停止，未取 `reviews`。它只排除本次匿名直连，不排除合法 `skey/vid`；另有[开源作者一手报告](https://github.com/27Aaron/WeRead-Kit/issues/48)证实 Web init 可对无效移动 token 返回 HTTP 200 与 Cookie，故当前优先用受控移动书架健康检查判别旧 token，刷新前须准备私有轮换凭据恢复，不因 init 200 就宣布认证成功。
- B 追到腾讯搜索页 `_tencent_jsbridge` 的真实 JS 适配层：非 PC `/wxsearch/broker` 只交原生宿主桥，公开代码未给 HTTP 域名、认证或续期，不能把相对 path 猜作自建端点。`/weixinwap?type=2` 的本轮公开代码只找到导航 URL，没有同时给文章解析、分页和近期回包的实现；这是所查索引边界，不是移动公开索引整体失效。
- [当前移动会话单次健康检查](MOBILE_SHELF_HEALTH_PROBE.md)用本人旧正常登录保存的 `vid/accessToken` 请求腾讯移动 `/shelf/sync`，返回 HTTP 401 后停止；没得到书架、也没刷新。此结果使旧 token 不被该请求接受，但不能确定过期与权限等原因。下一步先备份、在私有副本演练凭据轮换后的恢复保存，才能考虑一次正常 Refresh；生产库继续只读。
- 独立 Codex 图片专项最终注册并完成，[一次真实目标旧文章图片探针](TARGET_IMAGE_BYTE_EXPORT_PROBE.md)取得 HTTP 200、完整 JPEG **530,349 字节**；SQLite 一致性副本中将该字节内嵌，重启/禁网后的 Obsidian 与限定单篇 ZIP 附件字节一致，旧文章字段保护通过。另修复图片容器校验与已缓存 `data:` 图片的导出优先级，避免伪图片被算完整或导出再联网。只证明单篇单图和限定导出；其余旧图、整个号 ZIP、当前正文和自然新增仍未验收，生产库未写入。
- B 新核到腾讯 `/review/list` 的真实发送行和官方字段文档：它列的是读者点评，现无 MP 书回包能证明其列公众号发文，故只将其作为未证特殊返回的候选，不作目标探针。近期更新的开源客户端仍调用已测 `/web/mp/articles`。本轮已合入图片修复，main 上四组测试 31/31、服务端构建通过；继续追移动凭据的正常续期与其他有一手证据的目录来源。

## 前轮判断（已由上节更新）

- main 只由总控整合。接手时本地和远端均为 542bc70。生产 SQLite 只读核验 quick_check=ok、12 个订阅、1447 篇文章；没有生产写库或服务切换。私有 Gateway 配置被 Git 忽略，未读取或记录 Key 值。
- Codex 创建/读取/继续/等待 task 能力存在，但第一批独立 task 延迟注册后与先开工的子 Agent 重复，重复 task 已停止。托管 worktree 创建因忽略目录扫描 AGENTS.override.md 失败；三位实际执行者是子 Agent，各有独立 Git worktree/branch。临时移出的忽略测试产物已恢复原位；没有多人改 main。
- 官方 Gateway /\_list 既有只读结果不含 /book/articles。旧 WeBook 的 i.weread.qq.com/book/articles 路径与失败的 /mp/chapters 不同，但 skey/vid 缺正常登录、可审查且持续可用的来源；本机脱敏证据和私有配置字段名也未证明有这组凭据。2025 登录示例使用占位值且互相矛盾，不以猜测凭据发请求。
- 腾讯公开合集 /mp/appmsgalbum 对非目标号匿名返回首 20、次 10 条且 30 个 key 无重复，但只能证明已知合集范围。前轮仅核对目标旧库 194 行 URL，未见 album_id/hid；遗漏了更早目标公开原文和合集实测。非目标公开原文单次匿名请求遇腾讯验证 302 后停止，只排除该次请求，不能否定既存目标原文能反查合集。目标五篇本轮真实发表时间仍未验收。
- **2026-09-30 纠偏：项目恢复执行。**上一轮把“目前没有可直接发送的目标请求”误判成“只剩外部条件”。`/book/articles` 的 `skey/vid` 来源及生命周期、其他有公开取文代码且与旧失败流程不同的腾讯来源、已知原文到公开主页/合集的发现机制，仍可通过源码历史、客户端实现和一手证据继续调查。目标号官方合集链接只是一条候选线索，不是唯一恢复条件。五篇目标真实文章是接入 Provider 前的验收门槛，不限制对有明确源码、endpoint、认证来源及实质差异的接口做一次隔离、低频、只读验证。
- 新一轮独立研究按 A（`/book/articles` 认证）、B（全局列表实现代码）、C（公开微信页面发现机制）并行。每条候选记录真实腾讯 endpoint、认证、列表/分页/发布时间/正文/图片能力、近期证据及与旧实验的差异；排除仅限被证据覆盖的假设。总控审查后将有意义的候选交给独立 Probe，并持续更新候选矩阵、整合与验证。只有 A/B/C 及后续线索经系统检索和必要最小验证均无可执行项时，才重新评估外部阻塞。

## 前轮执行 Agent（历史交接）

| Agent      | Worktree / branch                                                                    | 当前任务与状态                            | 重要结论                                                          | 输出 main commit                   | 阻塞 / 下一依赖                    |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| A 来源研究 | C:/Users/ss/.codex/worktrees/weread-research/wewe-rss-ss / codex/research-weread     | 微信读书及腾讯公开页面来源研究完成        | 非目标公开合集列表/分页可用，目标缺合集标识；非目标原文遇验证停止 | f1e9dba、7c4af87、874ac44、8081d93 | 等目标官方合集链接或新官方能力证据 |
| B 隔离探针 | C:/Users/ss/.codex/worktrees/weread-probe/wewe-rss-ss / codex/probe-runtime          | 探针诊断、离线认证字段核查及工程复审完成  | 无目标真实请求；指出并发快照测试失效和 URL 规范边界，均已修复     | b39b7fa、e793a84、6cb64fd          | 等明确的新目标实验条件             |
| C 工程准备 | C:/Users/ss/.codex/worktrees/provider-ready/wewe-rss-ss / codex/provider-integration | Provider、SQLite 保护、旧文章身份修复完成 | 副本迁移 12/1447、0 违反；短 ID 跨 sn 去重和旧字段保护已合入      | 392fe03、a7a961d                   | 真正分页/增量契约须等真实来源字段  |

## 整合验证与后续门槛

- 探针 Mock 24/24、保护 Python 16/16、主线相关 Jest 15/15 通过；C 独立 worktree 服务端全量 Jest 19 套/156 项及构建通过。CI c908337 与 874ac44 的 lint-test/private-image 均成功，运行分别为 https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596331010 和 https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596723918。
- 本轮已对单一有限合集完成五篇身份、原文发布时间和分页首轮样本；下一步仍需逐篇在线正文/图片、第二次更新与自然新文章、重启，并继续发现目标号其他合集或全量目录。近期订阅与订阅前全史分别验收。旧库/Mock/接口受理不能代替未完成的部分。
- 生产写入前重新核验一致性备份，在 SQLite 副本完成重复导入、旧字段保护、RSS/Markdown/Obsidian/ZIP、重启与第二个号。当前未满足门槛。
