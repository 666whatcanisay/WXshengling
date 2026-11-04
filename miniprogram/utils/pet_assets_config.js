/**
 * Pet V8.3 — 宠物资源管理器（云存储版）
 *
 * V8.3变更: 图片从本地主包迁移至云存储(cloud://)
 *   原因: 60张thumb图=1.53MB，超微信主包1.5MB限制
 *   解决: 图片上传云存储后不计入主包体积
 *
 * 资源体系：
 *   - 蛋：3种 x 3阶段 = 9张（CSS绘制，无外部文件）
 *   - 宠物：15物种 x 4阶段 = 60张（云存储 _thumb.png）
 */

var SpeciesConfig = require('./speciesConfig')

// ===== 云存储基础路径 =====
// 格式: cloud://{env-id}.{bucket-id}/{目录}/
// 上传时需保持此目录结构: pets/{物种}/{阶段}_thumb.png
// 如需切换回本地(开发调试), 改为 '/assets/pets/species/assets/pets/' 即可
var PIPELINE_BASE = 'cloud://cloud1-d5gz9j6zh654f4b36.636c-cloud1-d5gz9j6zh654f4b36-1442834549/pets/'

// ===== 阶段映射（大写KEY → Pipeline文件名）=====
var STAGE_MAP = {
  EGG: '',          // 蛋无物种贴图
  BABY: 'baby',
  YOUTH: 'youth',
  ADULT: 'adult',
  PERFECT: 'perfect',
}

// ===== 颜色变体（三档，MVP仅normal有图）=====
var COLOR_VARIANTS = ['normal', 'rare', 'shiny']

