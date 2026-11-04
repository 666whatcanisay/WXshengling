# Pet V7.1 Asset Pipeline — 技术模块说明

## 概述

宠物资源自动化生产流水线。输入物种配置，输出微信小程序可用的宠物贴图资源包。

**核心能力**：AI 生图 → 链式成长 → 自动抠图 → 压缩 → 缩略图，全流程无人值守。

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js v22+ |
| AI 引擎 | 阿里百炼 CLI (`bl`) v1.3+ |
| 图像处理 | `sharp` v0.35 |
| 配置格式 | JSON |
| 调度 | Bash / Node.js child_process |

## 目录结构

```
species/
├── pipeline/
│   ├── pipeline.js              # 主编排器 (CLI入口)
│   ├── config.js                # 集中配置
│   ├── species.json             # 15物种 × 4阶段 Prompt (已锁定)
│   ├── quality-gate.json        # 自动验收规则
│   ├── lib/
│   │   ├── bl-wrapper.js        # bl CLI 封装
│   │   ├── quota-manager.js     # 免费额度追踪 (共享池100张)
│   │   ├── scorer.js            # 四维评分 (生产模式禁用)
│   │   ├── quality-gate.js      # 质量门验证
│   │   ├── growth-fixer.js      # 自动成长修复 (缩放)
│   │   ├── image-utils.js       # sharp 图像处理
│   │   └── logger.js            # 时间戳日志
│   └── scripts/
│       ├── generate_baby.js     # Step 1: 生成幼年
│       ├── chain_grow.js        # Step 2: 链式成长
│       ├── select_best.js       # Step 3: 筛选
│       ├── debackground.js      # Step 4: 抠图
│       ├── compress.js          # Step 5: 压缩
│       ├── thumbnail.js         # Step 6: 缩略图
│       └── test-quota.js        # 额度测试
├── assets/pets/{species}/       # 最终产出 (15目录 × 8文件)
│   ├── baby.png                 # 512×512 RGBA
│   ├── youth.png
│   ├── adult.png
│   ├── perfect.png
│   ├── baby_thumb.png           # 128×128
│   ├── youth_thumb.png
│   ├── adult_thumb.png
│   └── perfect_thumb.png
└── work/{species}/              # 临时产物 (可删除)
```

## CLI 命令

```bash
# 单个物种
node pipeline/pipeline.js orange_cat

# 全部15物种
node pipeline/pipeline.js --all

# 预览配置（不调API）
node pipeline/pipeline.js --dry-run

# 成本预估
node pipeline/pipeline.js --estimate

# 额度测试
node pipeline/scripts/test-quota.js

# 列出物种
node pipeline/pipeline.js --list
```

## 6步流水线

```
Step 1  generate_baby     bl image generate (wan2.7-image-pro)
        ↓                  输出: work/{species}/candidates/baby_candidate_01.png
Step 2  chain_grow        bl image edit (qwen-image-2.0-pro)
        ↓                  baby→youth→adult→perfect
Step 3  select_best       生产模式: 取第一张
        ↓
Step 4  debackground      flood-fill 白底→透明 RGBA
        ↓
Step 5  compress          2048² → 512²  ≤300KB
        ↓
Step 6  thumbnail         128×128
        ↓
        assets/pets/{species}/
```

## 核心配置 (`config.js`)

```js
PRODUCTION_MODE: true           // 生产模式
GENERATE_MODEL: 'wan2.7-image-pro'   // 生图模型
EDIT_MODEL: 'qwen-image-2.0-pro'     // 编辑模型
FREE_POOL_LIMIT: 100            // 共享免费池
ALLOW_PAID_MODEL: false         // 禁止付费
CANDIDATES_PER_STAGE: 1         // 每阶段1张
RETRY_MAX: 0                    // 不重试
SCORE_ENABLED: false            // 不评分
FINAL_SIZE: 512                 // 输出尺寸
FINAL_MAX_KB: 300               // 文件上限
```

## 添加新物种

编辑 `pipeline/species.json`，按模板增加一条：

```json
"new_species": {
  "category": "feline",
  "name_zh": "新物种",
  "name_en": "New Species",
  "attribute": "活力",
  "prompts": {
    "baby": "一只可爱的...Q版手游宠物立绘风格...纯白背景...",
    "grow_youth": "让这只...保持完全相同角色...身体比幼崽阶段大约15%...",
    "grow_adult": "让这只...身体比少年阶段大约15%...",
    "grow_perfect": "让这只...身体略小于成年阶段...金色发光边框..."
  }
}
```

Prompt 锚点已锁定在全部现有物种中，新物种复制同样的风格段落即可。

## 对外接口

外部项目集成时只需要：

```js
// 1. 调用流水线
const { execSync } = require('child_process');
execSync('node pipeline/pipeline.js orange_cat', { cwd: 'species/' });

// 2. 读取产出
const assetsDir = 'species/assets/pets/orange_cat/';
// baby.png, youth.png, adult.png, perfect.png (512×512 RGBA)
// baby_thumb.png ... (128×128)

// 3. 读取配置
const species = require('./pipeline/species.json');
// 15物种的 Prompt、分类、属性

// 4. 读取天赋
const talents = species._talents;  // 10种天赋定义
```

## 输出规格

| 参数 | 主图 | 缩略图 |
|------|------|--------|
| 尺寸 | 512×512 | 128×128 |
| 格式 | PNG RGBA | PNG RGBA |
| 通道 | 4 (含Alpha) | 4 (含Alpha) |
| 大小 | ≤300KB | ≤50KB |
| 背景 | 透明 | 透明 |

## 额度模型

所有百炼图像模型共享 **100张免费池**。`quota-manager.js` 追踪每次调用，池耗尽时抛 `FREE_QUOTA_EXHAUSTED` 并停止。`ALLOW_PAID_MODEL=false` 确保不消耗余额。

## 依赖

```bash
npm install sharp          # 图像处理
bl auth login              # 百炼认证
```

## 当前状态

- 代码冻结，不再优化
- 15物种目录全部就位 (11个AI生成 + 4个橘猫占位)
- 占位物种后续替换: `assets/pets/{species}/*.png` 直接覆盖
