# 个人公众号后台列表通道研究（2026-09-27）

本次先完整读取 NEXT_BUILTIN_COLLECTION_TASK.md 及其指定的三个历史文档和三个脚本。研究只下载公开 GitHub 源码和主线实际编辑器加载的微信公开脚本；未运行第三方项目、未读取后台会话、未操作浏览器或生产数据库。浏览器实测由主线执行，以下明确区分源码与实测。

## 固定版本与许可

| 项目 | 本次固定 HEAD | 提交时间（UTC） | LICENSE |
| --- | --- | --- | --- |
| rachelos/we-mp-rss | `126993c81a00466e9a6bbab041eef34ab27abe9c` | 2026-09-24 01:27:27 | MIT，Copyright 2025 RACHEL |
| wechat-article/wechat-article-exporter | `a7bffa6e481a188510a701d30b399b76573434e5` | 2026-08-07 05:45:46 | MIT，Copyright 2024 Jock |

许可依据分别为 [we-mp-rss LICENSE](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/LICENSE) 和 [exporter LICENSE](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/LICENSE)。若后续移植实质代码，保留对应版权和许可文本。本轮未移植实现。

源码及 HEAD API 元数据保存在 Git 忽略目录 `output/playwright/mp-backend-research/`，未提交公开源码副本。

## 授权与列表协议

[we-mp-rss wx.py](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/driver/wx.py) 的 `wxLogin` 打开微信后台、截取真实二维码、等待主页面到达 `cgi-bin/home`，再提取后台 Cookie/token。新版扫码组件为 `.login__type__container__scan__qrcode`，快捷登录场景会切换到“扫码登录”。这需要可登录公众号后台的本人账号，不是微信读书扫码。其浏览器实现使用 Playwright。

[wx_api.py](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/driver/wx_api.py) 的 HTTP 登录实现是 `start_login` → `/cgi-bin/bizlogin?action=startlogin` → `/cgi-bin/scanloginqrcode` → `/cgi-bin/bizlogin?action=login`；token 来自登录跳转信息。仅作协议参考，未经本机实际登录请求核验的字段不得直接固化。两种路径均只需本机应用直连微信，协议本身不要求第三方下载器、第三方会话代理或微信客户端持续常驻。

[exporter searchbiz](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/api/web/mp/searchbiz.get.ts) 使用 GET `/cgi-bin/searchbiz`：`action=search_biz`、`begin`、`count`、`query`、后台 `token`、`lang=zh_CN`、`f=json`、`ajax=1`。后台 Cookie 随请求发送。搜索返回的 `fakeid` 是列表参数，不能仅按昵称猜测身份。

[exporter appmsgpublish](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/api/web/mp/appmsgpublish.get.ts) 使用 GET `/cgi-bin/appmsgpublish`：`sub=list`、`search_field=null`、`begin=0`、`count=5`、`query=`、目标 `fakeid`、`type=101_1`、`free_publish_type=1`、`sub_action=list_ex`，加后台通用参数。关键词搜索改为 `sub=search`、`search_field=7`。响应结构为 JSON 字符串 `publish_page` → `publish_list[]` → JSON 字符串 `publish_info` → `appmsgex[]`；分组与组内各条都需保留。源码支持这些解析，不证明目标所有内容类型可返回。

[searchbyurl](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/api/web/mp/searchbyurl.get.ts) 只是提取原文账号名称后调用 searchbiz，最后按昵称过滤，不是独立列表通道。

## 本机真实对照

主线脱敏证据：`output/playwright/mp-backend/backend-first-probe.json`，生成于 2026-09-27 13:32:48（北京时间）；`databaseTouched=false`。

| 步骤 | 实际结果 | 可以证明 |
| --- | --- | --- |
| 本人独立浏览器扫码进入后台 | 公众号后台登录成功 | 新账号前提满足 |
| 编辑器账号名片搜索目标 | searchbiz `scene=1, begin=0, count=10`，HTTP 200，`ret=0`，含目标昵称与 `fakeid=Mzg5NTQzMTQxMg==` | 目标搜索可用，标识吻合已知 biz |
| 编辑器超链接自号列表 | appmsgpublish `fakeid=''`，HTTP 200，`ret=0` | 该会话能请求自号列表 |
| 同请求换为搜索所得目标 fakeid（13:32:09.425） | HTTP 200，`ret=200013`，`err_msg=freq control` | 目标首屏受上游限制；没有取得文章 |
| 间隔 142.448 秒后浏览器同源复核（13:34:31.873） | 相同 appmsgpublish 参数，HTTP 200，`ret=200013`，`err_msg=freq control` | 同源复核仍受阻；不是下一页 |
| 第三次目标请求：遗留引用 appmsg（13:35:44.453） | 不同路径、源码支持的参数，HTTP 200，`ret=200013`，`err_msg=freq control` | 第二种列表路径首屏也受阻 |

第二次请求为浏览器同源 fetch，证据 `output/playwright/mp-backend/backend-same-origin-recheck.json`；与首轮间隔精确为 142.448 秒。

