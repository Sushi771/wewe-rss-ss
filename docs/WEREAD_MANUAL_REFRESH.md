# 微信读书手动更新（2026-10-04）

用户决定每天按需点击原刷新按钮，不启用自动刷新；使用当前 Edge 官方页面里可以正常阅读的账号。目标仍是最近10篇完整正文与本地图片、重复刷新不重复、后来刷新能发现新文章。单篇链接收藏工具由另一隔离任务开发，不属于本模块。

当前还不能把软件的原刷新按钮称为已恢复。原刷新函数已增加目录模式，复用现有正文、图片归档和保存；已保存的两页官方目录真实可解析。下一步需要安全、受支持且可重复的实时来源，以及其余最近文章的正文。原生产绑定和历史停止记录保留，不把旧账号 Cookie 写入新账号；选择账号不等于已取得该账号的合法可用传输。

用户已说明官方页面可继续翻到1月并打开文章，遇识图验证可正常处理。接受此事实；本轮只验最近10篇，不扩大为全历史。正常路径遇验证时停止并提示本人，不后台重试或更换账号绕过。浏览器扩展已安装不等于当前开发窗口有受支持的页面读取能力。

## 已实现的合同

- `weread-directory.ts` 解析真实 `reviews[].subReviews[].review.mpInfo`。公众号归属核对 `belongBookId`，允许官方响应的空 `bookId`；文章时间只取 `mpInfo.time`，随后须与正文 `ct` 一致。
- `reviewId` 和22字符 `originalId` 是列表身份。保存的正文响应须有实际对应的 `reviewId`，核对正文公众号、标题、时间、canonical及 `biz/mid/idx/sn` 后，才取得 `WX_…` 入库身份。canonical 可以是短链，也可以是与正文一致的完整参数链接；不要求列表提供 href。
- 分页 offset 按群发组计，先展开文章再按身份去重。响应 `synckey` 只保留作元数据，不当 Web 分页游标；`clearAll` 不删除本地文章。最近窗口先选10篇，缺正文不拿旧篇补数，也不写入文章或 RSS。
- 运行时直接复用原 `archiveProviderImages` 归档和校验图片，未新增下载器。离线演练只消费已有、格式与哈希通过的缓存。响应已有内嵌 `src` 时保留其字节，即使仍附有旧 CDN `data-src`；不会重新下载。缺图、身份或可信时间冲突时整批拒绝。
- `CollectionService.replayWereadDirectory` 仅允许带标记的 SQLite 副本，先执行一致性备份，再复用原事务保存。正文与封面、指标保持；已核短链旧 ID 可以关联完整身份，保留旧 ID；不推进刷新成功时间。

## 开发者离线演练

原路径不需要新前端或新导出模块。私有来源绑定增加可选 `wereadDirectoryEnabled`（布尔型）；仅在选定账号正常目录传输通过、既有停止及验证预算符合授权时设置为 `true`，使用原 `owner-weread-latest` 刷新入口。没有配置时保持旧单篇行为，不根据历史样本自行打开。认证变化或旧停止仍先拦截；该开关不是解除停止或绕过验证的入口。本轮未修改生产绑定或触发真实目录请求。

先在正常构建环境运行 `pnpm --filter server build`。专用演练脚本需 Node.js 24（使用内置 `node:sqlite`）；应用本身仍按原 Node.js 20+ 构建要求。

```powershell
node scripts/research/replay-weread-directory-copy.cjs --manifest private-data/edge-success-20261004/offline-replay-manifest.json
```

manifest 仅存被 Git 忽略的 `private-data/`，包含 `mpId/name`、两页 `pages` 的 `file/sha256`，以及 `bodies` 的 `file/sha256/reviewId/capturedAt/images`。`reviewId` 必须来自保存该正文时实际请求的身份，不通过标题猜测；当前单篇已与独立保存的 cover 响应核对相同。外部图片缓存记录包含 `file/sha256/url/mimeType`；已有内嵌图片无需再次请求。脚本校验各输入哈希，封锁网络，创建生产数据库的一致性副本，仅在副本保存及重复保存，并核对旧行和生产不变。报告在新建的私有演练目录 `result.json`，不含账号凭据。

针对回归：

```powershell
pnpm --filter server exec jest --runInBand weread-directory.spec.ts search-replay.spec.ts subscription-provider.spec.ts owner-weread-latest.spec.ts article-body-retry.spec.ts archive-provider-images.spec.ts
```

Windows 若本机 pnpm 的 exec shim 无法找到命令，可进入 `apps/server`，用 `node node_modules/jest/bin/jest.js` 加同样参数；格式检查用 `node node_modules/prettier/bin/prettier.cjs`，构建用 `node node_modules/@nestjs/cli/bin/nest.js build`。不为此重新安装依赖或改生产配置。

离线报告、Mock和构建均不能代替原刷新入口取得最近10篇正文图片的线上验收。确认实时安全路径后，先隔离核验响应，再接回原按钮；生产写入前必须再次核对当时一致性备份与副本结果。
