# Node24前端入口切换

2026-11-05，D024。用户要求继续上一轮入口切换安排，并说明小程序已经正式发布。

## 本轮结果与边界

- 本地待编译/下次发版使用app-node24、login-node24；统一入口为miniprogram/utils/cloudConfig.js，初始化和每次调用使用同一env。页面不直接写云函数名。
- 线上已发布包不会因本地文件修改而更新。本轮没有上传/发布小程序、更新旧函数源码或修改云权限；旧app/login保留供现有线上用户使用。正式发布版本号和源码尚未核实。
- 本轮未修改WXML/WXSS。目标详情日期选择、AI草案周期/任务日期编辑、发布后保留待确认稿等是此前本地改动，编译后仍可见，见SINGLE_GOAL_PLAN.md及AI_PUBLICATION.md。
- 网络重试始终使用配置中的同一后端，没有自动回落旧app。35项新增本地检查覆盖实际客户端适配层、函数handler与实际SDK的离线请求传输，包括响应丢失后的发布重试、重复奖励、网络重试、错误提示和名称选择。加原496项，npm run verify共531项通过；38份生产JS语法通过。离线的旧名称用例仅验证路由选择，不证明旧部署支持新API。
- 云端只读复查六函数Active、六集合ADMINONLY、init-node24客户端拒绝，旧app/login仍按原通配规则可调用。证据audit/node24-client-cutover-20261105.json；本轮没有创建测试业务数据。

## 用户编译检查

在微信开发者工具点“编译”，不需要重新部署云函数或上传小程序。在Console执行：

```js
getApp().checkCloudConnection()
  .then(r => console.log('Node24入口检查', JSON.stringify(r)))
  .catch(e => console.log('入口检查失败', e.message || e))
```

预期functions为app-node24/login-node24、cachedOffline=false、loginVerified=true、tasksReadable=true。此诊断通过真实cloudApi读取当前身份/今日任务，不调用注册、init、宠物或模型，不输出openid/密码。cachedOffline=true表示当前缓存是旧离线展示状态，不能据此验收页面。

随后只读查看首页、目标列表、任一目标详情切换日期、AI规划师和“我的→成长日志”。正常应读出原有数据，日期切换不报错；空日期显示空列表，不要求一定有任务。本轮先不新增/打卡/生成模型。当前编译与页面检查结果待用户返回；手机端和普通微信身份仍未验收。

## 回退与旧版兼容

- 本地应急选择旧接口时，同时把cloudConfig.functions改为app/login，再重新编译；不改env或数据库权限。
- 旧app不支持publishAiPlan，新前端不能仅切旧函数名就当作完整回退。完整发布回退要配套已核实的原前端版本；正式发布的上一个版本号/源码目前未知，需在发版前补齐。发布前当前线上版本继续可用。
- 不在新版编译/发布前禁止旧app/login；[官方函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)按函数名控制客户端调用，直接拒绝旧名会影响仍使用旧包的用户。管理调用不受该客户端规则保护，init也不能拿来做健康检查。
- 原app的旧管理员username兜底、非原子打卡仍存在，六集合ADMINONLY不能代替云函数内授权/事务。不能宣称旧版安全问题已经修复。下一阶段首选准备并评审保持旧接口/名称的最小安全补丁，另明确部署范围；新版发布稳定后再决定限制旧入口。
- 登录页仍有lzk超时离线管理员与本地默认经验模板，本轮未改这项旧行为。正式发布前应单独收尾，避免失败被显示为成功；不将客户端角色显示当后端授权。
- 普通账号真实隔离需另一个真实微信在对应版本检查，不能在lzk请求里换openid模拟，也不临时修改管理员role做验收；本轮离线普通角色拒绝测试不能代替这项真机证据。

环境与调用方式沿用微信wx.cloud，[官方示例](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)支持每次callFunction的config.env。本轮复用现有适配层与配置模块，无新框架或依赖升级。

后续：先核对编译与页面，确定已发布版本及旧入口兼容修复/回退，再讨论单目标LangGraph管理、规划、审核角色和模型供给；不因一轮“继续”自动上线或引入Agent。
