# AI 自律森林

微信小程序：目标与任务管理、打卡成长、宠物养成及 AI 规划。基于原生 JavaScript/WXML/WXSS、微信云开发及云函数，正在补齐单目标流程并评估分层 Agent。

## 本地开发

使用 Node.js **24.x**，`.nvmrc` 固定本次验证版本24.22.2。切换版本后：

```powershell
npm ci
npm run verify
```

`verify` 检查Node主版本并运行生产源码的隔离业务回归，不连接云端、不调用真实模型。微信开发者工具打开本目录运行页面；页面使用微信JavaScript环境，工具自带Node与电脑默认Node独立。

## 当前边界

- 本地日期/周期与任务流程有改动，尚未部署；线上三个函数仍为Node16。详见 [项目状态](docs/README.md)。
- LangGraph.js仅有[隔离兼容实验](experiments/langgraph-compat/README.md)，正式多Agent尚未完成。
- [Node24迁移准备](docs/NODE24_MIGRATION.md)从已下载的线上基线生成新函数副本材料，不自动部署，不混入未上线业务改动。
- API Key在应用配置或云端管理；不要写入源码。个人微信开发者工具配置、工具缓存和依赖目录不提交。

## 接手项目

先读 [AGENTS.md](AGENTS.md) 和 [docs/README.md](docs/README.md)，区分已实现、本地验证、线上已部署与候选方案。

