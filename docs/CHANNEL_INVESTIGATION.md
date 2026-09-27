# 真实采集通道核查（2026-09-27）

## 个人公众号后台实测（2026-09-27 13:30–13:36，优先于历史记录）

用户已完成个人公众号注册，本轮在本机独立真实 Edge 中扫码进入公众号后台。此前“没有后台账号”的前提已失效。本轮未安装外部下载器，未修改用户原浏览器配置、全局代理或证书，也未导出后台会话。

- 后台转载查询可用已知南模短链识别目标号，并在界面显示 `biz=Mzg5NTQzMTQxMg== / mid=2247493540 / idx=1`。这只是单篇链接识别，不是列表来源。
- 编辑器“账号名片”的真实 `searchbiz?action=search_biz&scene=1` 查询成功，精确命中“妈妈部落畅聊阁”，返回 `fakeid=Mzg5NTQzMTQxMg==`，与已知身份一致。
- “超链接”当前只显示“已发表内容 / 输入链接”；其自号 `appmsgpublish` 返回 `ret=0`、`publish_list=[]`、计数均 0，符合新注册账号无发表记录。不能将自号空列表当成目标号列表。
- 按该真实请求与已核对源码，把 `fakeid` 换成搜索返回的目标身份：13:32:09 首屏 HTTP 200、`base_resp.ret=200013`、`err_msg=freq control`；142.448 秒后用浏览器同源 fetch 仅复核一次，仍相同。没有文章列表，不请求下一页或判定完整结束。
- 当前第一方编辑器脚本还保留引用组件的 `appmsg?action=list_ex` 方法，但实际引用模板已没有他号搜索绑定。基于这个不同源码依据，于 13:35:44 用其参数做一次目标首屏验证，也返回 `200013 / freq control`。此后停止列表请求。两条路径合计三次目标首屏均未取得列表，不能推断微信所有列表接口永久关闭。
- 阅读/点赞独立验证：公开南模篇正文与身份通过，但指标赋值为空；本人在电脑微信打开后，既有授权范围内的近 30 分钟 HTTP 缓存仍没有该篇所需会话请求。没有发送伪造的指标请求，没有把空值写成 0。收藏没有可信来源，继续缺失。

本轮没有达到正式接入门槛，因此没有加入后台采集或指标适配器，没有为此迁移、写库、构建重启或提交。既有未提交修改完整保留。13:35 独立只读盘点与本轮新基线无差异：12 号、1425 篇，目标 180 篇、8 篇正文，四项漏采仍未解决。后台官方首页保留打开，空白编辑器已关闭，没有发布或保存内容。

脱敏实测证据：`output/playwright/mp-backend/`；独立数据库证据：`output/playwright/mp-backend-acceptance/`；指标证据：`output/playwright/article-metrics/`，均不提交 Git。详见 [后台源码研究](MP_BACKEND_RESEARCH.md)、[单篇指标研究](ARTICLE_METRICS_RESEARCH.md)、[独立验收](MP_BACKEND_ACCEPTANCE.md)。后续需要可返回目标真实近期条目与分页的列表来源，以及单篇真实指标响应；再次登录、重启或增加合集不能替代这两个条件。

## 本轮架构与实测结论（2026-09-27 12:56 起，优先于下方历史记录）

