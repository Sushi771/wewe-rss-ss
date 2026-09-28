# Just One API 历史文章 V2：只读探针与导入门槛（2026-09-28）

## 当前结论

用户现在要求尽可能完整回补订阅前的历史，再由后台一键和定时更新。Just One API V2 是待实测候选，尚未获得本人账户 Token、妈妈号首末页或 12 号覆盖结果。**当前没有接入生产更新，也没有历史文章导入。** 公开页面的“健康”状态不代表本项目目标号可用。

官方 [V2 接口文档](https://docs.justoneapi.com/zh/api/wechat-official-accounts/account-historical-articles-v2) 与 [OpenAPI v0 定义](https://docs.justoneapi.com/openapi/wechat-official-accounts/account-historical-articles-v2-zh.json) 在 2026-09-28 核对：`POST https://api.justoneapi.com/api/weixin/get-account-history-articles/v2`，表单字段 `token`、`ghid` 或 `url`、`offset`；下一页使用上一页的 `PagingInfo.Offset`。第一页偏移留空。OpenAPI 对成功响应只规定 `code`、`message`、`data`、`recordTime` 的信封，**`data` 是无结构的 `{}`**，未承诺文章数组、字段、每页条数、终页标志或全历史保留年限。不能据此直接写生产解析器或宣称翻到空游标即完整终点。本文只复用官方协议说明，未复制 SDK 源码；这份商业 API 文档未给可移植代码的开源许可证。代码仅使用 Python 标准库和本项目忽略目录中的自有种子。

[官方使用指南](https://docs.justoneapi.com/zh/usage)称注册后有有限免费调用，价格登录后可见；`code=0` 成功请求计费，`100/301/302/303/400/500/600/601/602` 等错误业务码见官方说明。指南建议 120 秒超时，部分接口与账户有每日成功配额。**实际单价、余额、试用次数和 12 号完整翻页成本尚未知。** 用户可接受付费，但本轮没有注册或付款。本文不把文档中的“免费调用”推断为足够完成整批回补。

## 已完成的无网络检查

[`justone_history_v2.py`](../scripts/collection-source-probe/justone_history_v2.py) 默认只验证忽略目录 `official-seeds-20260928.json` 的唯一账号 ID 与微信官方短链，不访问任何服务、数据库或微信 UI/剪贴板。当前本机文件验证为 12 个合法且唯一的种子。脚本没有缓存 Token、输出文章标题/URL/游标或保存响应。

```powershell
python scripts/collection-source-probe/justone_history_v2.py --seeds output/playwright/provider-source-probe/official-seeds-20260928.json
python -m unittest discover -s scripts/collection-source-probe -p test_justone_history_v2.py -v
```

4 项离线测试覆盖种子校验、表单 Token 不进入 URL、分页上限/游标传递、错误消息脱敏和重复游标拒绝。Python 编译与 `git diff --check` 通过。这些结果**没有触发 V2 真请求**，不证明其返回结构或费用。

## 本人账户就绪后的最小只读试验

用户自行注册并在本机配置 `JUSTONEAPI_TOKEN`；不要把 Token 贴进聊天、命令参数、截图或 Git。接口使用表单 body 携带 Token，探针只向固定的 `api.justoneapi.com` 地址发送请求并拒绝跳转。一次仅选一个已有号，显式 `--execute` 才请求，`--max-pages` 限 1–5（默认 2）。成功请求可能消耗试用次数或余额，先在账户页面查看定价、额度与单 Token 消费上限。**执行前由本人确认预算条件；本轮不执行。**

```powershell
$env:JUSTONEAPI_TOKEN = '<仅在本机设置的 Token>'
python scripts/collection-source-probe/justone_history_v2.py --seeds output/playwright/provider-source-probe/official-seeds-20260928.json --account-id MP_WXS_3895431412 --max-pages 2 --execute
```

输出只有 `data` 的字段名与数组长度、是否存在下一偏移及停止原因。`cursor_absent_or_empty_unverified` 特意不叫“历史已到底”：终页语义必须靠真实响应、相邻页和至少一条已知最早文章核对。若数据嵌套路径与脚本保守识别的 `PagingInfo.Offset` 不符，停止并仅在本机检查脱敏响应结构，再适配探针。探针不写原始响应，因此如需复核完整响应，只能在本机忽略目录以额外受控方式记录并检查敏感字段，不能直接提交或粘贴聊天。

先看妈妈号首两页：实际文章列表路径、账号身份、主次条、微信官方 URL、发布时间、重复项、下一游标。若免费额度允许，再用有上限的多次试验走到候选末页，与现存最早文章比对；记录已证明的时间范围和未覆盖内容类型。然后检查其余 11 号各自的种子、首末页和费用，不用妈妈号结果外推。全程保持生产定时关闭。

## 未来导入设计，尚未实现

1. 固定实测的 V2 响应结构与上游文档版本，建立独立解析层。账号身份、每篇官方原文 URL、标题和发布时间都需与微信公开原文核验；不能只凭第三方列表名称入库。记录跳页、重复游标、跨页重复、部分失败和内容类型覆盖；不把空页自动认作完整历史。
2. 按号分段暂存于 Git 忽略的本机目录，保存账号、游标、页范围、请求计数和校验摘要。用 URL/官方文章 ID 去重，明确重跑语义。只在来源通过目标号实测且已核验生产一致性备份后，才启用导入写入；旧 ID、非空正文、图片、封面、来源和有效指标须保持，缺失指标仍为 null。
3. 历史回补与后续增量分开验收，再接入现有单号/全部/定时入口。重复回补新增 0，妈妈号后至少一个已有号做生产验证；同时核对 RSS、Obsidian、正文、图片和非文章类型。每号记录最早/最新已证明时间与缺口，不能把费用耗尽或上游停止误报为已回补全部历史。

尚未解决：`data` 真正结构、V2 可回溯年限、全部内容类型、目标号覆盖与预算；这些都需要本人本机账户的有界只读试验。
