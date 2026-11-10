﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * Pet V8.0 — 物种配置中心（概率池物种 / 三档颜色 / 天赋系统）
 *
 * V8.0 核心变化（V7.1→V8.0）：
 *   - 新增天赋(talent)系统：孵化时生成1~100，永久不变
 *   - 天赋等级：F(普通) / D(良好) / C(优秀) / B(卓越) / A(天才) / S(传奇)
 *   - 天赋影响成长加成：S级每次+4~5，F级固定+1
 *
 * 保留V7.1：
 *   - 属性→物种概率池（60/25/15权重）
 *   - 三档颜色变体（普通92%/稀有6%/异色2%）
 *   - 完美体门槛1200~2500
 */

module.exports = {

  // ===== 15种物种定义 =====
  list: [
    // === 森林系 feline（猫科）— 由森林蛋孵化 ===
    { id: 'orange_cat',    name: '橘猫',       category: 'feline', icon: '🐱', asset: '' },
    { id: 'black_cat',     name: '黑猫',       category: 'feline', icon: '🐈‍⬛', asset: '' },
    { id: 'calico_cat',    name: '三花猫',     category: 'feline', icon: '🐈', asset: '' },
    { id: 'snow_leopard',  name: '雪豹',       category: 'feline', icon: '❄️', asset: '' },
    { id: 'lynx',          name: '猞猁',       category: 'feline', icon: '🦊', asset: '' },

    // === 家园系 canine（犬科）— 由家园蛋孵化 ===
    { id: 'husky',         name: '哈士奇',     category: 'canine', icon: '🐕', asset: '' },
    { id: 'wolf',          name: '狼',         category: 'canine', icon: '🐺', asset: '' },
    { id: 'corgi',         name: '柯基',       category: 'canine', icon: '🐕', asset: '' },
    { id: 'golden_retriever', name: '金毛',   category: 'canine', icon: '🐕', asset: '' },
    { id: 'shiba',         name: '柴犬',       category: 'canine', icon: '🐕', asset: '' },

    // === 荒野系 small_mammal（小型兽类）— 由荒野蛋孵化 ===
    { id: 'fox',           name: '狐狸',       category: 'small_mammal', icon: '🦊', asset: '' },
    { id: 'chinchilla',    name: '龙猫',       category: 'small_mammal', icon: '🐭', asset: '' },
    { id: 'raccoon',       name: '浣熊',       category: 'small_mammal', icon: '🦝', asset: '' },
    { id: 'capybara',      name: '水豚',       category: 'small_mammal', icon: '🐾', asset: '' },
    { id: 'hamster',       name: '仓鼠',       category: 'small_mammal', icon: '🐹', asset: '' },
  ],

  // ===== 3大分类 =====
  categories: {
    feline:       { name: '森林系', icon: '🌲', dir: 'feline' },      // 猫科
    canine:       { name: '家园系', icon: '🏠', dir: 'canine' },      // 犬科
    small_mammal: { name: '荒野系', icon: '🌿', dir: 'wild' },        // 小型兽类
  },

  // ===== V7.1 核心：属性→物种概率池 =====
  // 孵化时读取四维属性，选择最高属性 → 对应概率池 → 按概率roll物种
  // 设计原则：主物种60% / 副物种25% / 稀有15%，保证收集感
  SPECIES_PROBABILITY_POOLS: {
    // ---- 森林蛋（猫科）----
    forest_egg: {
      vitality:  [
        { species: 'orange_cat',   weight: 60 },   // 主：橘猫
        { species: 'lynx',         weight: 25 },   // 副：猞猁
        { species: 'snow_leopard', weight: 15 },   // 稀：雪豹
      ],
      wisdom: [
        { species: 'snow_leopard', weight: 60 },   // 主：雪豹
        { species: 'black_cat',    weight: 25 },   // 副：黑猫
        { species: 'lynx',         weight: 15 },   // 稀：猞猁
      ],
      luck: [
        { species: 'calico_cat',   weight: 60 },   // 主：三花猫
        { species: 'orange_cat',   weight: 25 },   // 副：橘猫
        { species: 'snow_leopard', weight: 15 },   // 稀：雪豹
      ],
      resonance: [
        { species: 'black_cat',    weight: 60 },   // 主：黑猫
        { species: 'calico_cat',   weight: 25 },   // 副：三花猫
        { species: 'lynx',         weight: 15 },   // 稀：猞猁
      ],
      balanced: [
        { species: 'lynx',         weight: 50 },   // 主：猞猁（均衡代表）
        { species: 'snow_leopard', weight: 25 },   // 副：雪豹
        { species: 'black_cat',    weight: 25 },   // 副：黑猫
      ],
    },
    // ---- 家园蛋（犬科）----
    home_egg: {
      vitality: [
        { species: 'husky',            weight: 60 },
        { species: 'shiba',            weight: 25 },
        { species: 'wolf',             weight: 15 },
      ],
      wisdom: [
        { species: 'wolf',             weight: 60 },
        { species: 'golden_retriever', weight: 25 },
        { species: 'shiba',            weight: 15 },
      ],
      luck: [
        { species: 'corgi',            weight: 60 },
        { species: 'husky',            weight: 25 },
        { species: 'golden_retriever', weight: 15 },
      ],
      resonance: [
        { species: 'golden_retriever', weight: 60 },
        { species: 'corgi',            weight: 25 },
        { species: 'shiba',            weight: 15 },
      ],
      balanced: [
        { species: 'shiba',            weight: 50 },
        { species: 'wolf',             weight: 25 },
        { species: 'golden_retriever', weight: 25 },
      ],
    },
    // ---- 荒野蛋（小型兽类）----
    wild_egg: {
      vitality: [
        { species: 'fox',        weight: 60 },
        { species: 'hamster',    weight: 25 },
        { species: 'chinchilla', weight: 15 },
      ],
      wisdom: [
        { species: 'chinchilla', weight: 60 },
        { species: 'capybara',   weight: 25 },
        { species: 'hamster',    weight: 15 },
      ],
      luck: [
        { species: 'raccoon',    weight: 60 },
        { species: 'fox',        weight: 25 },
        { species: 'capybara',   weight: 15 },
      ],
      resonance: [
        { species: 'capybara',   weight: 60 },
        { species: 'raccoon',    weight: 25 },
        { species: 'hamster',    weight: 15 },
      ],
      balanced: [
        { species: 'hamster',    weight: 50 },
        { species: 'capybara',   weight: 25 },
        { species: 'fox',        weight: 25 },
      ],
    },
  },

  // ===== V7.1 三档颜色变体系统 =====
  // 普通(normal)92% / 稀有(rare)6% / 异色(shiny)2%
  COLOR_TIERS: {
    normal: { key: 'normal', label: '普通', probability: 0.92, suffix: 'normal',
              desc: '标准外观', effect: null },
    rare:   { key: 'rare',   label: '稀有', probability: 0.06, suffix: 'rare',
              desc: '边框发光+小特效', effect: { glow: true, borderGlow: '#448AFF' } },
    shiny:  { key: 'shiny',  label: '异色', probability: 0.02, suffix: 'shiny',
              desc: '特殊配色+特殊边框+特殊称号', effect: { glow: true, borderGlow: '#FFD700', shimmer: true } },
  },

  // ===== 蛋类型定义（3种 + 花纹系统）=====
  EGG_TYPES: {
    forest_egg: {
      name: '森林蛋',
      emoji: '🥚',
      desc: '来自神秘森林的蛋，倾向孵化出猫科动物',
      color: '#7CB342',
      hintCategory: 'feline',
      // 花纹：叶脉纹
      pattern: {
        type: 'leaf',
        bgGradient: 'linear-gradient(145deg, #5D8A32 0%, #7CB342 40%, #8BC34A 70%, #9CCC65 100%)',
        patternColor: 'rgba(255,255,255,0.12)',
        accentColor: '#C5E1A5',
        patternChars: ['🍃', '🌿', '☘️', '🌱', '🍀'],
        patternDesc: '叶脉纹理',
      },
    },
    home_egg: {
      name: '家园蛋',
      emoji: '🏠',
      desc: '温暖家园孕育的生命，倾向孵化出犬科动物',
      color: '#FF9800',
      hintCategory: 'canine',
      // 花纹：砖瓦纹
      pattern: {
        type: 'brick',
        bgGradient: 'linear-gradient(145deg, #E65100 0%, #FF9800 40%, #FFB74D 70%, #FFCC80 100%)',
        patternColor: 'rgba(255,255,255,0.10)',
        accentColor: '#FFE0B2',
        patternChars: ['🧱', '🏠', '🪵', '🔥', '⭐'],
        patternDesc: '砖瓦纹理',
      },
    },
    wild_egg: {
      name: '荒野蛋',
      emoji: '🌿',
      desc: '来自荒野深处的神秘之卵，倾向孵化出小型兽类',
      color: '#BF7846',
      hintCategory: 'small_mammal',
      pattern: {
        type: 'earth',
        bgGradient: 'linear-gradient(145deg, #8B6914 0%, #A67C00 30%, #C4923A 60%, #D4A84B 100%)',
        patternColor: 'rgba(255,248,220,0.15)',
        accentColor: '#FFD54F',
        patternChars: ['🌰', '🍂', '🌾', '✨', '🪨'],
        patternDesc: '大地纹理',
      },
    },
  },

  // ===== 宠物BUFF系统（保留）=====
  BUFFS: {
    orange_cat:   { type: 'checkin_xp', label: '签到奖励+5%',  value: 1.05, desc: '签到时额外获得5%奖励' },
    black_cat:    { type: 'study_xp',   label: '学习经验+5%',  value: 1.05, desc: '学习时额外获得5%经验' },
    calico_cat:   { type: 'task_xp',    label: '任务经验+5%',  value: 1.05, desc: '完成任务时额外获得5%经验' },
    snow_leopard: { type: 'study_xp',   label: '学习经验+5%',  value: 1.05, desc: '学习时额外获得5%经验' },
    lynx:         { type: 'checkin_xp', label: '签到奖励+5%',  value: 1.05, desc: '签到时额外获得5%奖励' },
    shiba:            { type: 'task_xp',    label: '任务经验+5%',  value: 1.05, desc: '完成任务时额外获得5%经验' },
    corgi:            { type: 'checkin_xp', label: '签到奖励+5%',  value: 1.05, desc: '签到时额外获得5%奖励' },
    husky:            { type: 'ai_xp',      label: 'AI对话+5%',   value: 1.05, desc: 'AI对话时额外获得5%经验' },
    wolf:             { type: 'study_xp',   label: '学习经验+5%',  value: 1.05, desc: '学习时额外获得5%经验' },
    golden_retriever: { type: 'all_xp',     label: '全经验+3%',   value: 1.03, desc: '所有场景额外获得3%经验' },
    hamster:   { type: 'study_xp', label: '学习经验+5%',  value: 1.05, desc: '学习时额外获得5%经验' },
    chinchilla:{ type: 'task_xp',  label: '任务经验+5%',  value: 1.05, desc: '完成任务时额外获得5%经验' },
    capybara:  { type: 'ai_xp',    label: 'AI对话+5%',   value: 1.05, desc: 'AI对话时额外获得5%经验' },
    fox:       { type: 'study_xp', label: '学习经验+5%',  value: 1.05, desc: '学习时额外获得5%经验' },
    raccoon:   { type: 'task_xp',  label: '任务经验+5%',  value: 1.05, desc: '完成任务时额外获得5%经验' },
  },

  // ===== 成长值来源配置（V6：统一入池，保留）=====
  GROWTH_SOURCES: {
    checkin:       { label: '每日签到', value: 5 },
    complete_goal: { label: '完成目标', value: 10 },
    streak_bonus:  { label: '连续打卡', value: 20 },
    ai_focus:      { label: 'AI专注计时', value: 15 },
  },

  // ===== 经验池配置（保留）=====
  POOL_CONFIG: {
    collectionName: 'user_growth_pool',
    autoConsume: true,
  },

  // ===== 成长阶段（V8.2：统一配置源，代理到 shared/petStageConfig.js）=====
  // 注意：此处的 GROWTH_STAGES 仅保留用于向后兼容的读取
  // 实际阈值判断已迁移到 PetStageConfig.getStageByGrowth()
  get GROWTH_STAGES() {
    var PetStageConfig = require('./shared/petStageConfig')
    return PetStageConfig.STAGES
  },

  // ===== V7.1 图片路径系统 =====
  // 基础路径
  IMAGE_BASE_PATH: '/assets/pets/species/',
  // 阶段列表（用于生成图片路径）
  STAGE_IMAGE_KEYS: ['baby', 'youth', 'adult', 'perfect'],
  // 颜色变体（三档：normal/rare/shiny）
  COLOR_VARIANTS: ['normal', 'rare', 'shiny'],

  // ===== 四维属性定义（范围 0~10）=====
  ATTRIBUTES: {
    vitality:  { name: '活力', icon: '🔥', color: '#FF5252', desc: '执行力与行动力', maxVal: 10 },
    wisdom:    { name: '智慧', icon: '📖', color: '#448AFF', desc: '学习能力与成长性', maxVal: 10 },
    luck:      { name: '幸运', icon: '⭐', color: '#FFD600', desc: '随机惊喜与好运', maxVal: 10 },
    resonance: { name: '共鸣', icon: '💗', color: '#F06292', desc: '陪伴感与情感连接', maxVal: 10 },
  },

  // ===== 阶段升级属性奖励范围（跨阶段时 +1~+3，V8.0：受天赋影响）=====
  STAGE_UP_BONUS: {
    minPerAttr: 1,
    maxPerAttr: 3,
    totalBonus: [1, 6],
  },

  // ===== V8.0 天赋系统（Talent）=====
  // 孵化时生成一次(1~100)，永久不变
  // 决定每次成长时的属性加成幅度和宠物独特性
  TALENT: {
    // 天赋等级定义
    grades: [
      { key: 'F', name: '普通', icon: '⚪', range: [1, 20],   color: '#9E9E9E',
        growthBonus: { min: 1, max: 1 },       // 固定+1
        desc: '平凡但可靠' },
      { key: 'D', name: '良好', icon: '🔵', range: [21, 40],  color: '#42A5F5',
        growthBonus: { min: 1, max: 2 },       // +1~2
        desc: '略高于常人' },
      { key: 'C', name: '优秀', icon: '🟢', range: [41, 60],  color: '#66BB6A',
        growthBonus: { min: 2, max: 2 },       // 固定+2
        desc: '出类拔萃' },
      { key: 'B', name: '卓越', icon: '🟡', range: [61, 80],  color: '#FFCA28',
        growthBonus: { min: 2, max: 3 },       // +2~3
        desc: '天赋异禀' },
      { key: 'A', name: '天才', icon: '🟠', range: [81, 95],  color: '#FF7043',
        growthBonus: { min: 3, max: 4 },       // +3~4
        desc: '万里挑一' },
      { key: 'S', name: '传奇', icon: '👑', range: [96, 100], color: '#FFD700',
        growthBonus: { min: 4, max: 5 },       // +4~5
        desc: '举世无双' },
    ],
    // 潜力星级映射（用于档案页展示）
    starMap: {
      F: 1, D: 2, C: 3, B: 4, A: 5, S: 5,     // S级也是5星但金色
    },
  },

  // ================================================
  //  V7.1 核心方法：概率池物种 / 三档颜色
  // ================================================

  /**
   * V7.1：根据四维属性和蛋类型，从概率池中roll物种
   * 规则：最高属性 → 对应概率池 → 按权重随机；均衡 → balanced池
   * @param {object} attributes - { vitality: N, wisdom: N, luck: N, resonance: N }
   * @param {string} eggType - 蛋类型 (forest_egg/home_egg/wild_egg)
   * @returns {string} speciesId - 物种ID
   */
  resolveSpeciesByAttributes: function(attributes, eggType) {
    var pools = this.SPECIES_PROBABILITY_POOLS[eggType] || this.SPECIES_PROBABILITY_POOLS.forest_egg
    var attrs = attributes || {}
    var v = attrs.vitality || 0
    var w = attrs.wisdom || 0
    var l = attrs.luck || 0
    var r = attrs.resonance || 0

    var maxVal = Math.max(v, w, l, r)
    var minVal = Math.min(v, w, l, r)

    // 四维均衡（差值 <= 5）→ 均衡池
    if (maxVal - minVal <= 5) {
      return this._rollFromPool(pools.balanced)
    }

    // 找最高属性（并列时随机选一个）
    var attrKeys = ['vitality', 'wisdom', 'luck', 'resonance']
    var maxAttrs = attrKeys.filter(function(k) { return attrs[k] === maxVal })
    if (maxAttrs.length > 1) {
      maxAttrs.sort(function() { return Math.random() - 0.5 })
    }
    var topAttr = maxAttrs[0]
    var pool = pools[topAttr]

    // 最高属性 < 20 也回退到均衡池（低属性时倾向均衡）
    if (!pool || maxVal < 20) {
      return this._rollFromPool(pools.balanced)
    }

    return this._rollFromPool(pool)
  },

  /**
   * 从加权概率池中roll一个物种
   * @param {Array<{species:string, weight:number>}} pool
   * @returns {string} speciesId
   */
  _rollFromPool: function(pool) {
    if (!pool || !pool.length) return 'lynx' // 兜底
    var totalWeight = pool.reduce(function(sum, item) { return sum + item.weight }, 0)
    var roll = Math.random() * totalWeight
    var cumulative = 0
    for (var i = 0; i < pool.length; i++) {
      cumulative += pool[i].weight
      if (roll <= cumulative) return pool[i].species
    }
    return pool[pool.length - 1].species
  },

  /**
   * V7.1：三档颜色变体判定（普通92% / 稀有6% / 异色2%）
   * @returns {{key:string, label:string, suffix:string, effect:object|null}} 颜色档次信息
   */
  rollColorTier: function() {
    var roll = Math.random()
    var tiers = this.COLOR_TIERS
    if (roll < tiers.shiny.probability) return tiers.shiny
    if (roll < tiers.shiny.probability + tiers.rare.probability) return tiers.rare
    return tiers.normal
  },

  /** V7.1 兼容：是否异色（用于快速判断） */
  isShinyTier: function(colorKey) {
    return colorKey === 'shiny'
  },
  /** V7.1 兼容：是否稀有或异色 */
  isSpecialColor: function(colorKey) {
    return colorKey === 'rare' || colorKey === 'shiny'
  },

  // ================================================
  //  V8.0 天赋系统方法
  // ================================================

  /**
   * V8.0：roll天赋值（1~100，孵化时调用一次，永久不变）
   * @returns {number} 天赋值 1~100
   */
  rollTalent: function() {
    // 基础随机1~100
    var base = Math.floor(Math.random() * 100) + 1
    // S级(96~100)额外稀有化：只有5%概率进入96+
    // 大部分宠物集中在F~B级（80%），A/S级仅20%
    return base
  },

  /**
   * V8.0：根据天赋值获取天赋等级信息
   * @param {number} talentValue - 天赋值 (1~100)
   * @returns {{key:string, name:string, icon:string, color:string, growthBonus:object, desc:string}}
   */
  getTalentGrade: function(talentValue) {
    var tv = Math.max(1, Math.min(100, talentValue || 1))
    var grades = this.TALENT.grades
    for (var i = 0; i < grades.length; i++) {
      if (tv >= grades[i].range[0] && tv <= grades[i].range[1]) {
        return grades[i]
      }
    }
    return grades[0] // F级兜底
  },

  /**
   * V8.0：根据天赋计算成长加成（替代旧的固定+1~3）
   * @param {number} talentValue - 天赋值
   * @returns {number} 本次成长总加成点数
   */
  getTalentGrowthBonus: function(talentValue) {
    var grade = this.getTalentGrade(talentValue)
    var bonus = grade.growthBonus
    var min = bonus.min || 1
    var max = bonus.max || 3
    if (min === max) return min // 固定值不随机
    return min + Math.floor(Math.random() * (max - min + 1))
  },

  /**
   * V8.0：获取天赋潜力星级（1~5星）
   * @param {number} talentValue - 天赋值
   * @returns {number} 星级 1~5
   */
  getTalentStars: function(talentValue) {
    var grade = this.getTalentGrade(talentValue)
    return this.TALENT.starMap[grade.key] || 1
  },

  /**
   * V8.0：获取天赋显示文本（用于档案页）
   * @param {number} talentValue - 天赋值
   * @returns {string} 如 "传奇（98）"
   */
  getTalentDisplayText: function(talentValue) {
    var grade = this.getTalentGrade(talentValue)
    return grade.name + '（' + (talentValue || 1) + '）'
  },

  /**
 * V7.1：生成宠物图片路径（代理到 PetAssetService 映射层）
 * @param {string} speciesId - 物种ID
 * @param {string} stageKey - 阶段key (BABY/YOUTH/ADULT/PERFECT)
 * @param {string} colorKey - 颜色档次 (normal/rare/shiny)
 * @returns {string} 完整图片路径（Pipeline格式）
 */
getSpeciesImagePath: function(speciesId, stageKey, colorKey) {
  var PetAssetService = require('./pet_assets_config')
  return PetAssetService.getPetImage(speciesId, stageKey, colorKey || 'normal')
},

  /**
   * V7.1：获取某个物种的全部图片路径列表（4阶段 x 3色 = 12张）
   * @param {string} speciesId - 物种ID
   * @returns {Array<{stage:string, color:string, path:string}>}
   */
  getAllImagePathsForSpecies: function(speciesId) {
    var self = this
    var paths = []
    this.STAGE_IMAGE_KEYS.forEach(function(stage) {
      self.COLOR_VARIANTS.forEach(function(color) {
        paths.push({
          stage: stage,
          color: color,
          isShiny: color === 'shiny',       // 兼容旧字段
          isSpecial: color !== 'normal',     // V7.1 新增
          path: self.getSpeciesImagePath(speciesId, stage.toUpperCase(), color),
        })
      })
    })
    return paths
  },

  // ================================================
  //  兼容方法（保留原有接口）
  // ================================================

  /** 根据蛋类型获取可孵出的物种列表 */
  getSpeciesByEggType: function(eggType) {
    var et = this.EGG_TYPES[eggType]
    if (!et || !et.hintCategory) return this.list
    return this.getSpeciesByCategory(et.hintCategory)
  },

  /** 从蛋类型的候选列表中随机选一个物种（兼容旧逻辑兜底）*/
  rollSpeciesFromEgg: function(eggType) {
    var candidates = this.getSpeciesByEggType(eggType)
    return candidates[Math.floor(Math.random() * candidates.length)]
  },

  /** 获取物种信息 */
  getSpecies: function(id) {
    return this.list.find(function(s) { return s.id === id }) || null
  },

  /** 获取某分类下所有物种 */
  getSpeciesByCategory: function(category) {
    return this.list.filter(function(s) { return s.category === category })
  },

  /** 获取所有物种id */
  getAllIds: function() {
    return this.list.map(function(s) { return s.id })
  },

  /** 获取所有分类key */
  getCategoryKeys: function() {
    return Object.keys(this.categories)
  },

  /** 获取物种的BUFF信息 */
  getBuff: function(speciesId) {
    return this.BUFFS[speciesId] || null
  },

  /** 获取蛋类型信息 */
  getEggType: function(eggTypeKey) {
    return this.EGG_TYPES[eggTypeKey] || null
  },

  /** 获取所有蛋类型key */
  getEggTypeKeys: function() {
    return Object.keys(this.EGG_TYPES)
  },

  // ===== 阶段相关方法（代理到GROWTH_STAGES）=====

  /** V8.2：根据growth_value获取当前阶段（代理到统一配置源）*/
  getStageByGrowth: function(growthValue) {
    var PetStageConfig = require('./shared/petStageConfig')
    return PetStageConfig.getStageByGrowth(growthValue)
  },

  /** 获取下一阶段 */
  getNextStage: function(growthValue) {
    var current = this.getStageByGrowth(growthValue)
    var stages = this.GROWTH_STAGES
    var idx = stages.findIndex(function(s) { return s.key === current.key })
    if (idx < 0 || idx >= stages.length - 1) return null
    return stages[idx + 1]
  },

  /** 获取当前阶段进度百分比 */
  getStageProgress: function(growthValue) {
    var current = this.getStageByGrowth(growthValue)
    if (current.key === 'PERFECT') return 100
    var range = current.maxGrowth - current.minGrowth
    if (range <= 0) return 100
    var progress = ((growthValue || 0) - current.minGrowth) / range * 100
    return Math.min(100, Math.max(0, Math.round(progress)))
  },

  /** 检查是否跨阶段 */
  checkStageUp: function(oldGrowth, newGrowth) {
    var oldStage = this.getStageByGrowth(oldGrowth)
    var newStage = this.getStageByGrowth(newGrowth)
    if (oldStage.key !== newStage.key) return newStage
    return null
  },

  /** 生成阶段升级属性奖励 */
  rollStageUpBonus: function() {
    var attrs = Object.keys(this.ATTRIBUTES)
    var config = this.STAGE_UP_BONUS
    var totalMin = config.totalBonus[0]
    var totalMax = config.totalBonus[1]
    var totalBonus = totalMin + Math.floor(Math.random() * (totalMax - totalMin + 1))

    var result = {}
    var remaining = totalBonus
    for (var i = 0; i < attrs.length; i++) {
      var isLast = (i === attrs.length - 1)
      var maxHere = isLast ? remaining : Math.min(config.maxPerAttr, remaining - (attrs.length - 1 - i) * config.minPerAttr)
      var minHere = isLast ? remaining : config.minPerAttr
      if (maxHere < minHere) { minHere = config.minPerAttr; maxHere = config.maxPerAttr }
      var val = minHere + Math.floor(Math.random() * (Math.max(1, maxHere - minHere + 1)))
      result[attrs[i]] = val
      remaining -= val
    }
    if (remaining !== 0) {
      var fixKey = attrs[Math.floor(Math.random() * attrs.length)]
      result[fixKey] += remaining
    }
    return result
  },

  /** 获取所有成长阶段列表 */
  getAllStages: function() {
    return this.GROWTH_STAGES
  },

  /** 获取蛋的花纹信息 */
  getEggPattern: function(eggType) {
    var egg = this.EGG_TYPES[eggType]
    if (egg && egg.pattern) return egg.pattern
    return {
      type: 'default',
      bgGradient: 'linear-gradient(145deg, #666 0%, #999 100%)',
      patternColor: 'rgba(255,255,255,0.08)',
      accentColor: '#CCC',
      patternChars: ['✦', '◇', '○', '△', '□'],
      patternDesc: '神秘纹理',
    }
  },

  /** 获取所有可用的蛋类型（用于刷新切换） */
  getEggTypeOptions: function() {
    var self = this
    var keys = Object.keys(this.EGG_TYPES)
    return keys.map(function(k) {
      var e = self.EGG_TYPES[k]
      return { key: k, name: e.name, emoji: e.emoji, color: e.color, desc: e.desc }
    })
  },
}
