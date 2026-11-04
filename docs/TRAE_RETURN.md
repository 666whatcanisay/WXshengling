# TRAE 返回给 Codex

日期：2026-11-04。起点提交 `ee60bb9`，分支 `codex/trae-checkin-reliability`。本轮范围严格按 `TRAE_HANDOFF.md`：管理员权限绕过、任务打卡原子性、前端重复响应。未部署、未改真实云数据、未换架构/依赖/SDK、未接收费模型。

## 一、改动文件与原因

1. `cloudfunctions/app/index.js`（~116 行变动）
   - `checkAdmin(openid)` 删除 `username='lzk'` 兜底（约原 2648 行）。仅以调用者自身 `users._openid` 记录的 `role==='admin'` 通过；空身份、无记录、查询异常均拒绝。
   - `taskCheckin(openid, data)` 改为事务化（原 381 行附近）。把「标记完成 + users.total_xp.inc + growth_logs 记录 + user_growth_pool 入池」四步捆进 `db.runTransaction`；事务外 `safeQuery` 预取各目标 `_id`（腾讯事务不支持 where）；事务内先 `tx.get` 二次校验 `task.completed`；`growth_logs` 和首次入池用确定性 `_id`（`checkin-log:${task._id}`、`pool:${openid}`）让事务重试不重复写入；`repairGoalDays` 留事务外幂等执行。
2. `miniprogram/pages/home/home.js` quickCheckin：`res.xp_earned || task.xp_reward` 假装拿到 XP → 只信后端返回值；`hatchProgress` 每次都调 → 只在 `!res.already_completed` 时触发；already_completed 时 toast 改为「任务已完成」。
3. `miniprogram/pages/record/record.js` completeTask：同 home.js 两改。goals.js 已有 `!checkinResult.already_completed` 保护，goal-detail.js 已有 `already_completed ? null` 保护，未动；pets.js 补签是特殊场景，按交接书保留。
4. `tests/single-goal-regression.cjs` / `tools/audit-current-source.cjs`：测试替身新增 `runTransaction(cb)` + `tx.collection(name).doc(id).get/update/add`，让改造后的 handler 能在隔离环境运行；不改其既有业务验证逻辑。
5. `tests/checkin-reliability.cjs`（新增，约 43 断言）：调用真实生产 handler，用带锁 + rollback 的本地 db 替身验证 checkAdmin 拒绝无关调用者、同一 10XP 任务 20 并发只结算一次、同用户不同任务都能结算、中途 db 错误回滚后任务仍未完成且重试可成功、未来任务/他人任务仍被拒绝。

## 二、事务 / 去重设计简述

```
taskCheckin 事务外：safeQuery 预取 task/user/pool 的 _id（身份+日期+前置校验）
        ↓
db.runTransaction(async tx => {
  tx.get(taskDoc) → 若 completed==true 抛 ALREADY_COMPLETED_CONFLICT → 回滚
  tx.update(taskDoc.completed=true)
  tx.update(userDoc.total_xp=_.inc(xpReward))
  tx.add(growth_logs, _id='checkin-log:'+task._id)   ← 幂等 key
  pool 存在？ tx.update(poolDoc) : tx.add(pool, _id='pool:'+openid)
})
        ↓（事务抛错自动回滚；handler 只对冲突型 ALREADY_COMPLETED_CONFLICT 转换为 already_completed 响应）
事务外：repairGoalDays（自身幂等，丢了可补）
```

growth_pool 兼容线上已存在的随机 `_id` 记录（事务外预取，事务内 doc 路径续用）。**未**新增集合、未改 role/用户模型、未动 pets/hatchProgress 15 成长差异等跨模块逻辑。

## 三、测试命令与结果

全部用 `D:/Temp/ai-forest-node24-compat-20261104/node.exe`（v24.22.2），本机系统 Node 仍是 22。线上三个函数 runtime 仍是 Node16，**未部署**。

| 命令 | 通过 | 范围 |
|---|---|---|
| `node tests/single-goal-regression.cjs` | 41/41 | 现有 AI 发布、目标详情、分页、未来任务等业务回归 |
| `node tests/checkin-reliability.cjs` | 43/43 | 本轮新增：checkAdmin、并发打卡、中途失败回滚、重试、跨用户/未来任务拒绝 |
| `node tools/audit-current-source.cjs` | 审计脚本继续可跑 | 其 `concurrentTaskReward.userXp=20` 是**旧简化替身**的并发复现——它没有事务/锁，专门证明旧版本的缺陷；真实 handler 必须走事务，新测试已证明 |
| 云函数 index.js / home.js / record.js `new Function()` 语法检查 | 全部 OK | — |

## 四、哪些只是替身验证

- 所有断言都在本地 Node24 进程、无网络、无 SDK 真实连接。
- `tests/checkin-reliability.cjs` 用**带 Promise 互斥锁 + 自动 snapshot/rollback** 的本地 db 替身，模拟了事务串行化和失败回滚；**未**使用真实云数据库，**未**验证腾讯 SDK 事务在真实 snapshot isolation 下的写冲突检测和自动重试次数。
- 真实云数据库里 handler 行为按文档语义设计（`db.runTransaction`、doc 路径更新、幂等 `_id` 的 `add`、`_.inc` 命令），线上是否与替身一致需**云环境冒烟**。
- growth_logs / growth_pool 的确定性 `_id` 在真实云数据库上若被冲突重试、需重新 add 同一 `_id` 是否自动通过，未实测；代码按文档假设冲突时重试会复用同 id 成功。

## 五、失败 / 未完成项

- 未部署任何云函数副本或修改线上数据。
- 真实云数据库事务的并发写冲突 + 自动重试、真实身份下的 openid 绑定（`cloud.getWXContext().OPENID` 是否总是可信）未在云端验证。
- home / record 以外的页面（pets 补签、goals、goal-detail）打卡回调虽已核查但未逐一改，按交接书保留首次体验；`pets.js` 1344 行补签卡属于宠物特殊路径，本轮未动。
- `admin_dashboard` 等管理员接口的调用者身份绑定到 handler 参数 `openid`，上层 handler 入口（`case "adminDashboard"`）传入的是 `getOpenId()`，没硬编码——但我没全量 grep 其它 admin 接口入口，这里留给 Codex 二次检查。

## 六、UI 入口与预期（本地生效，需开发者工具刷新）

- 首页 → 快速打卡：同一任务连点两次，第二次 toast 为「任务已完成」、XP 不再累加到 todayGrowth、hatchProgress 不再调。
- 记录页 → 打卡按钮：同上。
- 管理后台功能按钮（数据概览等）：用非管理员账号触发，后台返回 `无管理员权限`。

## 七、提交信息

`feat(cloudfunctions): atomic task checkin + strict admin check (no lzk fallback); dedupe front-end reward display`

改动 6 个文件、+211/-44 行。含一个新增测试脚本、未跑云环境冒烟、未部署。