module.exports = {

  // ================================================
  //  核心API：获取图片路径（Pipeline映射层）
  // ================================================

  /**
   * 获取宠物贴图的完整路径（Pipeline映射）
   *
   * 映射逻辑：
   *   orange_cat + BABY + normal/rare/shiny
   *   → cloud://.../pets/orange_cat/baby_thumb.png
   *
   * @param {string} speciesId - 物种ID (如 'orange_cat')
   * @param {string} stageKey - 阶段key ('BABY'/'YOUTH'/'ADULT'/'PERFECT')
   * @param {string} colorKey - 颜色档次 ('normal'/'rare'/'shiny')，MVP均返回同一张
   * @returns {string} 云存储路径, 如 'cloud://.../pets/orange_cat/baby_thumb.png'
   */
  getPetImage: function(speciesId, stageKey, colorKey) {
    if (!speciesId || !stageKey || stageKey === 'EGG') return ''

    var sp = SpeciesConfig.getSpecies(speciesId)
    if (!sp) return ''

    var stageName = STAGE_MAP[stageKey] || ''
    if (!stageName) return ''

    // MVP: 所有颜色档次都指向同一张 normal 图
    // V8.2修复：使用 _thumb.png 压缩版（~25KB），避免 5MB 原图超微信 200KB 限制
    // 后续补了 rare/shiny 图片后，这里扩展即可
    return PIPELINE_BASE + speciesId + '/' + stageName + '_thumb.png'
  },

  /**
   * 获取蛋的背景渐变样式（不涉及外部图片文件）
   * @param {string} eggType - 蛋类型 ('forest_egg'/'home_egg'/'wild_egg')
   * @returns {string} CSS gradient 字符串
   */
  getEggGradient: function(eggType) {
    var eggInfo = SpeciesConfig.getEggType(eggType)
    if (eggInfo && eggInfo.pattern && eggInfo.pattern.bgGradient) {
      return eggInfo.pattern.bgGradient
    }
    return 'linear-gradient(145deg, #666 0%, #999 100%)'
  },

  // ================================================
  //  批量查询API
  // ================================================

  /**
   * 获取某个物种的全部图片路径（4阶段 x 3色 = 12张）
   * @param {string} speciesId
   * @returns {Array<{stage:string, color:string, path:string}>}
   */
  getAllImagesForSpecies: function(speciesId) {
    var self = this
    var paths = []
    Object.keys(STAGE_MAP).forEach(function(stageKey) {
      if (!STAGE_MAP[stageKey]) return // 跳过EGG
      COLOR_VARIANTS.forEach(function(color) {
        paths.push({
          stage: STAGE_MAP[stageKey],
          stageKey: stageKey,
          color: color,
          path: self.getPetImage(speciesId, stageKey, color),
        })
      })
    })
    return paths
  },

  /**
   * 获取全部物种的完整资源清单
   * @returns {{total:number, bySpecies:Array, missingCheck:Array}}
   */
  getFullInventory: function() {
    var allSpecies = SpeciesConfig.list
    var result = {
      total: 0,
      bySpecies: [],
      missingCheck: [],  // 所有应有路径的清单（用于缺失检测）
    }

    var self = this
    allSpecies.forEach(function(sp) {
      var images = self.getAllImagesForSpecies(sp.id)
      result.bySpecies.push({
        id: sp.id,
        name: sp.name,
        category: sp.category,
        imageCount: images.length,
        images: images,
      })
      result.total += images.length
      result.missingCheck = result.missingCheck.concat(
        images.map(function(img) { return img.path })
      )
    })

    return result
  },

  /**
   * 获取蛋类型列表（含花纹信息）
   */
  getEggTypes: function() {
    return SpeciesConfig.getEggTypeOptions()
  },

  // ================================================
  //  统计信息
  // ================================================

  /** 总图片数量（MVP: 15物种 x 4阶段 = 60张，仅normal）*/
  getTotalPetImageCount: function() {
    return SpeciesConfig.list.length *     // 15物种
           Object.keys(STAGE_MAP).filter(function(k) { return !!STAGE_MAP[k] }).length  // 4阶段
    // MVP: = 15 x 4 = 60（后续补 rare/shiny 后改为 x 3）
  },

  /** 蛋图片数量（CSS绘制，无外部文件）*/
  getEggImageCount: function() {
    return 0 // 蛋用CSS渐变+字符动画，无外部图片
  },

  /** 各分类的物种数 */
  getCategoryStats: function() {
    return {
      feline: SpeciesConfig.getSpeciesByCategory('feline').length,       // 5
      canine: SpeciesConfig.getSpeciesByCategory('canine').length,       // 5
      small_mammal: SpeciesConfig.getSpeciesByCategory('small_mammal').length, // 5
    }
  },

  /** 颜色变体统计 */
  getColorTierStats: function() {
    return COLOR_VARIANTS.map(function(c) {
      return {
        key: c,
        label: c === 'normal' ? '普通' : c === 'rare' ? '稀有' : '异色',
        probability: c === 'normal' ? '92%' : c === 'rare' ? '6%' : '2%',
      }
    })
  },

  // ================================================
  //  辅助方法
  // ================================================

  /** 获取 Pipeline 基础路径 */
  getBasePath: function() {
    return PIPELINE_BASE
  },

  /** 获取所有阶段key（含EGG）*/
  getAllStageKeys: function() {
    return Object.keys(STAGE_MAP)
  },

  /** 获取可渲染的阶段（排除EGG）*/
  getRenderableStages: function() {
    return Object.keys(STAGE_MAP).filter(function(k) { return !!STAGE_MAP[k] })
  },

  /**
   * Pipeline 对接：获取物种的完整预览数据（4阶段图片路径）
   * 用于 pet-preview 页面展示
   * @param {string} speciesId
   * @returns {Array<{stageKey:string, stageName:string, stageLabel:string, path:string}>}
   */
  getSpeciesStages: function(speciesId) {
    var self = this
    var stages = []
    var stageLabels = {
      BABY: '幼年', YOUTH: '少年', ADULT: '成年', PERFECT: '完美形态'
    }
    Object.keys(STAGE_MAP).forEach(function(key) {
      var stageName = STAGE_MAP[key]
      if (!stageName) return // skip EGG
      stages.push({
        stageKey: key,
        stageName: stageName,
        stageLabel: stageLabels[key] || key,
        path: self.getPetImage(speciesId, key, 'normal'),
      })
    })
    return stages
  },
}
