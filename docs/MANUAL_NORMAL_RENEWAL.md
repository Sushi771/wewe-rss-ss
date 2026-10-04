# 下一次手动刷新时的正常续期（2026-10-04）

原刷新入口已补正常续期衔接代码。只在本人从本机点击原刷新、会话确已到期、同一绑定此前完整成功取得十篇、没有更新的拒绝或中断、冷却结束且同账号刷新凭据仍有效时，调用既有`renewDirectWebTicket`一次。健康会话、定时任务和公开入口不续期；没有成功记录、账号不符、缺少刷新凭据或新停止时不发送请求。

复用已实测的固定正常`/web/login/renewal`请求、参数和Cookie适配器，不添加验证入口或参数试探。新截止来自本次服务器响应，保守采用明确Expires及Max-Age中较早时间；不延长旧截止、不回放旧响应。扫码`capturedAt`和维护`renewedAt`分开，原绑定文件、扫码索引、账号库和旧停止不改；新会话为同一私有目录中的不可变文件，状态仅记录与绑定字节及旧停止哈希一致的会话引用。下一次原目录/正文请求仍需完整验证，不能把续期成功当成取文成功。

传输前先在原刷新锁内保存单次预约；续期失败、HTTP跳转、验证/业务拒绝或中断不重试，不跟随跳转、不切账号。新的目录/正文拒绝也会阻止后续使用。需要本人在正常页面处理限制；没有可用刷新凭据时回到已有账号页正常登录、明确预览并连接，不手改Cookie或删除停止。旧绑定的截止和会话引用不能作用到后来的新正常登录。

本轮只做离线合成回归，没有续期当前凭据、重抓已验收十篇或修改生产凭据。新增20项测试覆盖原入口一次续期→十篇→第二次刷新复用→后来再次真实到期才续期，以及已成功时间修复上下文、历史停止保留、错误账号/新停止/过期刷新凭据、302/401/429、中断与不重试。相关原续期、Cookie、手动刷新和回归测试同步执行。真实平台的隔日衔接仍等本人正常使用验证，不能由这些测试保证平台授权持续有效。

```powershell
pnpm --filter server exec jest --runInBand manual-web-renewal.spec.ts owner-weread-latest.spec.ts owner-weread-batch-resume.spec.ts normal-web-maintenance.spec.ts normal-web-renewal.spec.ts native-web-ticket.spec.ts owner-weread-session-state.spec.ts
```

代码为`weread/manual-web-renewal.ts`，仅接到原`fetchOwnerWereadLatest`会话选择处，正文、图片和数据库事务仍走原流程。当前最新十篇图片和[实际缓存直存Obsidian](VERIFIED_CACHE_SAVE_ACCEPTANCE.md)结果保留；受阻短链接、其他11订阅和未来自然新文章仍独立待各自条件。部署版本另见[精简交接](DEVELOPMENT_HANDOFF.md)。
