# 文章来源复核（2026-09-27）

## 2026-10-02 有限近期源码复核：没有新增可执行的完整列表条件

本轮只读公开 GitHub 源码/元数据，不登录新服务、不提交凭据、不请求已停止的微信端点。原始请求与历史范围不变，不能将此有限检索扩大为全网或永久无解。

四个已有上游再次核对：we-mp-rss仍126993c，Pengyf04/weread-mp-fetcher仍3944db5，weread-omni仍88bd2e0；wechat-article-exporter新增[152f238与a7bffa6的公开对比](https://github.com/wechat-article/wechat-article-exporter/compare/a7bffa6e481a188510a701d30b399b76573434e5...152f23832c7f3664b86148e84bd3f75e513e4dd2)，只有README改3增6删，外链取阅，没有采集代码修复。README声称实时推送群发，不能据此证明可自建、任意目标完整近期覆盖或批量历史。网页工具无法打开取阅，本轮未注册或运行服务，不断言其后端绝对闭源。

一次GitHub仓库查询 `wechat rss in:name,description pushed:>=2026-09-27`，按更新时间取最多15项，返回10项、incomplete_results=false。只检查此次匹配集合，不声称穷尽所有语言、名称或项目。README取8份、2份不可用；进一步读公开树、实际采集/工作流文件如下：

| 项目                                                                                                                                       | 已核的实际来源/结论                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [imoyao/WeChatRSS 固定355a299](https://github.com/imoyao/WeChatRSS/blob/355a2994c7a3f57384cefa4f16a98b85c2a8b988/src/gen_rss.py)           | 仍调用profile_ext?action=getmsg；声称后台Cookie的data_ticket/slave_sid及可选MP_TOKEN即可，未提供可信新认证来源/转换。无MP_COOKIE只生成空RSS且没有非零退出；失败也会覆盖RSS。代码SHA256=6b24a52eb1ed6c6f3610cd4cde2616d235f0bccbe0ce5ee669f6656d82c6e648。不能移植其覆盖旧有效数据的行为。 |
| [Sunnie666/wechat-rss 固定8e921e9](https://github.com/Sunnie666/wechat-rss/blob/8e921e9538ff96ca4aa887452b19e5633878192c/main.py)          | getmsg只带User-Agent，不发Cookie/token；只有offset0/count10，无分页循环，把general_msg_list当对象并捕获失败返回空数组。没有解除本机no session/空列表停止的新条件。                                                                                                                        |
| [zorba123456/wechat-rss 固定dc4e071](https://github.com/zorba123456/wechat-rss/blob/dc4e0711bdd858949de819b8bcde4eee8ddc0692/test_feed.py) | 测试生成test_article_123等假链接，不能作为真实发现证明。                                                                                                                                                                                                                                  |
| [sl00p/wechatrss](https://github.com/sl00p/wechatrss)                                                                                      | 树只显示README与XML，未提供可自建采集核心；完整7124字README精确目标妈妈部落畅聊阁/苏洵书院均未匹配，不能推成全网未收录。                                                                                                                                                                  |
| [Alex-Xu192/wechat-rss-monitor](https://github.com/Alex-Xu192/wechat-rss-monitor)                                                          | README不可用，树含归档/通知工作流；未取得足以验证独立账号级列表的证据，保持未知而非宣称不可用。                                                                                                                                                                                           |
| [yonglee1979-ai/wechat-rss-workbuddy-ima](https://github.com/yonglee1979-ai/wechat-rss-workbuddy-ima)                                      | 消费WeChatRSS token，要求微信客户端同步，是下游入库教程；没有新增独立采集核心。                                                                                                                                                                                                           |
| [osnsyc/Wechat-Scholar](https://github.com/osnsyc/Wechat-Scholar)                                                                          | 提供特定学术目录的公开RSS，README未提供任意目标的可自建采集核心或本项目目标验收。                                                                                                                                                                                                         |
| [X-skyy/my-wechat-rss](https://github.com/X-skyy/my-wechat-rss/blob/main/.github/workflows/main.yml)                                       | 工作流写三条RSSHub链接到Markdown，没有实现采集。                                                                                                                                                                                                                                          |
| [zhuangjunhong21-blip/wechat-rss-feeds](https://github.com/zhuangjunhong21-blip/wechat-rss-feeds)                                          | README自述仅消费总线和既有结构化数据，不含采集实现。                                                                                                                                                                                                                                      |
| [ouroboros771/wechat-daily](https://github.com/ouroboros771/wechat-daily/blob/main/.github/workflows/update-feed.yml)                      | curl下载Secrets.WECHAT_RSS_URL并检RSS文本；真正上游未知，没有提供独立采集代码。                                                                                                                                                                                                           |

imoyao固定树含206个XML，271–321字节；[二鸟说样本](https://github.com/imoyao/WeChatRSS/blob/355a2994c7a3f57384cefa4f16a98b85c2a8b988/feeds/%E4%BA%8C%E9%B8%9F%E8%AF%B4.xml)277字节，lastBuildDate为2026-10-01，但XPath `/rss/channel/item`计数0。最初PowerShell属性`.item`误得到方法适配值，改用XML SelectNodes复核为0；不把文件更新日或错误属性计数当文章数。没有逐个拉取206份，因此不声称所有条目均实测为空。仅这一样本与代码无凭据/失败也发空RSS，已足以拒绝以仓库近期更新/CI绿灯为完整列表成功证据。

getmsg不是尚未测过的新路径：本项目[历史通道核验](CHANNEL_INVESTIGATION.md)已记录无会话ret=-3、正常既有候选会话下ret0但空列表，且第一方脚本转原生profile。上述源码不提供解除停止的新合法条件，不拿后台Cookie、Web读书Cookie或SDKtoken混用，不重发、不复制其失败时覆盖旧文章的逻辑。

Antigravity agy-75f05b6e（固定Gemini 3.8 Flash High、无工具）28秒完成。其对现有文档的“尚无独立已证列表路径”经总控审核；其声称自己核了实时仓库、断言新SDK必定不能改变列表结果、遗漏book/articles已有401的表述未采纳。实时元数据和源码判断来自总控实际读取；SDK授权仅是未实测resolver的前置条件，不保证目录恢复。

下一步仍分别缺本人合法新mobile会话与独立完整近期列表来源。不要再写包装器、扩UI或重复同一来源研究来冒充替代完成；已提交的单次resolver探针必须待本人正常SDK授权才能执行，列表完整性另行验证。现有生产、原4000登录正文图片链路不变。

## 2026-09-28 最新：客户端登录差异已追溯旧实验

生产 Web 登录与 weread-omni 客户端登录确有代码差别，但旧独立实验已经测试后者同类完整链路，不能据生产代码误判它从未试过。[完整客户端审计](WEREAD_CLIENT_FLOW_AUDIT.md)记录源码校验、原命令证据及逐项比较；续期后首屏 -2041，未发现实质新条件，本轮不重试。用户明确停止电脑微信 UI/剪贴板/滚动/抓包；当前先验 5 篇、分页和正文后接入，不部署中转。

## 18 时状态补记

本轮没有新的来源请求或覆盖通过证据。电脑微信采集器完成离线修复，但用户 Esc 暂停仍有效，单篇恢复授权待答复；修复后尚无真实 UI 验收。已知证据仅来自“文章”页，贴图等类型及 idx>1 覆盖未证明；不得称所有类型完整。见 [修复检查点](DESKTOP_COLLECTION_REPAIR.md)。WeRead、后台及第三方目录的既有结论继续有效，无新依据不重复请求。

## 当前有效范围：每个订阅源最新 20 篇

用户已将目标从全部历史调整为每个订阅源最新 20 篇，并明确授权先验证免费第三方来源覆盖。下文早期研究中的“必须全历史到终点”属于旧范围，不再作为排除近期 RSS 的理由。仍须证实真实账号身份、最新文章、展开主次条后的 20 篇覆盖与持续更新；不能拿任意旧 20 篇、20 个群发组或有限合集冒充最新 20 篇。若来源只覆盖特定类型，须明确缺项，不能静默略过。既有文章、ID、正文和有效指标继续保留。

## 旧 PLATFORM_URL 中转能否自建：公开证据

原项目 [README](https://github.com/cooderl/wewe-rss) 给出的 Docker、本地和 Compose 部署是 WeWe RSS 应用，`PLATFORM_URL` 默认仍指向作者的 `weread.111965.xyz`；项目公开部分为 MIT。GitHub 当前标记原仓库于 2026-05-11 归档。不能把应用能自托管解释成作者的采集基础服务也已提供自建包。

[作者在 issue 11 的回答](https://github.com/cooderl/wewe-rss/issues/11#issuecomment-1973151621) 表示 token 从该服务生成、服务做请求转发，并说绝大部分代码已开源。公开信息可以支持“它参与登录 token 流程与请求转发”，不能进一步断言只是 Nginx 透传，也不能确认内部具体的设备协议、签名算法、密钥、账号调度或所谓风控对抗实现。issue 11 中其他人的设备/账号猜测不是可验证的作者说明。

[issue 249](https://github.com/cooderl/wewe-rss/issues/249) 与 [issue 364](https://github.com/cooderl/wewe-rss/issues/364) 分别要求公开中转核心和 skey 生成方法；本次通过公开 GitHub API 读取全部评论，没有作者给出中转源码或部署方式。作者当前 6 个公开仓库中也没有单独的 WeRead 中转项目。准确结论是**本次未找到可复现原中转的公开源码、部署包或单独许可**，不把搜索结果扩大成绝对不存在。WeWe RSS 的 MIT 不等于未发布的中转实现已可取得。

[作者 issue 223](https://github.com/cooderl/wewe-rss/issues/223) 说明原域名经 Cloudflare 加速，[issue 320](https://github.com/cooderl/wewe-rss/issues/320) 把 `weread.965111.xyz` 称为加速镜像域名；这是同一基础服务的访问入口，没有证据说明替换域名会更换采集来源。

所以可以自行开发一个兼容 `PLATFORM_URL` 的服务，但它必须自己完成实际登录/会话、文章列表与错误转换等工作；普通反向代理转向已停用旧站仍依赖旧站，直接转向微信也不能凭空补齐两边不同的 API 协议或解除已实测的 `-2041`。决定是否值得实现的前置条件仍是一个真实返回目标最新 20 篇的上游通道，不能以中转服务器启动成功代替采集成功。本轮没有部署、请求旧中转或发送任何凭据。

原始公开证据保存于 `output/playwright/complete-source-research/relay-issue-11-comments.json`、`relay-issue-249-comments.json`、`relay-issue-364-comments.json` 和 `relay-author-repos.json`。主线负责本地调用代码核查，本研究未重复其工作。

本研究仅访问免费公开文档和索引；没有交付微信凭据、注册或付费、发送带授权微信请求、安装外部下载器或写生产库。免费第三方覆盖验证已获授权，付费与凭据交付没有获授权。

### 免费公开索引核验结果

- [Wechat2RSS 完整公开列表](https://wechat2rss.xlab.app/list/all)：当前列表未找到“妈妈部落畅聊阁”；“妈妈”“部落”“苏洵”也无匹配。最新 20 篇窗口现已符合数量范围，但目录没有目标号，仍未取得可验收目标源。其自部署依赖 WeRead，不能承诺解除本机会话受限；公共源使用运营方采集环境，不等于必须交出用户会话。
- [Feeddd 官方仓库](https://github.com/feeddd/feeds) README 明确项目于 2023-07-05 关闭。[公开 RSS 索引](https://raw.githubusercontent.com/feeddd/feeds/master/feeds_all_rss.txt) 本次可读，共 46,020 行，检索“妈妈部落”“畅聊”“苏洵”均无匹配。该静态索引不能证明当前持续更新，也未给两个目标提供已知源；没有为不存在的条目猜测 feed URL。Hamibot 专用版是另一种自行采集安排，未安装或用其替代内置订阅。
- 上述是具体目录与精确关键词的有限检索结论，不能推出全网不存在目标 RSS。主线另核验 Mp2RSS/WechatRSS，另一来源代理负责自由微信/搜狗，避免重复研究。

当前本线未取得两个目标中任何一个可验证的最新 20 篇公共源。后续若找到已知公开 feed，成功判据是账号身份正确、原文链接可核对、日期排序及最新漏项覆盖正确，并能提供足够 20 篇展开后的文章；无需再要求完整历史终点。

主线随后共享的公开核验结论（本研究未重放请求）：Mp2RSS membership 仅列付费月档 49/99/399，试用由运营决定，不能认定永久免费；waytomaster 的 WeChatRSS 当前 pricing 显示可同步的数据来自微信数据库且同步需付费，免费仅支持 2 号输出，因此不满足当前不读聊天数据库、免费来源覆盖验证的边界。`wcrss.com` 公共脚本 `index-CpPYhVtM.js` 提供 `api.wcrss.com/api/publishers/search?q`；主线一次不带会话的目标搜索返回 HTTP 500、`{"error":"Search failed"}`，未取得目标条目，不重试、不将服务失败写成未收录。脚本证据位于 `output/playwright/latest20-research/wcrss-public.js`。上述失败或套餐限制均不是目标最新 20 篇已验证。

本轮仅研究文章发现与完整分页，不研究互动指标。已完整读取任务、交接、后台源码研究、后台独立验收与历史通道调查。研究只读公开源码及已有第一方脚本，不操作后台浏览器、不读取会话、不请求微信列表、不写生产库。真实验证由主线统一执行，本文的源码发现均不等于目标号采集通过。

本机公开研究副本位于 Git 忽略目录 `output/playwright/complete-source-research/`。其中包含公开 GitHub API 元数据、固定版本源码和第一方脚本限定上下文；不含本人 Cookie、token 或后台响应原文。

## 最新真实 reader 结果（14:41，优先于下方候选记录）

已独立读取主线 `output/playwright/reader-live/shelf-summary.json` 与 `first-page-summary.json`。研究代理未重放请求。

| 步骤                                                             | 本地时间                | 已核实结果                                                                                                         |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 本人稳定官方 Edge 登录后读取 Web 书架                            | 2026-09-27 14:41:21.898 | HTTP 200，顶层有 `books`，无业务错误；目标 `MP_WXS_3895431412` 存在，返回真实 `deepLink` 和阅读器哈希              |
| 导航真实官方 reader 后，由第一方页面自动发送目标 `offset=0` 首屏 | 2026-09-27 14:41:53.124 | HTTP 200，`errCode=-2041`、`errMsg=-2041`；顶层字段仅 `errCode/errMsg/errLog/info`，无 `reviews` 数组、无 `length` |

本次已满足此前尚未验证的“本人官方浏览器登录、真实 reader 页面上下文”条件。目标首屏仍未返回文章，因此这项候选现在是**在本次真实 reader 条件下实测受限**，不再是尚未测试。主线记录只发生第一方自动发出的这一次列表请求；没有手动发送列表、下一页或重复尝试。无首屏意味着近期漏项、主次条、内容类型、下一页和历史终点均未通过，不能写成 0 篇或完整结束。

这一结果不同于旧 Node axios 加首页 Referer，以及 `localhost:4001` 人工验证后的代理请求。书架成功证实这次账号会话可读本人书架，不能进一步推断列表权限有效。`-2041` 不能据此被唯一解释为登录过期、频控时长或永久关闭；也不能承诺换账号、等待或重复扫码可恢复。

离线复核旧第一方 `app.88f998b2.js` 的 GET/POST 请求封装发现：浏览器端收到 `-2041` 时有加载 `https://captcha.gtimg.com/TCaptcha.js` 并展示 `TencentCaptcha` 的分支；本人成功完成验证后，第一方代码会携带验证头重发原请求。这是**具体的第一方交互分支**，不是自动绕过方案。当前页面是否实际弹出、加载是否成功、本人是否完成以及验证后列表是否成功均须单独实测。本研究没有调用验证脚本、取得验证值或请求重发；若页面已有该脚本标签，旧代码并不在此分支重新创建弹窗，不能把无弹窗解释成已通过。禁止在本地另造验证页面或靠猜参数重放失败列表。

离线限定上下文见 `output/playwright/complete-source-research/reader-public-challenge-contexts.json`，不含本人的验证码票据。主线可只观察官方页面自然提供的本人验证入口；没有可见有效入口或新的成功条件时，不重复请求。

后续状态更正：主线检查官方 reader 的 iframe 和页面截图，确认腾讯验证码已自然显示；`body.innerText` 未包含 iframe 内容，不能据此说没有入口。随后用户报告反复验证仍无法进入。本轮按此新反馈停止所有授权请求，不继续以刷新、再次扫码或重复验证探索。此前的“等待本人完成验证码”不再被当成可承诺成功的下一步。

## 用户询问其他订阅路线后的公开复核（已按最新 20 篇更新）

本节只浏览公开一手文档，没有登录其他服务、购买、提交订阅或发送微信请求。

- **Wechat2RSS 的 20 篇窗口符合新数量范围。** [官方使用指南](https://wechat2rss.xlab.app/deploy/guide) 明确使用微信读书获取公众号信息；[官方 FAQ](https://wechat2rss.xlab.app/deploy/qa) 明确只抓最新 20 篇、不回溯历史，而且只收录群发消息。不能因更换产品就认为会绕开现有限制，但也不能再以不回溯历史排除它；目标公开源尚未找到，群发以外内容覆盖仍未证明。
- **Mp2RSS 托管服务的现有近期覆盖须实测。** [官方介绍](https://github.com/areyoubugcoder/Mp2RSS) 声称不需要用户微信账号；但 [FAQ](https://areyoubugcoder.github.io/Mp2RSS/guide/faq) 明确首次订阅不会回溯历史，仅开始收录后续内容。这可能支持后续积累最新 20 篇，却不能证明首次就返回已有最近 20 篇。公开仓库主要是文档，没有可审查采集后端，不能证明它使用独立来源，也不能承诺目标贴图、非群发及转发齐全。由主线进一步核验，本线不重复请求。
- **官方管理 API 需要目标运营方授权。** [获取已发布消息列表](https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_batchget.html) 的既存第一方 HTML 已重新核读：接口使用账号的 `access_token` 或正式授权后的 `authorizer_access_token`（权限集 7），请求没有任意他号 `fakeid/biz`。账号适用表中公众号仅企业主体认证账号可用。本人新注册个人后台不提供其他公众号的管理权限；该路线只有目标运营方愿意提供自身官方 API 授权或正式供源才改变前提。

结论：本线公开复核尚未找到可直接验收两个目标最新 20 篇的免费源。近期 RSS 已是合格候选范围，下一步应围绕真实目标覆盖验证；不再要求供应方提供全部历史。现有合集可保留为有限范围更新，但不能以其任意 20 篇替代全号最新 20 篇。

## 上游最新状态

实时 GitHub API 核对结果：

| 项目                                   | 当前固定提交                               | 提交时间 UTC        | 结果                                           |
| -------------------------------------- | ------------------------------------------ | ------------------- | ---------------------------------------------- |
| rachelos/we-mp-rss                     | `126993c81a00466e9a6bbab041eef34ab27abe9c` | 2026-09-24 01:27:27 | 与上一轮研究相同，无新后台修复                 |
| wechat-article/wechat-article-exporter | `a7bffa6e481a188510a701d30b399b76573434e5` | 2026-08-07 05:45:46 | 与上一轮研究相同                               |
| Pengyf04/weread-mp-fetcher             | `3944db5e6df3dfb7c12d1ac2fddb902361cbc781` | 2026-08-13 09:40:09 | 提供阅读器上下文的具体源码依据，见下文         |
| yeximm/Access_wechat_article           | `412b4a6d2f5005f01f70b20ad1c8530849eaafd3` | 2026-08-23 08:22:11 | UIA 滚动与单篇捕获，没有新的完整列表 HTTP 协议 |

[we-mp-rss PR 470](https://github.com/rachelos/we-mp-rss/pull/470) 仍未合并。它修复遇到 `200013` 后降级流程不可达及回调重复，作者成功声明使用的是 WeRead 通道，没有恢复后台他号列表的证据。[PR 462](https://github.com/rachelos/we-mp-rss/pull/462) 使用既有 `/web/mp/articles`，遇到 `-2041` 等错误仍回退封面；其遇见已入库文章即停止的策略也不足以修补旧封面时期的任意历史缺口。两者不构成本机重放已失败后台请求的理由。

## 第一方转载列表：确有不同端点，但范围不足

对上一轮当前编辑器实际加载的 67 份微信第一方脚本进行限定检索，没有找到 we-mp-rss `free_publish.py` 声称的 `/cgi-bin/free_publish` 或 `/cgi-bin/publish` 调用。一般文章列表仍是已实测失败的 `appmsgpublish` 与 `appmsg`。

另在 `output/playwright/mp-backend-research/firstparty/script-66.js` 的转载组件找到不同列表动作：

```text
POST /cgi-bin/operate_appmsg?sub=can_reprint_biz_list
data: begin, count

POST /cgi-bin/operate_appmsg?sub=biz_ori_list
data: biz, begin, count
```

入口为转载弹窗的 `bizArticle` 分支。`biz` 来自前一接口返回的可转载账号卡片 `.js_go_page2` 的 `data-biz`；不是搜索任意公众号的字段。源码读取 `B.list`、`B.total`、`B.base_resp.ret`，成功时按实际返回的 `list.length` 推进偏移。组件还显示转载可修改、可隐藏来源等白名单权限。

因此，这是一条有第一方依据的**转载授权范围内原创文章列表**，不是任意公众号全部公开内容列表。未请求该接口。若主线在实际 UI 中看见目标号被授权，可只读验证该范围；不应为了尝试而向接口硬塞任意 biz。即使返回数据，也必须单独证明近期漏项、下一页及其类型范围，不能把不含贴图、转发或非原创的列表标成全号完整。源码中的 `articlestruct?action=GetContent` 是已知消息正文读取，其他 `operate_appmsg` 搜索多为小程序、地点或已知 URL 解析，也不提供全号发现。

## WeRead 阅读器上下文：实测前的新线索记录

[weread-mp-fetcher 的固定版本 scripts.mjs](https://github.com/Pengyf04/weread-mp-fetcher/blob/3944db5e6df3dfb7c12d1ac2fddb902361cbc781/lib/scripts.mjs) 中 `buildPageJs` 在真实阅读器页中执行：

```text
GET /web/mp/articles?bookId=<公众号ID>&offset=<群发组偏移>
fetch credentials: include
```

它明确要求 `location.pathname` 以 `/web/mp/reader/` 开头。`PROBE_JS` 检查阅读器页面、可见验证码及加载状态。[bin/weread.mjs](https://github.com/Pengyf04/weread-mp-fetcher/blob/3944db5e6df3dfb7c12d1ac2fddb902361cbc781/bin/weread.mjs) 优先复用已有阅读器标签页，否则从本人 `/web/shelf/sync` 返回 `deepLink` 的 `v` 获取真实阅读器 URL。不能自造 URL 哈希，也不能仅伪造 Referer 代替实际页面上下文。

作者声称首页上下文会导致 `-2041`，但这仍是第三方运行报告，不能直接诊断本机会话。独立验收随后核对旧聊天：此前 Web 列表请求使用 Node axios 及首页 Referer；官方阅读器只做过无会话 HTML/JS 下载，人机验证在 `localhost:4001` 完成；未执行真实官方阅读器页面的同源 `fetch`。因此“实际阅读器页面上下文”已被确认是与旧失败实验不同的条件，允许形成下一次验证假设，**尚未证明可用**。旧 `/mp/chapters` 的 `synckey=0` 首屏已经失败过，不能作为新参数实验重试。研究代理没有操作浏览器或登录。

成功判据仍是：首屏含目标近期真实漏项，并取得有效下一页；随后持续翻页到真实结束。其 `reviews` 是群发组，必须展开每组全部 `subReviews`。本仓库 README 明确报告部分公众号在 WeRead 收录滞后；项目默认页数上限只适合近期监控，不能原样作为全历史采集。即使某账号返回列表，仍需核对贴图、转发事件及完整历史，不得因 WeRead 的结束响应推断源公众号已全收录。

源码许可为 MIT；本轮未移植或执行。不能复制其全部失败不计请求预算等缺陷，也不能用刷新或验证码状态正常代替采集成功。

## Access_wechat_article：当前边界不适用

[固定版本 home_scan_service.py](https://github.com/yeximm/Access_wechat_article/blob/412b4a6d2f5005f01f70b20ad1c8530849eaafd3/src/services/main_flow/home_scan_service.py) 使用 Windows UIA 读取公众号主页日期组、展开“余下 xx 篇”、滚动及观察懒加载。它不提供可直接调用的完整文章列表端点。后续单篇点击与 [wechat_request_matcher.py](https://github.com/yeximm/Access_wechat_article/blob/412b4a6d2f5005f01f70b20ad1c8530849eaafd3/src/modules/proxy/wechat_request_matcher.py) 捕获 `/s` 原文请求配合，README 明示 MITM、系统代理与 CA 配置。

该项目还将滚动后无新增 UIA 快照作为停止原因之一，这不是服务器真实终点证据。当前用户禁止改全局代理和证书，且不接受外部下载器作为订阅依赖，因此没有安装或运行该项目。其许可证为 CC BY-NC-SA 4.0，与上述 MIT 项目不同；未复制实现到生产源码。

## 实测前的阶段结论（由文首结果更新）

没有取得真实近期列表或下一页，不得声称完整采集已修复。WeRead 真实阅读器上下文已经通过旧实验条件排重，但仍待实测；再次扫码、冷却或仅改 Referer 不构成该验证。主线本轮计算机控制因无法可靠确认后台窗口 URL 而停止输入；不能把这一工具边界写成上游拒绝或候选失败。后续须先取得可明确识别的官方阅读器窗口与有效会话，再进行有界的一次首屏验证。转载白名单列表是不同的有限授权范围，不能承接全部公开文章目标。原生客户端路线由另一代理独立审查，见 `COMPLETE_ALTERNATIVE_RESEARCH.md`，避免重复实验。

必要访问条件与本轮权限边界：

- 后台转载列表需要目标号对本人后台提供对应转载授权；本人注册个人公众号及搜索得到目标号，不构成该授权。没有要求用户新增白名单，也没有请求该列表。
- WeRead 线索需要本人有效阅读器会话以及可访问的目标阅读器页面；本轮优先复核旧证据，不要求再次扫码。若需要读取尚未授权的新书架内容、其他浏览器配置或其他敏感范围，须先说明具体对象、仅本机处理及仅向微信第一方发送的方案并取得授权。不能从新仓库默认行为推导用户已允许读取整个默认浏览器配置。
- Access_wechat_article 原样运行需要 Windows UIA、持续可见客户端、MITM 和系统代理/证书配置；后两项与本轮明确边界冲突，未作为等待用户批准即可执行的方案。

## 获准 reader 最小实验后的协议复核

用户随后授权主线执行 reader 最小范围实验。本研究代理仅复核源码和主线待运行脚本，未读取账号库、本人凭据或发起带授权请求。授权不改变首屏、下一页和全历史的成功判据。

固定 fetcher 的 `LIST_SHELF_JS` 提供的入口是 `https://weread.qq.com/web/shelf/sync?synckey=0&teenmode=0&album=1`，在浏览器页面中使用 `credentials: include`。先检查顶层 `errCode`，成功响应应有 `books` 数组；仅在内存筛选已授权目标的 `bookId/title/deepLink`，从真实 `deepLink` 查询参数 `v` 获得 `/web/mp/reader/<v>`。没有目标或没有合法 `v` 应分别报告，不能猜哈希或自动新增书架订阅。

`/shelf/sync` 与上述 Web 路径不同：另一研究线已经下载的 weread-omni `docs__endpoints.md` 将它列作 Eink 2.1.2 API，网关为 `i.weread.qq.com`。它使用客户端认证及 `lectureSynckey/onlyBookid/synckey` 等参数。旧客户端书架成功不代表 Web 书架请求必然成功，两者也不能无条件互换。

没有源码证据证明一组“最小必需 Cookie”足以得到 reader 列表权限。fetcher 使用浏览器完整同源 Cookie，不抽取最小集合。本项目 `WereadService` 将登录响应映射到 `wr_vid/wr_skey/wr_rt` 并保留 `Set-Cookie`；这些是本项目已有处理，不是上游保证。复用已有 `wr_*` 会话与官方完整浏览器登录的等价性仍需实际页面验证。

通过独立验收提供的确切路径，仅重新读取旧公开 JS：`TEMP/wewe-weread-public-js/19.42e251bc.js`、`app.88f998b2.js`、`wpa-1.0.5.js`。主 bundle 确有 `/web/mp/reader/:infoId` 路由；本次限定字面检索未找到书架 URL 或 `deepLink`，文件混淆且可能缺少书架 chunk，因此不能把未命中理解成不存在。`wr_vid/wr_skey` 的字面命中是日志或调试清 Cookie，不能证明最低会话要求。限定摘要在 `reader-public-literals.json`，没有执行这些公共脚本。

主线实验脚本的只读审查指出：若为限缩访问而阻断页面其余全部 XHR，也会阻断正常的会话续期或初始化。此时书架失败只能说明“复用既有 Cookie 的受限实验未取得数据”，不能证明完整官方 reader 路线失败。新增放行必须以实际观察的第一方请求用途为依据；不得为了测试放开任意域或自动重试列表。

## 本人登录稳定官方 Edge 后的响应与分页判据

用户随后已经本人登录稳定的官方 Edge。这是新的会话条件，实际书架与列表请求仍由主线独占，本研究代理不重放。登录成功仍不等于取得目标号列表。

重新只读核对固定 fetcher 与已保存第一方 reader 脚本后，给主线的证据要求如下：

- 首屏保留 HTTP 状态、业务码、响应顶层字段名，以及 `reviews` 是否真实存在并为数组。错误响应、缺字段、JSON 解析失败不能降格成空列表。
- `reviews` 是原始群发组，`subReviews` 是组内文章；保留每组原始子项数并展开全部子项。无 `title`、无 `mpInfo`、未知内容类型均要计数报告，不能照抄 fetcher 的 `if (!mi.title) return` 静默丢弃。
- 下一页偏移按原始群发组累计数量推进；不能按文章展开数、解析成功数或去重后的数量计算。记录每页输入偏移、公开身份、首末时间、原始组数与文章数，检测相同页面或游标循环。
- 第一方 `19.42e251bc.js` 的 `FETCH_MP_ARTICLES` 回调从响应数据读取 `reviews`，同时以响应数据的顶层 `length > 0` 更新后续加载状态。因此摘要应保留实际 `length` 值及类型，并与数组条数比较，不能只记录 `reviews.length`。限定上下文保存在 `reader-list-pagination-context.txt`。
- 同一第一方脚本在请求错误分支也将加载更多状态设为 false，因此页面停止加载、没有更多按钮或滚动停止本身不构成真实终点。应区分成功空页、明确上游结束字段、字段缺失及业务错误。
- 固定 fetcher 以 `reviews===0` 停止且默认页数有限，没有完整公众号范围保证。本轮即使成功翻到 WeRead 自身终点，也仍需核对已知近期漏项和内容类型覆盖；缺项未解决不能宣称公众号已全量。

收到主线脱敏证据后，再分别判断“来源返回有效首屏”“下一页有效”“指定来源分页结束”“全部公开文章覆盖”及“WeWe-RSS 页面入库验收”，不将这些结论合并。
