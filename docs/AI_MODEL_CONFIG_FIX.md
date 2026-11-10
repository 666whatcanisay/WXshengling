# AI配置保存、选择与调用修复 · 2026-11-06

对应D034。用户实际遇到app-node24.aiPlannerChat免费额度耗尽，且切换保存DeepSeek后回显仍是通义千问。本轮修复该旧链路，不接入新Agent或改变付费开关。

## 已核实原因

- 配置页保存后读取`keys[0]`；旧接口没有按更新时间排序，第一条不等于刚保存/当前选择。
- 规划师聊天、创建计划和执行生成三处固定`provider:'qwen'`，没有使用页面选择。
- 后端指定供应商查不到时会找任意有Key记录，DeepSeek缺省地址/模型也会回落成Qwen；原测试需要完整Key回传，旧清除按钮实际只发空Key而不会删除，却提示成功。
- 错误中的`Free quota exhausted`与阿里云`AllocationQuota.FreeTierOnly`对应，说明本次实际请求的模型免费额度耗尽；不等于云函数额度用尽或DeepSeek Key必然无效。

## 本地完成

- 读取公开配置按最近保存时间选择；旧云接口暂不带时间时，仅以账号隔离的供应商偏好兼容。偏好不含Key，新接口时间为准，跨设备使用最近保存的有效配置。
- 配置页区分当前使用与正在编辑的供应商，切换可恢复该供应商已有模型/地址/遮蔽Key；新Key留空保留旧Key，不把遮蔽字符串写回。保存完成再读取核对，失败不假报连接就绪。
- 聊天和两步生成读取同一公开配置；生成开始记录provider，执行沿用该provider，不在中途换供应商。
- 服务端查询不吞数据库错误；显式provider缺配置时拒绝，不用另一家的Key。按供应商补缺省地址/模型，兼容现有OpenAI格式HTTPS直连，不迁移CloudBase托管模型或新增SDK/收费资源。
- listApiKeys只返回供应商/地址/模型/has_key/末4位遮蔽值/时间，不返回完整Key；连接测试可在服务端取已保存Key。保存绕过会打印字段值的旧safeUpdate，LLM错误去掉原响应体拼接并遮蔽本次Key。保留原服务器数据库存储格式，本轮没有做加密迁移或查询历史日志。
- 删除以明确clear操作删除当前账号当前供应商，确认服务端cleared回执后再提示；其他服务商保留，界面显示剩余当前配置。
- 页面显示当前模型及规则降级状态；额度错误给中文原因，不伪装模型回复。保存不调用模型；用户主动测试/聊天/生成才调用供应商，可能计费。
- 官方当前DeepSeek默认是`deepseek-flash`，新配置使用`https://api.deepseek.com`；已有模型名/地址继续保留，不静默替换。当前Flash/V4直连默认用non-thinking以适配30秒函数，未跑真实付费请求，实际Key/余额/延迟仍需用户测试。

## 验证与云端材料

- Node24.22.2全套`npm run verify` **1052项通过**（此前1000+新增52）。新增tests/ai-provider-config.cjs使用实际云函数、真实SDK离线请求替身、实际页面及HTTPS替身，覆盖Qwen/DeepSeek保存回显、公开元数据、留空保留Key、密钥/日志不回传、准确供应商、请求地址/模型、两步生成固定provider、错误中文化、删除归属和读取失败。
- AI配置页WXML/WXSS及规划师WXML编译通过，相关JS语法/diff检查通过。不是微信/手机端验收，也没有真实模型调用。
- 只读云端核对：app-node24 Active、Nodejs24.11、30秒/256MB，ModTime 2026-11-05 11:41:59。下载源码与修复前HEAD（忽略CRLF差异）一致。
- `.migration/ai-provider-fix-20261106`保留原云端源码、回退index、补丁index及哈希清单。用户随后明确批准“现在更新app-node24”，已执行仅index.js增量更新并下载逐文件比对：补丁哈希一致，其余3778文件及函数配置哈希与更新前一致，状态Active，仍Nodejs24.11。公开证据见audit/ai-provider-fix-20261106.json，现为**deployed-and-source-verified**。
- `tools/ai-provider-cloud.cjs prepare`仅云端只读和本机打包。本次在明确确认后执行`apply --approved-app-node24-index`：复核ModTime/配置哈希、调用updateFunctionIncrementalCode，下载后逐文件比较；没有拿本地整包覆盖依赖。旧manifest的ModTime护栏会阻止误重放本次部署。

## 部署授权与待验收

用户已明确确认该具体范围并已完成：仅增量更新环境cloud1-d5gz9j6zh654f4b36的app-node24/index.js；保留运行时/依赖/函数配置，未改权限、旧app或其他函数，不改真实用户配置、不调用模型、不充值或发布小程序。没有用旧的前端授权替代本次云端确认，也没有扩大为所有后端升级。

部署源码核对已通过；用户随后在微信Console返回tools/ai-config-manual-readonly.js真实结果：currentProvider=deepseek、currentModel=deepseek-chat、fullKeyReturned=false，保留DeepSeek与Qwen两份有Key配置。确认原生配置读取/服务商选择及完整Key不回传，不等于页面回显/新保存/模型调用全部通过；用户未单独说明页面回显。

用户随后按保持当前DeepSeek/deepseek-chat点“测试连接”，回复“成功了”，未附原始提示。当前配置连接通过，保留已可用的模型名，不因新名称建议强制迁移；实际底层模型版本未核验。该调用由用户主动执行，audit中的modelCalls:false仅指部署工具没有调用模型。

用户进一步返回真实日志：AI聊天成功3106ms、replyLen=219；正常生成总4907ms、6项任务、标题“10天学会游泳”、编辑弹窗打开，并说明“没有问题，审核师那里有草稿”。由此确认配置修复后的规划聊天/正常生成与前端草案读取，未测试正式发布、真实审核结论或删除等分支，页面回显/新保存未单独确认。证据已补入同一audit文件；耗时是本次样本，不是性能承诺。

此外日志中生成请求goalContext.what仍为“先了解一下你”。本地调用实际Page._extractWhat('我想先了解一下你')得到相同错误目标；现有正则接受泛化短句、助手回复也可填空且已有目标一般不刷新，需要在真实审核前校正信息来源和旧目标更新。尚未实施这项新修复，不把它归为供应商切换失败，也不能只因生成标题正确忽略上下文不一致。下一阶段建议先修目标提取/依据，再接版本化草案审核与管家协作。

官方依据：[阿里云错误码](https://help.aliyun.com/en/model-studio/error-code-start)、[DeepSeek快速开始](https://api-docs.deepseek.com/)、[DeepSeek思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。
