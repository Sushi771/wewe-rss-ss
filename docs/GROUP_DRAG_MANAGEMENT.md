# 分组拖动管理

公众号侧栏的自建文件夹可通过左侧拖动手柄排序，松开后自动保存。点击文件夹名称仍只筛选列表；“全部”和“未分组”固定在前面。文件夹的更多菜单提供“上移”“下移”，可用于键盘操作。触控可拖动文件夹手柄，长列表靠近侧栏上下边缘可滚动；拖出分组区域或按 Esc 后松开会取消排序。

公众号左侧手柄可拖到目标文件夹或“未分组”。组内排序需先进入“管理”模式，拖到同组的另一公众号；跨组移动请拖到文件夹名称。手机或批量移动也可进入“管理”，勾选公众号后使用目标文件夹菜单。移动后当前筛选的来源组立即重新读取列表，空组保留。重名文件夹以独立 ID 区分，不合并。

排序和移动只修改项目分类及后续导出所使用的分类。不会移动已有磁盘文件，不会修改文章身份、正文、图片、源绑定或进行中的任务保存位置。操作期间禁止重复提交；失败显示错误并保留已保存顺序，重新读取服务器状态。

## 开发与部署

复用项目已安装的 `framer-motion` 和 NextUI，无新增依赖。分组顺序存于 `management_groups.order`；部署时需要执行 `20261010090000_management_group_order` 迁移并生成 Prisma Client，随后同步部署前后端。旧分组默认值为 0，以 ID 作为稳定的次序补充；新组追加到末尾。不在开发测试中迁移或写入生产数据库。

发布顺序：主负责人先核验一致性备份并在 SQLite 副本演练；按迁移目录顺序应用迁移，确保 `20261009063000_add_management_groups` 已存在，再执行 `20261010090000_management_group_order`；生成 Prisma Client，构建匹配的前后端，再按现有发布流程统一切换。副本演练须检查 `integrity_check`、`foreign_key_check` 和旧订阅/文章保护。不要先发布依赖新列的应用而遗漏迁移。

回滚优先回退应用至上一份可运行构建，保留新增 `order` 列；这是默认值为 0 的增量列，旧应用忽略它，不需要删列或重建分类表。如果仅排序结果需要恢复，可通过正常分类接口恢复备份记录中的顺序。只有迁移失败且确认没有后续业务写入时，才由主负责人用经核验的迁移前备份恢复数据库并检查完整性；已出现新文章或其他业务写入时，不直接用旧库覆盖，以免丢失新增数据。此任务没有执行生产迁移或发布。

`feed.reorderGroups` 接收 `ids` 和旧顺序 `expectedIds`。后端检查不重复的完整微信平台 ID 集合，在备份、分类锁和事务下比较当前顺序，过期请求返回 `CONFLICT`。`feed.updateOrder` 仅接受同一分组的完整成员列表；前端传入各成员原有 `expectedOrder` 和 `expectedGroupId` 防止过期顺序或归属覆盖。排序与已有分类移动共用锁，公众号采集期间也会拒绝操作。其他组不被写入。

回归入口（全部使用合成数据或临时 SQLite）：

```powershell
$env:TEMP='C:\Users\ss\AppData\Local\Temp'
$env:TMP=$env:TEMP
pnpm --filter server exec prisma generate
pnpm --filter server test -- --runInBand --no-cache management-groups.spec.ts
node --test scripts/feed-group-drag-ui.test.cjs scripts/folder-navigation-ui.test.cjs scripts/feed-refresh-state-ui.test.cjs
node --test scripts/feed-sidebar-layout.test.cjs
node --test scripts/folder-drag-browser.test.cjs
pnpm --filter web build
pnpm --filter server build
```

浏览器拖动回归使用独立 headless Chromium 临时配置、实际组件与 Framer Motion、合成回调和本地持久化；阻断外部域名，不打开用户浏览器或应用服务。需允许连接该测试创建的本地调试端口。它验证文件夹指针/触控、取消、失败、键盘菜单和刷新顺序；公众号跨组移动与组内排序另由组件处理函数及真实临时 SQLite 回归覆盖。静态布局检查不能替代实际拖动验收。当前分组是单层筛选入口，没有嵌套或折叠组功能。

2026-10-10 本机验收：真实临时 SQLite 9 项、侧栏实际拖动处理函数 3 项、分组菜单/移动 4 项、桌面与手机滚动布局 7 项、实际 headless Chromium 指针/触控/取消/失败/键盘/重载综合回归 1 项均通过。未写生产数据库、未触发真实订阅请求、未部署。

同轮界面清理：移除导航栏的原作者 GitHub 按钮、版本跳转链接及为该提示自动查询原仓库 release；继续显示本实例版本。MIT 的版权和许可文件完整保留，没有伪造归属。此改动只在 `Nav.tsx`。
