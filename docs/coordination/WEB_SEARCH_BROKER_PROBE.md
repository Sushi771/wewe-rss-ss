# 微信读书 Web 搜索代理：一次首屏探针准备（2026-09-30）

## 来源与请求边界

[固定提交 `dailyoozoo/weread-mp-fetch@2b4fd61`](https://github.com/dailyoozoo/weread-mp-fetch/tree/2b4fd61d921b029075ecad3963a8fbc9568d0fc0)的[真实请求代码](https://github.com/dailyoozoo/weread-mp-fetch/blob/2b4fd61d921b029075ecad3963a8fbc9568d0fc0/src/weread.js#L358-L456)在 `weread.qq.com` 页面上下文中执行 `fetch`：`POST /web/wx_search_broker_proxy`、`credentials: include`、JSON 首屏 `{query}`。本机只读克隆核对的 `HEAD` 与固定提交完整 SHA 一致。这是腾讯 Web 搜索请求，与旧失败的 `/mp/chapters`、`/web/mp/articles` 或运营后台接口不同；没有第三方开发者中转。[项目候选矩阵](SOURCE_CANDIDATE_MATRIX.md)已限定它是搜索索引，不是按公众号完整目录。

[作者接口记录](https://github.com/dailyoozoo/weread-mp-fetch/blob/2b4fd61d921b029075ecad3963a8fbc9568d0fc0/docs/INTERFACE.md#L31-L77)中的成功形状可能没有 `errCode`，外层 `ret=-1`，实际条目在 `content.data[].items[]`；未登录示例为数值 `errCode=-2010`，另记录 `-2012` 与会话或风控有关。故不得把外层 `ret=-1` 直接判失败，也不得将缺少 `errCode` 误判成错误。`source.title` 是搜索卡片的号名字符串，不是公众号实体 ID；`timestamp` 是否等于原文发表时间仍需与目标原文核对。作者记录约 15 条相关度供给上限、时间筛选及翻页可能无效，首屏即使成功也不证明近期覆盖或全号历史。

本轮仅准备[隔离探针](../../scripts/research/probe-web-search-broker.cjs)，**腾讯目标请求数为 0**。若后续本人完成正常官方 Web 登录且可确认已有登录页面，最多执行 **1 次**目标准确号名首屏 POST，body 只含 `{query: "妈妈部落畅聊阁"}`；不预先发认证探测，不自动登录、扫码、重试、翻页、换词、二跳或请求原文。凭据来源仅为既有同源浏览器会话，由浏览器自动携带；脚本不读取 Cookie 值、不注入应用库中的旧 Cookie，也不使用 Gateway `wrk-` Key。页面源不为 `https://weread.qq.com` 时，在网络请求前停止。

## 本机已有会话核对

现有浏览器清单调用 `cua.getState()` 返回 `Browsers: Error: nodeRepl.fetch request failed`，没有取得可审查的标签页；这**不证明浏览器没有登录**。独立工作树没有 Web 会话文件，本机当前进程无 `WR_*`/`WEREAD*` 环境变量名；原工作区已知 `.env.weread-gateway` 只有 `WEREAD_API_KEY` 配置键，属于官方 Gateway 而非 Web 页面登录。先前交接记录的应用旧 Cookie 在一次官方 Web 书架请求中未被接受，不能把存在旧值当作当前有效会话。未读取生产 SQLite、Cookie/Key 值或浏览器存储。

因此目前**没有可确认有效的现有 WeRead Web 页面会话，本轮停止在离线准备**。用户自行完成正常官方登录后，须先确认真实已登录页面及可复用的本机浏览器上下文；如需要使用探针 CLI，必须由总控提供已存在的本机 CDP 地址，脚本只连接现有 `weread.qq.com` 标签页，不启动浏览器或开放调试端口。没有这种已批准上下文时继续等待，不猜认证或从其他凭据转换。

## 脱敏输出与停止条件

脚本只输出：请求次数、HTTP 状态、数值 `errCode`、外层及 `content.ret`、桶数与总条目数、`source.title` 精确匹配数、匹配项 `doc_url/timestamp/source.dateTime` 字段存在数、显式目标 `__biz` URL 数、分页字段的存在性及停止分类。腾讯第一方页面已证明响应 `content.cookies` 会成为下一页业务游标，探针只输出 `hasSearchCookies` 布尔值，不读取或输出其内容。它不会输出标题、摘要、原文 URL、搜索标识、Cookie、原始响应或页面 HTML，也不落盘结果。`continueFlag` 只记录本页形状，**不会触发第二页**。

以下任一情况立即停止：缺可确认登录页面或页面源不符；登录页；HTTP 非 200/跳转；非 JSON 或验证页；数值 `errCode` 非 0（包括 `-2010/-2012`）；缺 `content.data`、桶形状异常；目标准确号名零匹配。若只是 `source.title` 匹配，仍须后续核对 `doc_url` 的目标公众号身份及原文发表时间，不算五篇验收。请求只执行一次，无自动重试。脚本要求操作者显式传 `--execute --confirmed-authenticated --cdp=http://127.0.0.1:<port>/`；本轮未使用该执行模式。

离线 `--self-test` 通过 **8** 个检查：成功形状（含外层 `ret=-1`）、未登录错误、结构缺失、HTML 验证形状、HTTP 429、非 WeRead 页面零请求及非本机 CDP 拒绝，以及摘要白名单丢弃额外原始字段；模拟测试的腾讯请求数为 **0**。`--plan` 也只打印固定请求契约。以上仅证明探针的本地门禁和摘要逻辑，不证明目标接口或会话当前可用。
