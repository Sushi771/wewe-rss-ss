# Redbook 本机确认：开发

源码位于 `scripts/redbook-local-confirmation/`，使用 Node 原生 CommonJS HTTP 服务和 Windows PowerShell 启动器。入口不修改主应用运行时：外层只开放诊断路由，内层复用对应源码的编译服务。额外入口的合成验证目标为 Node 24；Node 20/22 与 ESM CLI 兼容性需另行验证，不能套用主应用已有测试结论。

在匹配的仓库检出中按项目要求安装依赖、生成 SQLite Prisma 客户端，并完成前后端构建。创建独立编译产物目录（不包含任何环境文件、生产 DB、媒体或依赖副本）：

```text
isolated-redbook-artifact/
  server-dist/apps/server/src/main.js
  web-dist/index.hbs
```

`server-dist/` 包含 backend build 的完整输出；`web-dist/` 包含 frontend build 的完整输出及服务视图。入口从当前仓库 `apps/server/node_modules` 解析依赖，并将 `@server/` 指向该产物的编译源码目录。必须保证编译产物和仓库依赖/迁移与源码版本相匹配。入口不会为缺失依赖自动联网安装，也不会自动重新构建。

`start-paired-redbook.ps1` 接收非敏感参数 `-ArtifactDirectory`，自动找到 PATH 中的 Node。Node 启动器在系统临时目录创建唯一隔离实例目录、空 SQLite 库和空导出目录，将编译 frontend 作为 junction 引入。数据库通过当前源码 migrations 初始化，服务日志不进入启动控制管道。调度关闭，微信平台地址指向未使用的回环端口，拒绝连接 4000；不要用生产实例作为编译产物或改变回环限制。

内部保护值每次运行随机生成，长度 32 字节，仅内存保存，不暴露给浏览器，不创建通用应用登录 Cookie。外层 PairAuthority 是操作者 stdin 批准的状态机，六位核对码只是短暂比较值，真正访问 token 和浏览器 proof 各为独立 32 字节随机值。两分钟/三次错误/一次兑换与 24 小时绝对期限互相独立。期限同时检查墙钟与单调时钟。

HTTP 白名单仅包括 `/pair/start`、`/pair/redeem` 和 `/diagnostic/{status,creator,session,list,detail,images,sample,discard}`。没有 HTTP 批准路由，拒绝通用应用登录、tRPC、正式会话、审核及恢复归档接口。要求实际 socket 回环地址、严格原始 Host、同源 Origin，并拒绝任意 forwarded/x-forwarded-\* 与 via。

撤销先清除访问状态、清空样本并 abort 在途请求，然后清理内层诊断会话。清理失败锁存 `CLEANUP_FAILED`，禁止新配对，由操作者 R 重试或停止实例；不能将失败当成功。启动器任何异常直接进入 finally，有界停止自己创建的进程，不等待用户回车。停止实例才能可靠结束全部内存授权；浏览器关闭事件不是撤销保证。

运行不依赖真实账户的网关测试：

```powershell
Set-Location scripts/redbook-local-confirmation
node --test redbook-pair-gateway.test.cjs
```

测试使用合成 backend 与仅本机 HTTP，覆盖批准/兑换、期限、Host/Origin/转发头、路由、预算、会话期限、清理失败与在途取消、样本缓存和浏览器凭据禁存。使用额外的测试外网 guard 时，应从测试 harness 预加载；不要将本机 guard 日志、运行审计、真实请求响应或凭据提交 GitHub。

若修改启动器或编译适配，还需在全新合成实例验证迁移、未批准拒绝、操作者批准、状态、R 撤销、Q 停止和批准后异常清理；只保存假会话，不调用真实列表/正文/图片。源码、开发/使用文档可提交；实例目录、DB、备份、环境文件和原始验收产物始终排除。
