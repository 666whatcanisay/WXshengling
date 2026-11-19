<div align="center">

# AI 自律森林

**AI 目标规划与宠物陪伴养成微信小程序**

LangGraph · TypeScript · Node.js 24 · CloudBase

[工作流](#从一个学习目标开始) · [设计理念](#设计理念与分层协作) · [技术亮点](#技术亮点) · [运行与代码](#技术栈与代码入口)

</div>

面向学习、备考和习惯管理，通过 AI 协作把目标变成可执行任务。打卡积累的成长用于领蛋、灌注和孵化，日常聊天让每只宠物逐渐形成自己的相处习惯。

我独立完成需求与交互设计、原生小程序、云函数、Agent 工作流、宠物养成及部署联调。项目为本科毕业设计，已备案上传，当前供本人及授权同学使用。

- **Agent 协作执行**：LangGraph 编排规划与审核，经版本校验和用户确认后事务发布，支持协作进度恢复和丢回执重试。[查看工作流源码](agents/forest-steward/src/index.ts)
- **宠物陪伴养成**：任务成长连接孵化与养成，聊天按宠物隔离角色和记忆，从有来源的跨日互动中学习相处习惯。[查看聊天与记忆实现](cloudfunctions/app/lib/petChat.js)

<p align="center">
  <a href="docs/showcase/images/ai-partners.png"><img src="docs/showcase/images/ai-partners.png" width="260" align="top" alt="AI 伙伴入口：森林管家工作区及规划师、审核师、教练和宠物聊天"></a>
  <a href="docs/showcase/images/pet-growth.png"><img src="docs/showcase/images/pet-growth.png" width="260" align="top" alt="宠物成长档案：猞猁的身体阶段、先天气质、成长进度和饱食状态"></a>
</p>

*AI 伙伴入口与宠物成长档案。作者提供的微信开发者工具实拍，反映截取时的页面状态，点击可查看原图。*

## 从一个学习目标开始

以「三天内每天学 20 分钟英语」为示例。规划师把目标整理成草案，审核师检查安排，用户改稿并确认后发布正式任务。打卡积累的成长可用于森林养成，宠物聊天承接日常陪伴。执行遇到困难时，教练根据记录提出调整建议，用户查看差异后决定是否应用。

### 目标执行工作流

在管家协作稿中明确设置每日 20 分钟硬上限，同日 25 分钟的安排会被规则检查拦截。保存新版后重新审核，发布前由后端复核当前版本。

```mermaid
flowchart TD
    A["描述目标<br/>规划师出稿"] --> B{"规则检查"}
    B -->|"通过"| C["语义审核<br/>给出建议"]
    B -->|"不符"| D["手动改稿<br/>保存新版"]
    D --> B
    C --> E["用户核对<br/>确认发布"]
    E --> F{"版本规则<br/>再次核对"}
    F -->|"旧稿或超额"| D
    F -->|"通过"| G["事务保存<br/>目标任务回执"]
    G -->|"有回执"| H["用户执行打卡<br/>成长进入养成"]
    G -->|"丢响应"| R["按原确认<br/>恢复同一回执"]
    R --> H
    H --> I["教练复盘<br/>用户选择建议"]
    I --> J["预览调整<br/>复查并确认"]
    J --> K["事务应用<br/>已有未来任务"]
    K --> H
```

发布结果未知时恢复原确认，重复请求返回同一回执。任务调整只处理明天起 7 天内、最多 20 项已有未完成任务。协作按步骤保存进度，用户离开后可在返回时主动继续。

### 宠物陪伴工作流

每只宠物从初见建立自己的聊天关系。身体阶段来自已有养成记录，表达方式由先天气质、手动设置和后来学会的习惯共同影响。

```mermaid
flowchart TD
    A["核对当前宠物<br/>读取气质与设置"] --> B["组装近期对话<br/>相关记忆与近况"]
    B --> C["模型生成回复<br/>可附习惯线索"]
    C --> D["核对用户原话<br/>按跨日规则积累"]
    D --> E["同次保存回复<br/>及有效习惯证据"]
    E --> F["下一轮聊天<br/>使用已形成习惯"]
    F -.-> B
```

「留到下次」保存一件经主人确认的事项。安慰、庆祝和玩笑习惯从反复相处中积累，近 14 天内同一方向达到 3 个成功回合、跨至少 2 个北京时间日期才形成，主人可纠正或撤回。无效习惯线索会被忽略，正常回复仍可保存。

## 设计理念与分层协作

- **把努力接到可见成长。** 规划、打卡和复盘帮助用户推进目标，已有经验与成长结算连接灌注和孵化，宠物陪伴延续日常相处。执行记录和聊天经历各自保留来源。
- **让协作和独立使用共用能力。** 森林管家维护一次目标协作的进度，规划师、审核师和教练也有独立入口。交接传递目标或草案引用，后端重新核对归属与版本。
- **明确模型与业务各自负责什么。** 规则代码计算日期、时长和成长，模型生成草案、语义意见和回复。用户确认正式变更，后端完成权限、版本及事务校验。

| 层次 | 当前实现与职责 |
| --- | --- |
| 协调流程 | 森林管家用 LangGraph 的预定义路由组织步骤、保存检查点、等待用户继续。 |
| 专业能力 | 规划师生成草案，审核师结合规则与语义意见检查，教练基于执行事实复盘。 |
| 业务执行 | Node.js 云函数核对身份、归属和规则，通过事务发布计划、调整任务与结算成长。 |
| 独立陪伴 | 宠物聊天按账号和宠物维护上下文，任务及喂食近况由用户选择带入。 |

当前协调采用代码驱动的有界流程。每次调用至多推进一次模型请求，分段保存状态，以适配现有云函数运行环境。页面关闭后当前请求可能完成，后续步骤由用户返回后继续。

## 技术亮点

### 1. LangGraph 检查点与分段恢复

规划、审核和确认跨越多次云函数请求。用 `StateGraph` 定义角色节点，以 `interrupt` 等待用户确认，自定义 `ForestSaver` 将检查点持久化。运行租约和步骤状态约束重复推进，用户重进可读取已保存进度。图工程打包为 CommonJS 产物，复用现有微信云函数和 SDK。

[图与检查点适配](agents/forest-steward/src/index.ts) · [运行状态与调度](cloudfunctions/app/lib/stewardRuns.js) · [构建入口](tools/build-steward.cjs) · [协作回归](tests/steward-workflow.cjs)

### 2. 规则审核、版本绑定与事务回执

手改后旧审核会失效，草案版本和指纹绑定要求、任务及审核结果。规则代码检查日期与时长，模型补充可执行性和递进建议。发布先保存原确认稿，再事务提交目标、任务和回执，超时重试可恢复同一结果，避免重复目标。签到与打卡也通过事务处理重复及并发结算。

[草案版本](cloudfunctions/app/lib/plannerDrafts.js) · [审核规则](cloudfunctions/app/lib/plannerReviewRules.js) · [发布事务](cloudfunctions/app/lib/planPublication.js) · [发布回归](tests/ai-publication-reliability.cjs) · [打卡回归](tests/checkin-reliability.cjs)

### 3. 带证据指纹的复盘调整

教练把目标、日期、执行事实和反馈绑定到证据指纹。建议通过引用交给调整流程，应用前重读来源、复查版本与规则，冲突时整批拒绝。用户确认差异后事务修改已有未来任务，保留执行历史和奖励，防止过期建议覆盖当前安排。

[事实计算](cloudfunctions/app/lib/coachFacts.js) · [调整草案](cloudfunctions/app/lib/adjustmentService.js) · [应用事务](cloudfunctions/app/lib/adjustmentApplication.js) · [应用回归](tests/adjustment-application.cjs)

### 4. 逐宠记忆与有来源的习惯形成

复用已有七种随机先天气质，按账号和宠物分别维护手动设置、近期对话、确认的待续事项及习惯。模型提出线索，服务端核对引用是否来自本轮用户原话，再按成功回合和北京时间日期去重积累。习惯记录保留来源与形成时间，支持纠正和撤回，让角色变化可以查看和解释。

[聊天上下文](cloudfunctions/app/lib/petChat.js) · [初见与习惯证据](cloudfunctions/app/lib/petChatGrowth.js) · [聊天回归](tests/pet-chat.cjs)

### 5. 稳定 Prompt 前缀与上下文预算

聊天将固定规则和角色资料前置，把本轮近况、相关待续放在动态输入段，并按固定顺序组织习惯。近期历史按回合数和字符预算裁剪，控制每轮上下文长度。供应商返回有效用量时记录缓存命中和输入 Token，便于后续测量效果。当前已实现前缀复用和统计校验，实际命中率与费用收益待实测。

[提示词与缓存用量处理](cloudfunctions/app/lib/petChat.js) · [稳定前缀及统计边界回归](tests/pet-chat.cjs) · [实现记录](docs/PET_INTEGRATION_READINESS.md)

<details>
<summary>展开首页、AI 配置与管理后台截图</summary>

**首页。** 签到、今日经验、宠物轮播和任务集中展示，截图保留了签到成功提示。森林提供 15 个物种的四阶段形象，共用基础动画和高天赋装饰配置。

<p align="center">
  <a href="docs/showcase/images/home-checkin.png"><img src="docs/showcase/images/home-checkin.png" width="280" alt="首页：签到增加 10 XP、问候卡、宠物轮播和今日任务"></a>
</p>

**AI 配置。** 支持 DeepSeek、OpenAI 等预设及自定义兼容接口，提供模型、Base URL 和连接测试，密钥以掩码显示。实际可用模型取决于供应商配置。

<p align="center">
  <a href="docs/showcase/images/ai-settings.png"><img src="docs/showcase/images/ai-settings.png" width="280" alt="AI 配置：供应商、掩码密钥、Base URL、模型名与连接测试"></a>
</p>

**管理后台。** 提供用户、宠物和反馈管理，由服务端检查管理员权限。统计卡用于说明界面。

<p align="center">
  <a href="docs/showcase/images/admin.png"><img src="docs/showcase/images/admin.png" width="280" alt="管理后台：统计卡、用户管理标签和操作入口"></a>
</p>

</details>

## 技术栈与代码入口

- **客户端**：原生 JavaScript、WXML、WXSS，`wx.cloud` 调用云函数。[AI 伙伴](miniprogram/pages/ai/) · [森林管家](miniprogram/pages/forest-steward/) · [宠物页](miniprogram/pages/pets/)
- **AI 与业务后端**：TypeScript、LangGraph.js、Node.js 24、`wx-server-sdk`、CloudBase 文档数据库与事务。[图源码](agents/forest-steward/src/index.ts) · [业务服务](cloudfunctions/app/lib/) · [身份与业务入口](cloudfunctions/app/index.js)
- **验证**：Node.js 断言与 `node:test`，隔离云 SDK 传输，微信开发者工具编译器检查模板和样式。[业务回归](tests/) · [界面检查](tools/verify-ui.cjs) · [开发文档](docs/README.md)

## 运行与验证

**使用情况。** 已备案上传，当前供本人及授权同学使用。源码和开发截图可直接浏览，真实运行需配置自己的微信云开发环境。

**验证记录。** 2026-11-11 记录包含 `npm run verify` 通过、22 份 WXML 和 23 份 WXSS 编译检查，以及 Node24 云函数核对。当前工作区包含晚于云端的修复，最新源码与配套云函数的普通账号真机全流程、模型回复质量及缓存命中率待统一实测。[查看实现与验证边界](docs/CURRENT_STATE.md)

<details>
<summary>展开本地运行与环境配置</summary>

准备 Git、Node.js **24.x**（`.nvmrc` 固定 `24.22.2`）和微信开发者工具。当前实现以 `codex/forest-current-snapshot` 分支为入口。

```powershell
git clone https://github.com/666whatcanisay/WXshengling.git
cd WXshengling
git switch codex/forest-current-snapshot
npm ci
npm ci --prefix cloudfunctions/app --ignore-scripts
npm run verify
```

`verify` 使用隔离传输替身检查本地业务逻辑。真实微信登录、数据库和模型体验需连接自己的开发环境。

在微信开发者工具中导入仓库根目录，配置 `project.config.json` 的 AppID 和[云环境与函数映射](miniprogram/utils/cloudConfig.js)。源码目录 `cloudfunctions/app`、`cloudfunctions/login` 对应当前客户端的 `app-node24`、`login-node24`。按[云开发接入与权限说明](docs/NODE24_CLOUD_PREFLIGHT.md)准备数据库和配套函数，在「我的 → AI 配置」设置供应商，再从「AI → 森林管家」进入协作。

修改 Agent 图时安装图工程依赖并重建，已有构建产物随源码保存。

```powershell
npm ci --prefix agents/forest-steward
npm run build:steward
```

`npm run verify:ui` 调用本机微信编译器，位置可通过 `WECHAT_DEVTOOLS_DIR` 配置。

</details>

## 数据与许可

真实业务记录保存在作者自己的云开发环境中，复现时使用自己的账号、数据库与模型配置。API Key 和登录凭据通过配置管理，个人工具配置与本机凭据由 `.gitignore` 排除。

仓库目前未附开源许可证。代码与宠物素材的使用授权请与作者确认。
