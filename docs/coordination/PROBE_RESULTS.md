# 隔离探针与真实取文实验（2026-09-29）

## 当前结论

- 本轮仅审查和运行本地 Mock 测试；**没有发送真实网络请求，也没有取得目标号的新文章**。此前 `/book/chapterinfo` 空章节、准确号名 `scope=4` HTTP 499 和 `/_list` 能力发现均未重放。旧 HTTP 499 的响应正文当时未保存，无法事后还原业务码。
- `scripts/probe-weread-gateway.cjs` 已具备非 200 诊断：按响应实际字节数有界读取（非 200 最多 64 KiB；200 最多 2 MiB），接受带 JSON Content-Type 或可识别的 JSON 正文，其余只记 `non-json` / `invalid-json`；输出 HTTP 状态、受限的业务码、分类后的 `errmsg`、`upgrade_info` 是否存在及格式校验后的版本号。原始正文、异常文字、Key、Authorization、Cookie、token 和完整 URL 均不输出。超时、过大响应和传输错误分别停止，不自动重试。
- 独立 review 找到搜索模式的日志上限缺口：文章样本已限制为 20 条，但 `groups` 会打印响应中的每个分组。即使响应体在 2 MiB 内，也可能放大为大量日志。现将分组摘要限制为 20 条，同时保留 `groupCount`、`returnedItemCount` 等完整计数，新增 `printedGroupCount` 说明实际输出数量。没有改变请求形状或生产业务逻辑。
- 本地 `node --test scripts/probe-weread-gateway.test.cjs`：基线 23/23，通过修补后 24/24。新增 Mock 构造 100 个搜索分组，验证完整计数与 20 条日志上限。`git diff --check` 通过。格式用仓库已有 Prettier 二进制及相同基础设置检查；此 worktree 未安装 Tailwind 插件，检查这三个 CJS/MD 文件时未加载该插件。

## 待实验条件

只在 Agent A 提供可核验、与旧失败流程有实质差异的公开取文源码、请求参数及适用的本人合法认证来源后，设计一次隔离、低频、只读验证。当前 `/book/articles` 线索中的 `skey/vid` 来源仍未核实；不得把 `wrk-` Agent Key、Web Cookie 或移动 `accessToken` 猜作其认证值。若新来源得到首屏，先核对目标 `MP_WXS_3895431412` 的真实不同文章至少 5 篇及号身份、稳定身份、原文链接、发布时间；未达到前不接入 Provider、不写生产 SQLite。验证码、账号限制或明确频控出现时立即停止当次实验，只保留脱敏结论。

## `/book/articles` 认证前提的离线字段核查

- 仅检查 [旧客户端审计](../WEREAD_CLIENT_FLOW_AUDIT.md)所指向的两份固定、Git 忽略的脱敏证据：`output/playwright/weread-client-audit/old-flow-summary.json` 与 `output/playwright/complete-acceptance/old-weread-experiment-review.json`。两份文件均未出现独立 `skey` 或 `wr_skey` 字段名。审计文档记录旧客户端 `/login` 的 `vid/accessToken/refreshToken` 来源、续期后的新 `accessToken`，未记录单独的 `skey`。这些摘要不是原始响应的完整字段清单，**缺席不能证明腾讯接口从未返回 `skey`**。
- 对本机现存、仓库根目录已知的 Git 忽略私有 `.env` 文件仅做赋值左侧变量名的布尔检查：`.env.weread-gateway` 存在 `WEREAD_API_KEY` 键名；未发现独立包含 `skey` 或 `vid` 的赋值键名。另一个现存的历史上游私有 `.env` 文件也未发现此类键名。没有递归扫描其他输出目录、读取凭据值、原始响应、账号记录或生产 SQLite。
- 因此目前不能确认本人已有一组来源明确、同属 WeBook `/book/articles` 认证体系的 `skey/vid`。这条离线核查不授权发起请求；待新的合法来源证据出现后，再由总控决定是否设计一次只读实验。
