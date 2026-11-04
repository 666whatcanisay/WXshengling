# generate_pet_species

## 描述
生成一个完整的宠物物种资源集（baby/youth/adult/perfect 四阶段），
包含 AI 生成、自动筛选、抠图、压缩、缩略图全流程。

## 用法
```
/generate_pet_species <species_id>
```

## 参数
- `species_id`（必填）：`pipeline/species.json` 中定义的物种标识
  - 当前可用：`orange_cat`（橘猫）、`shiba`（柴犬）、`fox`（狐狸）

## 示例
```
/generate_pet_species orange_cat
/generate_pet_species fox
```

## 执行流程

| Step | 操作 | 工具 |
|------|------|------|
| 1 | 生成 baby 候选图（3张） | `bl image generate` |
| 2 | 链式成长派生（baby→youth→adult→perfect） | `bl image edit` |
| 3 | 四维评分自动筛选最优 | 像素分析 |
| 4 | 白底 → 透明 RGBA（flood-fill 抠图） | `sharp` |
| 5 | 压缩至 512×512 ≤300KB | `sharp` |
| 6 | 生成 128×128 缩略图 | `sharp` |

## 输出
```
assets/pets/{species_id}/
├── baby.png           # 512×512 RGBA ≤300KB
├── youth.png
├── adult.png
├── perfect.png
├── baby_thumb.png     # 128×128
├── youth_thumb.png
├── adult_thumb.png
└── perfect_thumb.png
```

## 实现
```
node pipeline/pipeline.js <species_id>
```

## 依赖
- Node.js v22+
- sharp（已安装）
- bl CLI v1.3+（需已认证 Aliyun Model Studio）

## 错误处理
- API 调用失败自动重试 2 次（指数退避 5s/15s）
- 单张候选图失败不影响其他候选
- 某阶段全部候选失败则终止并报告

## 中间产物
临时文件保存在 `work/{species_id}/`（含候选图、评分报告、抠图中间产物），
调试完成后可手动清理。
