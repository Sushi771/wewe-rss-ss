# Windows 页面可用性诊断（2026-10-05）

目录按钮检查失败来自测试模式设置错误；没有发现需要放宽产品权限的故障。本机模式的完整入口测试已通过，但冷启动到页面控件可用仍超过三秒。本文补齐 PR20 的浏览器测量边界，PR20 仍为待 owner 审查的性能候选，没有自行部署。

## 原因与最小修正

最初的夹具设为 `PRIVATE_ONLINE_MODE=1`，通过私人登录取得有效 HttpOnly Cookie 后打开本地下载页面。`apps/server/src/article-download.controller.ts` 的 `authorized()` 在校验普通本机授权之前，就明确拒绝私人线上模式及非回环来源，返回 HTTP403。这是本机文件保存功能的既定权限边界。

`apps/web/src/pages/tools/article-download.tsx` 的设置请求失败后不会调用 `setSettings`；目录及下载按钮以 `!settings` 保持禁用。实际冻结页面按钮文字为“选择下载路径”，当前源码为“选择保存路径”；修正文字匹配后，403仍存在，证明文字匹配不是最终原因。私人模式中受Cookie保护的 `collection.verificationStatus` 同时返回HTTP200，故不能把此拒绝归因于Cookie登录失效。

只读配置及已有部署回执表明目标桌面部署配置为本机模式。将隔离夹具改成 `PRIVATE_ONLINE_MODE=0`，使用空的本机 `AUTH_CODE` 和独立临时保存设置后，设置接口HTTP200，目录按钮可用；输入测试URL后下载按钮可用。没有调用目录选择器、提交下载或修改产品鉴权代码。测试修正可完全离线完成，无须腾讯请求、扫码或改Windows策略。

应修改的是隔离测试夹具的模式与控件合同；产品源码无需为此改动。私人模式应继续断言HTTP403及按钮禁用，本机模式应断言HTTP200及控件可用，不能为了让测试通过删除后端权限检查。

## 完整入口实测

使用已提交的启动源码 `f0ad778534e92aec4f95d7f5dc4c0de7bb38143f`、与目标冻结包相同的manifest/payload字节，在独立worktree的临时端口、SQLite副本及保存目录演练。仅测试入口适配到临时端口和准确rehearsal命令行，不使用生产4000。PR20的controller重叠优化没有加入这次整段计时。

浏览器工具是本机安装的**有界面 Microsoft Edge + Node24内置WebSocket直接CDP**。使用显式独立 `--user-data-dir`、临时调试端口及已打开的空白页，不使用用户浏览器会话。没有可调用的电脑界面/browser agent工具参与本次验收。

计时从调用隔离 `.bat` 入口开始，到新导航页面完成首个内容绘制、URL输入框及目录按钮可用。随后只输入 `https://example.invalid/offline-readiness`，检查输入值及下载按钮状态，不提交URL。这是保存工具页面的控件可用合同，不代表所有订阅列表、正文、目录弹窗或下载已经验收。

| 同一次完整测试                   |    已有服务 |  服务未运行 |
| -------------------------------- | ----------: | ----------: |
| controller自身readyMs            |     0.600秒 |     2.829秒 |
| 外层入口退出                     |     1.161秒 |     3.165秒 |
| 从入口到绘制后控件可用的观测上界 | **1.643秒** | **3.452秒** |
| 页面导航自身FCP                  |     0.152秒 |     0.084秒 |
| 页面导航自身设置响应结束         |     0.255秒 |     0.182秒 |

两行都验证设置HTTP200、输入可编辑、目录及输入后的下载按钮可用。页面可用时间包含CDP观测和20ms轮询开销，并等待入口退出，是保守的实测上界；controller与导航的计时起点不同，不能相加或相减当成精确分段。仅一组整段演练，不称为中位数或系统下限。

包复制、夹具准备、helper预热及浏览器启动在计时前完成；冷启动的必要一致性备份、包/进程核验、迁移状态检查和服务启动在计时内。另一次本机模式组件测试中，独立Edge从进程启动到CDP连接为0.932秒，导航FCP为0.420秒、设置响应结束为0.340秒。这是另一组测试，不能与上述整段数字拼接成“全冷启动”结论。

历史18.034秒controller、PR20同根同缓存配对的controller中位数2.955→2.685秒以及此处2.829秒使用的包/代码/范围有差异。PR20的配对数据衡量那项候选优化；本次整段结果补充页面范围，不能作为18.034→3.452秒的同条件前后对比，更不能承诺冷启动一秒。

## 保护与复现条件

- 复用已有controlled restart、native SQLite preparation、manifest审计及完整进程身份工具。冷启动保留新的完整备份，并用独立Python inspector核对运行库和新备份全部字段相等、迁移状态有效；没有任意PID停止。
- `WEWE_ACCEPTANCE_MODE=1`、定时更新关闭；现有rehearsal网络/子进程guard生效，报告均为0。浏览器仅允许夹具自身来源；外部请求计数0。临时保存设置文件哈希不变。
- 调试夹具必须在desktop入口捕获 `spawn` **之前**注入独立浏览器参数，显式断言profile，拒绝非隔离fallback。冷服务测试需模拟正式启动已有的detached行为，保留准确返回身份并在结束后受保护地停止自己的服务。
- 复现私人模式用临时随机认证码取得Cookie，再检查设置403、受保护TRPC200及目录禁用；复现本机模式用本机夹具检查设置200及上述控件合同。均使用独立数据库/端口/profile，禁止提交下载或执行目录选择。

原始测试脚本、计时、数据库和浏览器诊断保留在独立worktree的ignored `output/playwright/launch-followup/wmi-get-prototype/` 中，未提交私人数据或原始证据。`desktop-page-readiness.cjs` / `desktop-page-readiness.json` 是整段测试；`browser-mode-service.cjs` / `browser-component-{local,private}.json` 是模式对照。owner可在原执行环境复核，不应直接对生产入口运行这些夹具。

已有离线合同回归 `article-download.controller.spec.ts` 的 `keeps acceptance mode and remote/private deployments from saving local files` 本次通过：1测试通过、30测试按筛选跳过。命令在 `apps/server` 下为 `node node_modules/jest/bin/jest.js article-download.controller.spec.ts --runInBand --testNamePattern "keeps acceptance mode and remote/private deployments from saving local files"`。这不是全套测试的替代，也不是生产部署或真实取文成功。

## 作废测试的边界

一次早期适配器把浏览器参数注入放在捕获 `spawn` 之后，启动参数没有显式独立profile；因此无法保证没有打开默认Edge标签。该次结果作废，没有查看或关闭用户标签、修改Cookie或用它作为性能结论。上述成功整段测试在入口第一行注入并核验独立profile。另一次冷服务适配器未模拟正式detached行为、服务随入口退出，其整段结果也作废。两项是测试适配器问题，不据此修改生产权限或进程保护。

下一步由唯一部署owner决定PR20集成及组合包验收。此诊断可离线修正测试，当前没有新的产品补丁；三秒以内的完整冷页面目标仍未通过，浏览器进程本身未运行的完整点击路径也尚未与这一组同时计时。