- 用户明确要求内置采集，拒绝将 WeChatDownload、其 MCP 或导出目录作为必要依赖。本轮未访问下载器、未调整 Defender、未改全局代理。下方旧记录中建议下载器授权的“下一步”已作废，仅作为历史审计保留。
- 用户已确认两张截图来自手机微信。“全部 / 贴图 / 文章”分类不能凭截图猜测四项漏采的具体类型。
- `node scripts/probe-builtin-channel.cjs` 直接请求微信第一方历史入口，使用请求级 `127.0.0.1:7890`。`profile_ext?action=home` 返回 HTTP 200、2138 字节验证页，明确要求在微信客户端打开，无 `msgList`；`action=getmsg` 首屏返回 HTTP 200、`ret=-3`、`errmsg=no session`，没有列表。**这是当前无会话请求受阻，不是接口全球或永久关闭的证据。** 没有复试此前 WeRead 的两条 -2041 列表接口。
- 证据在 Git 忽略的 `output/playwright/channel-builtin/summary.json`。仅公开参数和脱敏摘要；无凭据、无数据库写入。
- [wechat-article-exporter 的维护者说明](https://github.com/wechat-article/wechat-article-exporter/issues/200)于 2026-07-30 声称其核心后台接口受限并停止维护，Credential 路线未接入主流程。这属于项目方报告，不等于本机实测结果；用户没有公众号后台账号，也不将此路线当作已经可用的替代。
- [公开个人微信会话研究](https://github.com/tingaidehua/wechat-article-downloader-skill/blob/main/docs/protocol-principles.md)提供从本人微信网页缓存发现短期会话的思路，但其测试为 Mock，未给出目标公众号真实成功证据。本轮没有安装或运行该项目。独立探针提供显式授权模式，仅查看近30分钟的微信网页 HTTP 缓存、仅匹配目标 biz，避免聊天数据库/图片/附件；未获授权前不执行缓存读取。

### 本人授权后的真实结果（13:02–13:05）

用户明确同意受限读取，并已在电脑微信打开目标官方主页。探针只查看 `%APPDATA%/Tencent/xwechat/radium/web/profiles` 下路径含 Cache/Cache_Data 的近期 HTTP 缓存：154 个目录、7 个文件、32,046,456 字节，未触及预算；找到 1 个目标公众号会话候选。未读聊天数据库，不持久化会话值，仅向微信第一方发送。

1. 使用本人会话候选访问 home 得到 HTTP 200、34,408 字节页面，没有“请在微信客户端打开”门槛；微信返回 6 个会话 Cookie。页面内 `msgList` 是 `{"list":[]}`。
2. 将 home 返回的同源 Cookie 随列表请求回传后，`getmsg` 返回 HTTP 200、`ret=0`、`msg_count=0`、`can_msg_continue=0`、`home_page_list=[]`，没有 `general_msg_list`。本机已存 180 篇且手机截图显示近期内容，**这个空响应不能证明公众号为空或采集完成**。
3. home 实际引用的两份第一方脚本：[photo_account_profile/index80ec10.js](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/pages_new/photo_account_profile/index80ec10.js)（753 字节）、[appmsg/profile80ec10.js](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/appmsg/profile80ec10.js)（546 字节）调用微信 JSBridge 的原生 `profile`（scene 298），然后关闭网页。它们没有网页列表分页调用。文件 SHA-256 与行为摘要保存在 `native-profile-evidence.json`。
4. HTTP 200、Set-Cookie 和 ret=0 表明响应已改变，但不足以证明具有完整列表权限。两份脚本移交原生界面也不能唯一确定空响应的全部原因。这组结果说明**本次目标账号、会话和请求条件下，传统网页历史通道没有提供所需列表**；不能推导所有微信账号永久不可采集，也不能把再次扫码当成必然解决办法。独立 Edge 不提供微信原生 JSBridge，尚未发现可以满足本轮目标的独立浏览器授权路径。

实际证据：`output/playwright/channel-builtin/authorized-summary.json`、`native-profile-evidence.json` 和两份微信公开脚本。没有把授权 home HTML 或 Cookie 值写入文件；`home.body/getmsg.body` 是最早无凭据探测响应。

| 所需范围 | 本轮证据与边界 |
| --- | --- |
| 所选公开合集 | 既有32篇/4页有限通道；没有扩大合集或硬编码漏采链接 |
| 账号“全部”近期列表 | 未取得真实分页来源，验收失败 |
| 思维100、物理竞赛、四校八大、化学内容 | 均未取得目标号 canonical 身份；文章/贴图/转载/转发分类仍未核实 |
| 普通文章正文、RSS、Markdown及本地图片 | 现有缓存与导出保留，单独执行回归，不代表近期列表已完整 |
| 真实次条 idx>1 | 未取得样本，未验证 |

在取得真实授权分页前，不实现假扫码入口，不将合成数据或公开合集写成完整订阅成功。只有真实来源覆盖截图内容、分页终止与身份都验证后，才决定正式内置适配器。

## 早先调查（历史记录；其中下载器后续步骤已作废）


目标：妈妈部落畅聊阁，`MP_WXS_3895431412`。本报告只记录本次确实执行的通道检查。**截至 2026-09-27 12:31（Asia/Shanghai），用户已自行还原 WeChatDownload 4.7，主程序已启动，本地 MCP 已可连接并列出四个工具；凭据与真实全号采集尚未验收。另从该号公开合集取得 32 篇不同文章的真实列表，其中 13 篇在 2026-08-19 以后。公开合集不能保证全公众号历史完整，次条尚未取得真实样本，不能据此宣布完整订阅恢复。**

## 本机 WeChatDownload 当前状态

用户明确告知已自行还原主程序后，本轮只读核对了两个可见路径。实际物理文件为：

```text
C:\Users\ss\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\WeWe-RSS\WeChatDownload-4.7\windows\微信公众号批量下载工具4.7.exe
C:\Users\ss\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\WeWe-RSS\WeChatDownload-4.7\wechatDownload4.7.zip
```

主 EXE 大小为 36,121,088 字节。`C:\Users\ss\AppData\Local\WeWe-RSS\WeChatDownload-4.7\` 是在当前打包应用环境下也可见的逻辑路径，不能只用该路径指导用户查找物理文件。

主线启动程序并勾选“启动MCP”后，12:27:33 首次成功连接。本调查随后在 **12:27:44、12:31:30** 独立运行 `node scripts/channel-probe.cjs`，两次均得到 `initialize` HTTP 200 和下列工具名：`single_article_download`、`get_public_account_id`、`batch_download_articles`、`export_article_data`。没有通过该探测触发凭据获取、文章下载或数据库写入。**“程序缺失 / 4545 未监听”已不是当前阻塞；现在仍需本人完成微信凭据步骤，然后取得目标号真实分页数据。**

本轮没有恢复隔离文件、调整 Defender 设置、添加排除项、重新下载安装或改动 Windows 全局代理。工具运行与本地接口可达仍不能证明程序安全或采集成功。

## 早先隔离记录（保留历史，不作为当前阻塞）

2026-09-27 11:43–11:49（Asia/Shanghai）重新检查：

- `127.0.0.1:4545` 没有监听，向 `/mcp` 发送 `initialize` 被本机拒绝连接。
- 没有 WeChatDownload 进程或运行窗口。电脑微信正在运行，这不能证明下载器已启动或已有有效采集凭据。
- 预期文件 `C:\Users\ss\AppData\Local\WeWe-RSS\WeChatDownload-4.7\windows\微信公众号批量下载工具4.7.exe` 不存在；目录中只剩转换器缓存。
- Windows Defender Operational 日志记录：11:16:37（事件 1116）检测该可执行文件为 `Trojan:Win32/Wacatac.B!ml`；11:17:13（事件 1117）执行隔离成功，错误码 `0x00000000`。另一次早先解压目录也有同类隔离记录。
- 这解释了当时为什么无法启动本机 MCP。当时没有恢复隔离文件、关闭保护、添加排除项或重新解压运行；用户随后自行还原，见上方最新状态。

日志中的物理路径位于 Codex 包的 `LocalCache\Local\WeWe-RSS` 重定向目录，对应上述逻辑路径。此报告不包含微信凭据或原始账号日志。

## 官方发布与完整性核对

本轮调用 [GitHub 最新发布 API](https://api.github.com/repos/qiye45/wechatDownload/releases/latest)，返回最新正式版本仍为 [4.7](https://github.com/qiye45/wechatDownload/releases/tag/4.7)，发布时间 `2026-08-16T14:04:55Z`；仅有一个发布附件 `wechatDownload4.7.zip`，大小 87,710,472 字节。

本机 ZIP 与 GitHub API 给出的 SHA-256 一致：

```text
2f9dfb81f47ab82122f29beea05756d2f51cabc5eda4e1a24ecdc6f2e5292f48
```

哈希一致证明文件与官方发布附件一致，**不证明程序安全，也不能判定 Defender 属于误报**。未发现可直接改用的更新正式版。官方仓库目录树含说明、样本和调用 Skill，未提供可自行构建的本地采集器实现。

## 接口能力与替代边界

[官方 MCP 说明](https://github.com/qiye45/wechatDownload/blob/main/skills/wechat-article-downloader/SKILL.md)列出本地 `/mcp` 的四个工具：单篇下载、获取公众号凭据、批量下载、导出元数据。本地工具需要先在 UI 启用 MCP，获取凭据时还需要本人在电脑微信内置浏览器打开生成链接。

同一说明中，远程 MCP 只提供单篇和合集下载，没有本地凭据获取、公众号批量历史及元数据导出工具。因此它不能代替本次目标公众号的批量历史采集；本轮没有向远程 MCP 发送凭据。

官方仓库的 [问题 #587](https://github.com/qiye45/wechatDownload/issues/587)报告了微信 4.x 下获取凭据后页码仍为 0 的现象。这是其他使用者的报告，不能据此断言本机凭据无效、所有用户均无法采集或接口永久关闭。本机已越过程序启动和 MCP 就绪阶段，仍需实际凭据、翻页结果判断是否遇到同类问题。

### 已核实的最短接通流程与无界面限制

按上述官方 MCP 说明与 [README](https://github.com/qiye45/wechatDownload/blob/main/README.md)，采集时间范围、保存格式和目录依赖程序界面配置。本机实际 `tools/list` 显示 `get_public_account_id` 支持可选 `url`；批量下载和导出表格的参数对象为空，不能为它们臆造日期或 URL 参数。

12:28 主线向本机 `get_public_account_id` 传入目标公开文章链接，工具返回目标 `__biz=Mzg5NTQzMTQxMg==` 的公开 `profile_ext?action=home` 确认入口，界面显示“开始获取密钥”。已请求本人在电脑微信内置浏览器打开该入口。截至本轮核验，尚未确认取得密钥，下载目录没有 CSV/HTML 文章产物；该调用只证明验证入口已准备好。

本次所需的最少本人操作为：在电脑微信**内置浏览器**打开工具生成的链接，等待下载器显示“获取密钥成功”。链接由工具生成并复制，不需把凭据贴进聊天；Edge 打开不能替代微信打开。只有完成该步骤，才能验证批量下载及 CSV 实际产出。

12:31 核对官方仓库完整目录树、README 和调用说明：仓库仅含说明、示例及 Skill，没有本地采集器源代码，也没有文档化的命令行无界面启动参数或独立 MCP 服务入口。本次未对 EXE 猜测参数、反编译或改配置。已通过正常界面开启 MCP，不必为寻找无界面开关延误真实采集。

4.7 README 声称支持贴图号批量下载；因此截图里文章、转载、贴图、转发的区别需要保留到真实列表和原文核验，不能预设所有内容都是普通 `idx=1` 文章。该声明本身不算目标号通过验收，且官方 [问题 #572](https://github.com/qiye45/wechatDownload/issues/572)报告贴图 HTML 图片节点缺失，导出时仍需核对真实图片与正文。

官方仓库 [问题 #570](https://github.com/qiye45/wechatDownload/issues/570)还报告本地 MCP 只触发异步任务，无法直接返回结果文件 URL 或任务完成状态。本机验收应读取日志状态并核对实际 CSV/HTML/图片产物，不能将 `tools/call` 请求成功或“开始下载”当作完成。

## 可重复执行的就绪探测

```powershell
node scripts/channel-probe.cjs
```

脚本仅检查逻辑路径与 Codex 重定向物理路径的文件存在、ZIP 哈希，并向固定本机地址执行 MCP 初始化与工具列表读取；不获取凭据、不下载文章、不写数据库、不访问远程 MCP，只输出允许展示的摘要。`mcpReachable` 和工具存在都不能证明真实多篇采集成功。结果中的 `realAccountCollectionVerified: false` 明确保留此区别。

## 公开合集的真实多篇列表验证

同日 11:50 起，通过请求级别使用用户已有 `127.0.0.1:7890` 代理访问微信公开页面，没有改变系统代理，也不需要登录凭据。

1. [目标文章](https://mp.weixin.qq.com/s/K_oKauPpwhSyavBWQXFMKw)返回 HTTP 200、真实 `#js_content` 正文，页面引用“徐汇区”合集 `2527940920407949313`。
2. [存量第二篇文章](https://mp.weixin.qq.com/s/WmGmAEh19Bmu8Ah3MvtSSw)也返回真实正文，发现“复旦数学营”合集 `3588220544052641807`。只额外检查了两篇存量文章，另一篇返回无正文页面；没有扫全部 156 篇。
3. 按微信页面自身加载的 [官方客户端脚本](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)所用分页参数请求，成功读取两合集的所有分页，每页 `base_resp.ret=0`。

| 合集       | 页数 / 条数  | 结束标记          | 2026-08-19 后文章 | 次条 `idx>1` |
| ---------- | ------------ | ----------------- | ----------------- | ------------ |
| 徐汇区     | 2 页：10 + 3 | `continue_flag=0` | 1                 | 0            |
| 复旦数学营 | 2 页：10 + 9 | `continue_flag=0` | 12                | 0            |

32 条的 `(msgid,itemidx)` 无重复。最早发布时间 `2022-08-13T00:23:02Z`，最晚 `2026-09-26T05:20:52Z`。两合集覆盖了缺口中的部分文章，不能证明缺口已经补齐。按排序后的 `msgid_itemidx` 用换行连接再计算 SHA-256，结果为 `8b7afe7c9ed9705e3f88bdd7a99ce5a1399cbcf35caf9606fe006cff7f976041`，可复核此次列表集合。

实际可用请求：

```text
https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=Mzg5NTQzMTQxMg==&album_id=3588220544052641807&count=10&f=json
```

下一页保留同一合集参数，增加上一页末条的 `begin_msgid` 和 `begin_itemidx`。本次复旦数学营第二页是 `begin_msgid=2247493158&begin_itemidx=1`；徐汇区第二页是 `begin_msgid=2247483801&begin_itemidx=1`。需要同时使用这两个游标，文章唯一键也必须包括 `idx`。`f=json` 来自微信页面 AJAX 封装；缺少它会返回 HTML，而不是 JSON。

响应中的 `getalbum_resp.article_list` 包含 `title`、`url`、`msgid`、`itemidx`、`create_time`、`cover_img_1_1`；`getalbum_resp.base_info` 首屏包含合集名称、公众号名称与 `article_count`。本次文章条目**没有阅读量和点赞量**；`base_info.read_count` 是整个合集的阅读数据，不能当作任一文章阅读量。收藏仍未获取。

后端分页契约额外核对首屏声明的合集条数与该合集实际去重条数；不一致、游标循环、验证码 HTML、跨公众号条目、链接与 `msgid/idx` 不一致时中止，不能返回“完整采集”。`public-album.spec.ts` 的 17 项隔离测试覆盖这些分支、同一消息不同 `idx`、合集间去重，以及短链原文身份、代理和异常信息边界。测试里的 `idx=2` 是明确标注的合成数据，不能当作真实次条验收证据。

没有从检查过的页面脚本发现该公众号全部合集的公开枚举接口。`public_tag_link` 指向跨公众号话题页，不代表本公众号全部历史；不能用它扩大采集范围。

本机 TEMP 已保存目标真实正文、两合集首末页 JSON 供主线集成和独立验收。它们没有提交到 Git。此处完成的是“真实公开合集列表与翻页”验证；数据库重复采集、正文图片导出和 Edge 更新流程由后续端到端验收另行记录。

## 存量短链与合集长链的真实身份核验

首轮接入时发现 8 对疑似重复记录。本轮复用 2 篇已保存正文、限速请求另外 6 个旧短链接，8 篇均有真实正文；从原文提取 `biz/mid/idx/sn` 后，与数据库中新合集文章规范链接的四个字段逐一精确匹配，确认 8 对为同一文章。只读核验未修改数据库。

部分原文 `ct/create_time` 与合集 `create_time` 相差数十秒。例如最新目标文章的原文时间为 `1790400091`，合集为 `1790400052`，相差 39 秒；其他核验条目有 25、31、34、52 秒的差异。因此标题与时间相等不能承担短链、长链身份判定；相近标题与近似时间也不能作为安全合并依据，应使用原文对应的真实公众号、消息和次条标识。

本机证据文件 `TEMP\wewe-short-long-identities-20260927.json` 记录八篇的短链 ID、正文快照路径、公开文章标识、原文时间及规范链接匹配结果。文件仅用于本机身份核验，未提交 Git；未读取账号表或打印正文、微信会话凭据。

随后对编译后的 `resolvePublicArticle` 使用目标旧短链进行一次真实在线调用，返回 `WX_3895431412_2247493540_1`、原短链 canonical 与原文发布时间 `1790400091`，均与已保存证据一致。没有重新批量请求另外七篇。验证页、跨账号原文、canonical 不符、带凭据或外部代理均有拒绝回归测试；原始 HTTP 异常不会透传到错误提示。

最后仅检查上述八份已保存 HTML（零网络请求）：均无 `multi_appmsg_item_list`、`multi_appmsg`、`appmsg_list`、`other_article` 字段，`has_related_article_info` 均为 `0`。解码页面中静态微信长链接后，也未发现 `idx>1` 或同公众号同 `mid` 的兄弟次条。页面中的推荐或合集前后文链接不能证明同次推送；真实次条覆盖仍未验收通过。

## 继续验收所需条件

公开合集通道已得到真实验证，可以先用于有限范围的补漏。要完成整个公众号的历史与次条覆盖，还需要可验证的完整列表来源。本机下载器和 MCP 现已就绪，下一步是在配置目标文章后，由本人在电脑微信内置浏览器打开工具生成的链接，等待获取凭据成功；凭据无需复制进聊天。随后必须取得真实分页或导出数据，不能以“启动成功”“获取密钥成功”替代完整采集验收。

之后仍必须核对 `2026-08-18` 之后缺口的完整范围、同次推送次条，并进行重复采集去重、正文和本地图片导出、指标来源及 Edge 更新流程验收。导入样本、成功按钮或仅有 MCP 响应都不能替代这些验收。
