# 已发布旧app兼容补丁

2026-11-05，D025。用户要求继续D024后的旧版权限/重复奖励兼容补丁与回退准备。本地实现、验证和云端备份已完成；原app覆盖部署待确认。

## 可评审的改动

- 环境cloud1-d5gz9j6zh654f4b36 / ap-shanghai，目标仅旧云函数app的index.js；保留原名称、Nodejs16.13、30秒/256MB、依赖、全部接口/路由与访问规则。不上传小程序、不改login/init或Node24副本，不主动写业务数据。
- checkAdmin移除username=lzk兜底，必须按真实微信调用者自己的users.role验证；空身份、查不到或读取异常都拒绝。管理员14入口继续走原校验函数。
- taskCheckin核心复用固定提交0545996已验收的事务：完成任务、用户XP、日志、成长池一起结算；事务内重读任务，重复返回already_completed/xp_earned=0。拒绝北京日期的未来任务，保持旧请求字段和成功回执；冲突失败可用同任务ID重试。
- 旧目标天数派生段原样保留在事务后，原repairGoalDays及全局UTC日期函数不变；没有捆入新版排程/发布/宠物业务。历史完成任务不会重算XP，旧前端的额外hatchProgress/显示兜底仍未统一，不能据此宣称宠物奖励和目标统计已全部修复。
- 复现构建器tools/prepare-legacy-app.cjs仅接受白名单基线哈希与固定Git源码；证明除checkAdmin/taskCheckin两函数外原文件字节不变。评审差异见migration/legacy-app/index.patch；原index回退文件位于忽略目录。

## 验证与云端核对

- 新下载线上完整app备份，index SHA256=d485b3cdae824b1e3b07e595ce35908ffb4c45b2ae79a21514af001f0cc231d0，与准备基线一致；下载前后ModTime未变化。
- 补丁SHA256=9aca735d92ddff98ceb4a4bd4f152c3fda447e0e63e7281a320e725e0c5504bf。ManagerSDK增量打包预演确认只有index.js，ZIP约47.7KB。
- 补丁在Windows Node24.22.2与官方便携Node16.13.0下各220项检查通过（原14管理员入口拒绝、并发、回滚/重试、跨用户/未来任务等）。Node16测试替身仅补structuredClone=v8序列化，不进入云代码；不是云端Linux业务写入验收。
- 当前主线npm verify另531项通过。构建重复一致，基线/固定源码被篡改即拒绝。云备份与本地实际SDK一致：wx-server-sdk2.4.0、database1.2.2、node-sdk2.4.7。
- 只读预检确认旧app仍Active/Node16.13、配置未变化；六核心集合ADMINONLY及原函数规则仍在。证据audit/legacy-app-hotfix-20261105.json。没有调用init、模型或新增目标/任务。

## 部署与回退边界

准备采用[官方单文件增量更新API](https://docs.cloudbase.net/api-reference/manager/node/function)，避免重新安装/打包已发布函数的依赖。tools/legacy-app-cloud.cjs preflight只读检查云状态并本地打包；apply仅在本轮具体原app更新确认记录存在后执行，更新前再次核对ModTime/哈希和配置，差异即停止。

更新后下载完整云包，确认index哈希命中、其他全部文件逐个哈希不变，运行时/超时/角色/环境变量/触发器/函数规则不变，再由用户用真实微信进行旧app只读检查。无需编译或上传小程序，旧名调用会立即使用新后端代码；新前端仍调用Node24副本。

原源码及完整云包在.migration/legacy-app-cloud-backup-20261105，单文件回退材料在.migration/legacy-app-reliability-20261105/rollback。回退只还原已核实的index，不还原整个用户/数据库、不删除函数；但原index带有已知权限与重复奖励缺陷，不能自动回退掩盖失败。

本轮尚未更新旧app、未做旧app真实打卡写入测试；以前批准的Node24限量数据测试已经清理完毕，不自动复用其额度创建新数据。当前正式发布的小程序版本号及前端源码仍待核实，不声称完整客户端回退已准备。

下一阶段建议：在确认范围内更新原app并读检，再收尾本地登录页“超时离线管理员/默认经验”假成功路径与旧前端额外成长调用的边界；随后集中讨论LangGraph单目标角色和模型供给。正式小程序发版另定。