第三次请求中，主线依据当前加载脚本的遗留引用方法，仅执行一次不同路径 GET `/cgi-bin/appmsg?action=list_ex`，目标 fakeid、`query=`、`begin=0`、`count=4`、`type=9`、`need_author_name=1`，返回 HTTP 200、`ret=200013`、`err_msg=freq control`。时间为 2026-09-27 13:35:44（北京时间），证据 `output/playwright/mp-backend/legacy-quote-list-probe.json`，仍未写库。两个不同目标列表路径首屏均受阻，此后停止网络探测，没有假造下一页。

截至该证据，目标近期列表、下一页、终止条件、漏采条目与真实次条均未验收。不要把 HTTP 200、登录或账号搜索成功合并为采集成功；不要把该次 `200013` 当成账号过期或全球永久关闭，也不能据此承诺等待或再扫码必然恢复。

## 当前第一方编辑器脚本核对

仅下载主线记录的 `output/playwright/mp-backend/firstparty-script-urls.json` 中 67 个公开 `res.wx.qq.com` URL；未访问其他新端点。每份 URL、字节数、SHA-256 在 `mp-backend-research/firstparty-manifest.json`。

1. [当前超链接组件脚本](https://res.wx.qq.com/mpres/zh_CN/htmledition/pages/modules~comment/comment_list/comment_list~editor/ai_layout/ai_layout~editor/editor_for_web1~mass/mas~modules.027c9d07.js)，本机 `firstparty/script-29.js`，118677 字节，SHA-256 `6F14EC9BFF032ECBA58617FF483553A7B3A057FE3DE920533000596A69ED821D`。模块 `media_dialog/link_dialog/inner_link.js` 的账号字段初始化为空，`msgPageChange` 读取该字段作 fakeid；该模块没有设置目标账号的方法，配套模板仅“已发表内容/输入链接”及文章标题搜索。主线当前 UI 也只有这两项。
2. [当前编辑器脚本](https://res.wx.qq.com/mpres/zh_CN/htmledition/pages/editor/editor_for_web1.2bb8d327.js)，本机 `firstparty/script-42.js`，1647978 字节，SHA-256 `342EE9FEE800A5465E0BF0CA5F798835E90FCEA4D2826114CA99169E1D731BB6`。`blockquote_dialog.js` 仍包含按公众号查文章的方法，调用 `/cgi-bin/appmsg?action=list_ex`，参数含目标 fakeid、query、begin、count、type=9、need_author_name=1；但配套 `blockquote_dialog.tpl` 已无调用它们的搜索控件，只提供文章链接输入。主线实际打开“插入引用格式”也确认这一点。残留方法不能被描述为当前仍可操作的 UI 入口。
3. 同一脚本的账号名片组件仍执行 searchbiz `scene=1`，与主线真实网络记录一致。它插入名片时另有写入最近使用记录的请求，本次只搜索，没有触发插入。

由此可确认本次页面的超链接和引用界面不提供他号文章列表选择。没有找到第一方关于永久关闭所有他号列表接口的公告。加载的残留 appmsg 方法提供了上述不同只读验证的源码依据；本机实际同样返回 200013，不能以方法存在反推 UI 有入口或服务器可用。

## 不应直接移植的行为

- exporter 的 [CookieStore](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/utils/CookieStore.ts) `isExpired` 仍返回 false；[proxy-request](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/utils/proxy-request.ts) 登录路径打印 token。不能照抄失效判断和敏感日志。
- we-mp-rss [free_publish.py](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/free_publish.py) 枚举多个端点，仅检查列表非空来判可用，未证明返回的是目标号；还调用未导入的 `print_success`。新文件不能代替可用性证据，本轮未轮试这些端点。
- [playwright_mp.py](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/playwright_mp.py) 构造带 fakeid 的后台管理页面，解析时没有目标身份检查；翻页后的新增响应未解析回返回文章数组。不可将它视为已验证分页实现。
- [wxarticle.py](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/driver/wxarticle.py) 部分发布时间解析失败会回退当前时间；本项目必须保留缺失/失败，不用采集时刻冒充发布时间。

## 维护者与用户报告的边界

[exporter #200](https://github.com/wechat-article/wechat-article-exporter/issues/200) 的维护者在 2026-07-30 宣布停维，并报告其核心后台通道受限；Credential 方案未纳入主流程。这属于该项目的运行经验，不能覆盖本机所有账号或永久未来状态。

[we-mp-rss #469](https://github.com/rachelos/we-mp-rss/issues/469) 与 [PR #470](https://github.com/rachelos/we-mp-rss/pull/470)（2026-09-25）报告后台 `200013` 以及降级流程缺陷。PR 声称的成功使用微信读书降级，不是后台他号列表恢复证据，且不是本机目标号验收。[#418](https://github.com/rachelos/we-mp-rss/issues/418) 则指出错误统一映射为重新扫码会混淆过期与频控。不能根据这些讨论盲目换端点重试或要求重复扫码。

## 实施门槛

当前只验证了登录及目标号搜索，尚不足以接入正式列表采集器。后续必须取得目标真实首屏与下一页、核对目标/原文身份与内容类型、证明选定范围的终止，再以备份保护下的应用页面更新完成入库和重复更新验收。授权失效、频控、空响应异常应分别处理，失败不推进游标、不抹正文或历史指标。

这条后台列表协议不证明他号阅读、点赞或收藏权限。指标由独立验证线处理；收藏没有可信总数字段时保持缺失。
