# 腾讯公众号公开列表来源复核（2026-09-30）

## 决策

**公开合集 `/mp/appmsgalbum` 是一条真实可用、可自行维护的“单个合集文章列表”来源；尚不是目标号持续订阅来源。**它需要目标公众号发布的确切 `__biz + album_id` 公开链接，且一个合集不等于该号全部历史或未来文章。目前没有目标号的 `album_id`、合集覆盖率和五篇当前文章的证据。无需继续向旧微信读书路径发请求；也不应把非目标号的 30 篇示例用于目标验收。

本轮只读公开源码、GitHub 一手 issue 与腾讯**非目标号**公开页面；无私人凭据、扫码、目标请求、生产写库或绕过验证。下面的实测结果仅保留状态、数量和字段名，未保存原始响应。

## 已证明

1. [opencli-weixin-album，MIT](https://github.com/SlowGrowth1314/opencli-weixin-album/blob/main/LICENSE) 于 2026-04 建仓、2026-07 仍更新；其[实际 HTTP 代码](https://github.com/SlowGrowth1314/opencli-weixin-album/blob/c45aed6516e8682202d45a3ff5ee1cdc6d3fe0f2/download-album.ts#L100-L136)从输入 URL 要求取得 `__biz` 和 `album_id`，随后 `fetch` 腾讯 `https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&...&f=json`，只加普通请求头，不提交 Cookie、Key 或第三方服务凭据。[翻页代码](https://github.com/SlowGrowth1314/opencli-weixin-album/blob/c45aed6516e8682202d45a3ff5ee1cdc6d3fe0f2/download-album.ts#L337-L365)以末条 `msgid/itemidx` 作为 `begin_msgid/begin_itemidx`，直到 `continue_flag` 结束。列表代码可按 MIT 条件复用；该项目的[正文下载](https://github.com/SlowGrowth1314/opencli-weixin-album/blob/c45aed6516e8682202d45a3ff5ee1cdc6d3fe0f2/download-album.ts#L151-L175)另调用 `opencli` 与浏览器扩展，不应把其整套运行依赖误认成本项目的必要订阅依赖。
2. 2026-09-30 对 [RSSHub 公开样例](https://github.com/DIYgod/RSSHub/blob/08a38f0a5e2033b96cff6325bee027998f851de9/lib/routes/wechat/msgalbum.ts) 的**非目标合集**匿名 GET 得到 HTTP 200 HTML，含 10 组 `data-link`、`data-title`、`.js_article_create_time`。对 [2025 年一手公开样例](https://github.com/DIYgod/RSSHub/issues/20009) 的另一个非目标合集，按该 issue 给出的 JSON 参数得到 `base_resp.ret=0`、首 20 条和 `continue_flag=1`；照 2024 年[真实 HTTP 与分页代码](https://blog.thend03.com/posts/blog/how-to-make-a-xiaobot-nav/)用末条 `msgid/itemidx` 取下一页，得到 `ret=0`、10 条、`continue_flag=0`，两页 30 个 `key` 无重复。响应条目有 `key/msgid/itemidx/create_time/title/url`；`base_info` 有 `nickname/username/article_count`。这是**其他号**当日可用的证据，不证明目标号有合集或该字段一定等于原文发布时间。
3. [RSSHub 当前路由](https://github.com/DIYgod/RSSHub/blob/08a38f0a5e2033b96cff6325bee027998f851de9/lib/routes/wechat/msgalbum.ts)亦真实 GET 腾讯公开合集，解析链接、标题、页面时间并以文章 URL 作 GUID；RSSHub 为 [AGPL-3.0](https://github.com/DIYgod/RSSHub/blob/master/LICENSE)。该路由只读第一页 HTML，文件 2026 年改动主要为类型/格式维护，不能据此声称它已经实现全合集分页。
4. 目标号 `妈妈部落畅聊阁 / MP_WXS_3895431412` 的旧库经总控**只读、只报参数名计数**核对：194 行旧 URL 中 46 行含 `__biz`，0 行含 `album_id` 或 `hid`；27 行缓存正文也没有 `appmsgalbum/album_id/mp/homepage`。这些线索能辅助日后比对账号 `__biz`，目前不能给出或推导合集 ID。本 Agent 未读取数据库值。公开网页检索也未找到可核验的该号合集链接；检索未命中不等于该号没有合集。

## 有证据支持，但本轮不能作为目标来源

- `/mp/homepage?action=appmsg_list`：RSSHub 有[针对广州某号、固定 `__biz/hid/sn` 的真实 POST 代码](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/tingshuitz/guangzhou.ts)。它是特定主页栏目，并非只凭公众号名称或 `__biz` 列出全号文章。目标旧 URL 没有 `hid`；其中若有 `sn`，也只是文章 URL 同名参数，不能充当主页栏目 `sn`。本轮未验证该示例当今响应。
- `/mp/profile_ext?action=home/getmsg`：[旧 HTTP 实现](https://github.com/happyjared/python-learning/blob/master/wechat/wx_mps.py)要求 `appmsg_token/pass_ticket/wap_sid2/Cookie`，凭据从作者自己的数据库输入，未展示正常登录续期；该文件最后改于 2020 年且仓库无可识别许可证。对**非目标**公开 `action=home&__biz=...` 作一次无凭据只读请求，返回短提示页而非文章列表。不能从公开主页 URL 推出匿名 `getmsg` 可持续工作；未请求 `getmsg`。
- 公众号**运营后台**并非匿名公开页。2026-03 [一手会话记录](https://github.com/Alex-giao/wechat-mp-article-list/blob/main/references/backend-workflow.md)描述本人登录自己的 `mp.weixin.qq.com` 后台后，编辑器跨号文章选择器先 `searchbiz` 得 `fakeid`，再 `appmsgpublish` 得 `appmsgex[].appmsgid/itemidx/title/link/create_time` 与 `begin/count` 分页；但该仓库只有操作说明，没有产品 HTTP 实现。[wechat-article-exporter 的实际腾讯代理代码](https://github.com/wechat-article/wechat-article-exporter/blob/master/server/api/web/mp/appmsgpublish.get.ts)及[登录处理](https://github.com/wechat-article/wechat-article-exporter/blob/master/server/api/web/login/bizlogin.post.ts)是 MIT、自托管的另一手实现，依赖本人具有公众号运营后台账号、正常扫码和运营 Cookie/token。作者 2026-07-30 [宣布核心上游接口关闭并停维护](https://github.com/wechat-article/wechat-article-exporter/issues/200)；同日[使用者报告列表 `200013:freq control`](https://github.com/wechat-article/wechat-article-exporter/issues/199)。因此 2026-03 曾成功不能当作现在给目标重试跨号列表的新依据。其源码代理还把 token 写控制台日志，若未来在新证据下复用必须先删除该日志。
- 公众号官方 `freepublish/batchget` 由[自己公众号的 access_token](https://github.com/Caiqm/wx-official-accounts/blob/main/freepublish.go)调用，不能用自己的授权列出未被授权管理的目标号，也不等于公开历史群发列表。

## 推测、已排除与下一实验门槛

- **推测：**若目标号确有持续维护、包含至少五篇当前文章的公开合集，那么该合集可成为局部订阅的独立来源；是否覆盖新文章、多个合集如何发现、`create_time` 与原文发布时间是否一致，必须以目标真实响应核验。一个合集首屏、Mock、旧库都不能宣称全号恢复。
- **已排除为当前可执行实验：**凭 `MP_WXS_3895431412` 猜 `__biz` 或 `album_id`；凭文章 URL 的 `sn` 猜主页 `sn`；仅凭 README 或 2026-03 运营后台旧成功重发受限的 `appmsgpublish`；把 `getmsg` 旧脚本的 Cookie 当作公开匿名鉴权；将公开合集页面的其他号文章凑目标五篇。
- **最小新条件：**只有发现目标号**自己发布的**官方 `mp.weixin.qq.com/mp/appmsgalbum` 链接，且链接同时明确 `__biz`、`album_id`，才请 B 在隔离环境做一次目标首屏：先把 `__biz` 与已有可信目标文章身份比对，再 GET 合集第一页，仅留 HTTP/业务状态、账号昵称、数量、字段名；若确实属目标，再核对至少五篇不同 `key` 或 `msgid+itemidx`、canonical URL、标题及逐篇原文发布时间，然后有限翻页和第二次增量。遇验证、频控或身份不符即停。**当前缺 `album_id`，所以无目标请求条件，也不要求用户现在重新登录。**
