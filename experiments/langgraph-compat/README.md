# LangGraph.js 隔离适配实验

仅用于技术选型，不是小程序正式依赖、Agent 服务或真实业务实现。

已在 Windows / Node.js 22.16.0 验证。依赖版本固定在本目录 package.json / package-lock.json，不改根目录及云函数的依赖。

```powershell
cd experiments/langgraph-compat
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`npm test` 编译 TypeScript，运行确定性角色流程及腾讯官方 CloudBaseSaver，启动独立 Node 子进程检查恢复，将结果写到 `docs/audit/langgraph-compat-20261104.json`。临时数据库在忽略提交的 `probe-data` 中，不自动清理历史文件。

15 项检查涉及审核修订上限、确认/拒绝、节点重入、失败重试、不同线程及不同 userId 的读取隔离、跨进程恢复、历史查询/删除、CommonJS 导入。确认使用 `{ approved: boolean }` 对象；本次直接用 `resume: false` 时出现 EmptyInputError，因此未将该写法用于最终示例。

边界：

- `plan/critic/revise` 是确定性替身，不调用模型，也没有验证真实上层 Agent 的判断、委派、耗时或质量。
- `FileDb` 是本地文件数据库替身，只覆盖实验所需 API；不连接 CloudBase，不证明云数据库、事务、安全规则或索引可用。
- `applyDryRun` 只更新图状态，没有创建目标/任务、发奖或部署。完成后空输入不重复执行不等于所有故障和并发下恰好执行一次。
- userId 在实验内固定；正式身份必须由服务端验证，不能信任客户端传来的 userId/thread_id。
- 安装禁用了生命周期脚本；传递依赖 mem0ai / Anthropic SDK 存在 peer 版本警告。成功导入不证明完整适配器、原生模块和服务端通信全部可用。

结论及下一阶段建议见 `docs/LANGGRAPH_EVALUATION.md`。
