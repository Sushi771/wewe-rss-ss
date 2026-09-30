# 腾讯官方 Gateway 公众号能力复核（2026-09-30）

范围：只读核对腾讯公开 [`Tencent/WeChatReading`](https://github.com/Tencent/WeChatReading) 的固定提交、历史、文档与 issue，并与本仓已脱敏 Gateway 实测对照。本轮未读私有 `wrk-` Key、未调用腾讯、未重复 `/_list` 或已失败请求。公开仓库是 **Skill 调用说明**，网关服务端实现未在其中公开；“文档列出”不等于目标号当前成功回包。

## 版本与真正发送形状

2026-09-30 `git ls-remote` 得 HEAD [`315698a8da1810fab0bbf24a52b38a6960e54cdc`](https://github.com/Tencent/WeChatReading/tree/315698a8da1810fab0bbf24a52b38a6960e54cdc)，提交于 2026-07-01，Skill v1.0.4；仓库可达历史只有此前 2026-05-19 的 [`085b961` v1.0.3](https://github.com/Tencent/WeChatReading/tree/085b96186e57fcdbf3181f84a557c0a3da977a22)。v1.0.3 的 [`search.md`](https://github.com/Tencent/WeChatReading/blob/085b96186e57fcdbf3181f84a557c0a3da977a22/skills/search.md#L26-L42) **已列** `scope=2` 搜公众号、`scope=4` 搜公众号文章；v1.0.4 补充搜索分页、分组含义和 `deepLink` 描述，没有新增公众号列表接口。2026-09-15 的 [issue #12](https://github.com/Tencent/WeChatReading/issues/12) 是近期 API Key 故障报告，不是新增公众号能力的发布记录。

所有文档中的业务请求实际只发到腾讯 [`POST https://i.weread.qq.com/api/agent/gateway`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/SKILL.md#L29-L53)。`api_name` 放 JSON body 顶层，业务参数也平铺，`Authorization: Bearer $WEREAD_API_KEY` 使用本人 `wrk-` Key，body 带 `skill_version: "1.0.4"`；不是直接向 `i.weread.qq.com/book/articles` 发 `wrk-`，也不是把网关的 `api_name` 当作公开 REST 路径。仓库无本地 SDK 发送代码，真实可核的调用形状是这段腾讯发布的请求示例与规则。[`/_list` 的官方说明](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/SKILL.md#L77-L83)可发现账户当时可用操作；本仓此前已用本人 Key 一次取得 17 项，含 `/store/search`、`/book/chapterinfo`，不含 `/book/articles`，本轮没有重发。

## 对全号订阅能力的逐项判断

| `api_name` / 官方来源 | 文档承诺的字段与分页 | 对目标公众号的证据和界限 |
| --- | --- | --- |
| [`/store/search`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/search.md#L16-L53)，`scope=2` | `keyword` 必填；按**关键词**搜公众号。通用回包描述含 `results[].books[].bookInfo.bookId/title/author/deepLink`、`hasMore`、`searchIdx`，由上一页末项 `searchIdx` 传 `maxIdx` 翻搜索结果。[字段和工作流](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/search.md#L68-L110)。 | **可离线保留的新身份发现候选**：账号搜索与此前准确号名 `scope=4` **文章搜索**不是同一查询意图，理论上可能给另一种 `bookId`；但官方通用回包表没有 `biz`/微信号映射，也没有 `scope=2` 目标真实样本，故不能证明返回可核身份，更不能推断它与已试 `MP_WXS_3895431412` 不同。搜索分页不是该号全史分页。 |
| 同一 [`/store/search`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/search.md#L35-L53)，`scope=4` | 按关键词搜公众号文章；共享上述搜索结果分页描述。通用结果表给 `bookInfo`、封面/简介，没有文章原文、公众号完整发文流或已核原文发布时间字段。 | 本人以前以准确号名请求一次得到 HTTP **499**，未取得结果且已停止；不能把此文档当成新形状重发，也不能从 499 推断全局不支持搜索。 |
| [`/book/chapterinfo`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/book.md#L35-L60) | 输入 `bookId`，返回 `chapters[].chapterUid/chapterIdx/title/updateTime/isMPChapter`、`chapterUpdateTime/synckey`；未文档化目标公众号跨号历史分页、原始 `mp.weixin.qq.com` 身份、文章正文或图片。`chapterUpdateTime` 是目录更新时间，不自动等于每篇发文时间。 | 本人此前以目标 `MP_WXS_3895431412` 请求一次，业务成功但 `chapters=[]`。只有**另有一手来源给出不同且与目标 `biz`/已核文章身份明确关联的 bookId**，才构成新输入假设；目前没有，不建议重发同一 `bookId`、同一操作。`isMPChapter` 字段的存在只说明某些书籍目录可标识公众号章节。 |
| [`/shelf/sync`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/shelf.md#L16-L54) | Key 识别**本人**书架，`books[]` 可含公众号类书籍；`mp` 被腾讯明确描述为“文章收藏”目录**入口**，不含具体文章。无对任意未关注号的列表或订阅前全史分页。 | 可为个人书架中已有的公众号类书籍提供身份线索，但不能把 `mp` 非空当作文章列表，更不能自动覆盖要添加的任意目标号。 |
| [`/book/info`](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/book.md#L7-L33) | `bookId` 对应书籍标题、作者、封面、简介、`publishTime` 等**书籍元数据**。 | 无目录/文章正文。`publishTime` 不能当作各篇公众号文章发布时间。此前目标目录为空后，本人没有发第二个 `/book/info` 请求。 |

由此可精确区分：官方文档**支持公众号和文章关键词搜索**，也描述带 `isMPChapter` 的某些书籍章节目录；但固定版本及本目标已保存实验未证明“添加任意号 → 列表 → 跨号订阅前全史 → 按发文时间稳定分页 → 正文图片”的完整链。搜索分页按 `maxIdx` 翻**搜索命中**，不保证一个号的文章穷举或稳定增量；章节目录无针对该号历史的分页约定；本仓目标 `MP_WXS_*` 已试为空。官方文档未给可取公众号文章全文/图片的 Gateway `api_name`，书籍 `intro`、笔记原文或搜索摘要都不能替代文章正文。2026-09-30 审查的 [open issues](https://github.com/Tencent/WeChatReading/issues) 未给该目标的成功列表或新文章操作，且仓库没有当前线上响应夹具。

## `wrk-` Key 生命周期与近期故障报告

腾讯 [README:13-22](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/README.md#L13-L22) 指向本人登录的 `weread.qq.com/r/weread-skills` 获取 Key，格式 `wrk-`、绑定用户身份；[Skill 鉴权说明](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/SKILL.md#L36-L53)说网关自动注入 `vid`。公开两版文档未列 Key 有效期、自动刷新、轮换、撤销或从 Web Cookie/原生 `skey` 转换的接口。`skill_version` 与响应的 `upgrade_info` 用于 **Skill 版本升级**，不是 Key 续期。本人已有 Key 曾成功列出操作，证明该次网关认证可用，不能推断永久有效或其他 `api_name` 的目标数据可用。

[issue #12](https://github.com/Tencent/WeChatReading/issues/12) 的用户称在 App 内生成 5 个 Key 后，`/_list` 和 `/store/search` 均返回 `-2010`；其“通过签名校验/存在灰度”的解释是报告者推测，页面截至本次审查仍开放且无维护者答复。该个案不能外推到本人 Key，也提示文档所述网页获取流程与其他生成入口的行为可能不同；不能靠反复生成 Key 或重试目标请求来猜认证规则。

## 可继续的离线判别

`scope=2` 是本轮唯一值得保留的 **Gateway 身份发现假设**，不是已证的全号订阅路径。先查可公开核验的 `scope=2` 真实回包或 SDK 测试夹具，确认公众号结果是否给 `bookId`，该 ID 与已试 `MP_WXS_3895431412` 是否实质不同，且能否由 `biz`、可信文章链接或腾讯自身元数据交叉确认目标身份。缺这些证据时保持离线；不重发已试的 `scope=4` 准确号名搜索和同一 `MP_WXS_*` 的 `/book/chapterinfo`。即使发现新身份，再由总控按一次低频只读请求核对该新 ID 的目录，并将真实发布时间、分页、正文图片单独验收。

本结论只覆盖官方 Gateway 已公开的 v1.0.3/v1.0.4 材料和本账号此前请求；不推出腾讯以后不会增加能力，也不替其他腾讯端点下结论。
