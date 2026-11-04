﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * Pet V7 — 宠物全局常量与统一展示引擎
 *
 * 核心规则：
 *   1. getPetAppearance(pet) 是唯一输出接口，模板不写 if/else
 *   2. 所有视觉差异化通过 rarityConfig / personalityConfig 配置驱动
 *   3. 物种定义从 speciesConfig.js 统一读取（15种）
 *   4. V7：成长阶段由 growth_value 决定（5阶段：EGG/BABY/YOUTH/ADULT/PERFECT）
 *   5. V7：四维属性为 活力/智慧/幸运/共鸣（范围0~50）
 *   6. V7：图片路径由 SpeciesConfig.getSpeciesImagePath() 统一生成
 *   7. V7：异色系统（shiny，5%概率孵化时判定）
 */

var SpeciesConfig = require('./speciesConfig')
var RarityConfig = require('./rarityConfig')
var PersonalityConfig = require('./personalityConfig')
var TitleConfig = require('./titleConfig')
var PetRarity = require('./petRarity')

// ===== 物种定义（代理到speciesConfig）=====
module.exports.SPECIES = _buildSpeciesMap()
function _buildSpeciesMap() {
  var map = {}
  SpeciesConfig.list.forEach(function(s) { map[s.id] = { name: s.name, category: s.category, icon: s.icon || '', asset: s.asset || '' } })
  return map
}

/** 全部物种key（用于图鉴收集判断） */
module.exports.SPECIES_KEYS = SpeciesConfig.getAllIds()

/** 稀有度定义（代理到petRarity.js，用于图鉴等页面） */
module.exports.RARITY = PetRarity.PET_RARITY

// ===== 属性类型（保留兼容）=====
module.exports.ATTRIBUTE = {
  study:    { name: '学习型', color: '#7CB342', desc: '擅长学习成长' },
  creative: { name: '创造型', color: '#AB47BC', desc: '擅长创意发挥' },
  action:   { name: '行动型', color: '#FF7043', desc: '擅长行动执行' },
  social:   { name: '社交型', color: '#42A5F5', desc: '擅长沟通交流' },
  lucky:    { name: '幸运型', color: '#FFD54F', desc: '运气加成' },
}

// ===== 成长阶段（V6.1：5阶段，由 growth_value 决定）=====
// 代理到 SpeciesConfig.GROWTH_STAGES，保持向下兼容
module.exports.STAGES = (function() {
  var map = {}
  SpeciesConfig.GROWTH_STAGES.forEach(function(s) {
    map[s.key] = { name: s.name, nextXp: s.maxGrowth, icon: s.icon, asset: '', desc: s.desc }
  })
  return map
})()

// ===== 蛋孵化子阶段（V6.1：花纹蛋→发光→破壳→已孵化）=====
module.exports.EGG_STAGES = {
  pattern_egg:  { name: '花纹蛋',   hint: '一颗神秘的蛋，表面隐约可见花纹...', progress: 0,   showAttr: false },
  glowing_egg:  { name: '发光蛋',   hint: '蛋开始散发出柔和的光芒',            progress: 25,  showAttr: false },
  cracking_egg: { name: '即将破壳', hint: '蛋壳晃动，里面的小家伙要出来了！',    progress: 50, showAttr: false },
  hatched:      { name: '已孵化',   hint: '',                                  progress: 100, showAttr: true },
}

// ===== 心情系统 =====
module.exports.MOOD = {
  excited: { name: '兴奋', emoji: '🤩', color: '#FFD700' },
  happy:   { name: '开心', emoji: '😊', color: '#7CB342' },
  normal:  { name: '平静', emoji: '😐', color: '#90A4AE' },
  sleepy:  { name: '困倦', emoji: '😴', color: '#9C27B0' },
  bored:   { name: '无聊', emoji: '😕', color: '#78909C' },
  sad:     { name: '难过', emoji: '😢', color: '#FF7043' },
}

// ===== 亲密度等级 =====
module.exports.BOND_LEVELS = [
  { name: '陌生', min: 0, max: 199,   icon: '♡', color: '#95A5A6' },
  { name: '熟悉', min: 200, max: 399, icon: '🌲', color: '#BDC3C7' },
  { name: '伙伴', min: 400, max: 699, icon: '💌', color: '#7CB342' },
  { name: '好友', min: 700, max: 899, icon: '💋', color: '#42A5F5' },
  { name: '挚友', min: 900, max: 1000, icon: '❤️', color: '#EF5350' },
]

// ===== 四维属性标签（V6.1：活力/智慧/幸运/共鸣）=====
module.exports.ATTR_LABELS = SpeciesConfig.ATTRIBUTES


/**
 * ============================================
 *  核心：统一宠物展示引擎
 * ============================================
 *
 * 输入：pet 对象（来自云函数）
 * 输出：appearance 完整视觉配置对象
 *
 * 模板中直接判 rarity/mood/stage，
 * 全部读取 appearance.xxx 属性
 */
function getPetAppearance(pet) {
  if (!pet) return _emptyAppearance()

  var isEgg = !(pet.is_hatched === true)

  if (isEgg) {
    return _buildEggAppearance(pet)
  }

  return _buildHatchedAppearance(pet)
}

/** 构建蛋的外观 */
function _buildEggAppearance(pet) {
  var eggStageInfo = getEggStageByProgress(pet.growth_value || 0)
  var eggStage = module.exports.EGG_STAGES[eggStageInfo.key] || module.exports.EGG_STAGES.pattern_egg
  var eggType = SpeciesConfig.getEggType(pet.egg_type) || SpeciesConfig.EGG_TYPES.forest_egg
  var rc = RarityConfig.getRarityConfig('common')

  // 蛋的颜色根据蛋类型决定
  var eggColor = eggType.color || '#7CB342'
  var eggEmoji = eggType.emoji || '🥚'
  var eggName = eggType.name || '神秘成长蛋'

  // 获取花纹信息
  var eggPattern = SpeciesConfig.getEggPattern(pet.egg_type)

  // V6.1：使用 growth_value 决定蛋子阶段动画
  var gv = pet.growth_value || 0
  var animClass = ''
  if (gv >= 50) animClass = 'egg-shake-intense'
  else if (gv >= 25) animClass = 'egg-glow-float'

  return {
    isEgg: true,
    species: '',
    rarity: 'unknown',
    stage: 'egg',
    mood: 'sleepy',

    baseSprite: '',
    fallbackEmoji: eggEmoji,

    rarityEffect: {
      cssClass: rc.cssClass,
      badgeClass: rc.badgeClass,
      color: eggColor,
      glow: {
        enabled: gv >= 25,
        color: eggColor.replace(')', ', 0.15)').replace('rgb', 'rgba').replace('#', 'rgba(').replace(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i, function(m,r,g,b){return parseInt(r,16)+','+parseInt(g,16)+','+parseInt(b,16)}),
        radius: 50,
        intensity: 0.15 + (gv / 600),
        animation: gv >= 50 ? 'eggShakeGlow' : '',
      },
      border: {
        enabled: true,
        width: 1,
        style: 'dashed',
        color: eggColor + '40',
      },
      particle: {
        enabled: gv >= 50,
        type: 'sparkle-dust',
        density: gv >= 50 ? 0.2 : 0,
        color: eggColor + '60',
      },
      colorLayer: { enabled: false },
    },

    moodEffect: {
      cssClass: 'mood-sleepy',
      animClass: animClass,
    },

    displayName: eggName,
    displaySubtitle: eggStageInfo.desc,
    displayBadge: eggName,
    hideAttributes: !eggStage.showAttr,

    // 蛋类型信息
    eggTypeInfo: {
      type: pet.egg_type || 'forest_egg',
      name: eggName,
      color: eggColor,
      emoji: eggEmoji,
      desc: eggType.desc || '',
    },

    // 花纹信息（供模板渲染不同外观）
    eggPattern: {
      type: eggPattern.type || 'default',
      bgGradient: eggPattern.bgGradient || '',
      accentColor: eggPattern.accentColor || '#CCC',
      patternDesc: eggPattern.patternDesc || '',
      patternChars: eggPattern.patternChars || [],
    },

    // V6.1 成长值（支持超过100的值显示）
    growthValue: gv,
    growthPercent: Math.min(100, gv),
    // 当前阶段信息（V6.1）
    currentStage: SpeciesConfig.getStageByGrowth(gv),

    containerClass: 'pet-display-egg egg-stage-' + (eggStageInfo.key || 'pattern_egg'),
    spriteAnimClass: animClass,
  }
}

/** 构建已孵化宠物的完整外观（V7：图片贴图体系）*/
function _buildHatchedAppearance(pet) {
  var speciesInfo = _getSpeciesInfo(pet.species)
  var rc = RarityConfig.getRarityConfig(pet.rarity)
  var pc = PersonalityConfig.getPersonalityConfig(pet.personality)
  var moodInfo = module.exports.MOOD[pet.mood] || module.exports.MOOD.normal

  // V7：阶段由 growth_value 决定（实时计算，不依赖可能过期的 DB stage 字段）
  var gv = pet.growth_value || 0
  var growthStage = SpeciesConfig.getStageByGrowth(gv)

  // 【V8.5修复】始终以 growth_value 实时计算的阶段为准，不再依赖 DB 中可能过期的 stage 字段
  var stageKey = growthStage.key
  var stageInfo = module.exports.STAGES[stageKey] || module.exports.STAGES.BABY

  // V7.1：异色/稀有判定（三档颜色）
  var isShiny = pet.is_shiny === true
  var colorTier = pet.color_tier || 'normal'
  var isRare = colorTier === 'rare'

  // V8.0：天赋信息
  var talentValue = pet.talent || 1
  var talentGradeInfo = SpeciesConfig.getTalentGrade(talentValue)
  var talentStars = SpeciesConfig.getTalentStars(talentValue)
  var isLegendaryTalent = talentGradeInfo.key === 'S'
  var isGeniusTalent = talentGradeInfo.key === 'A' || talentGradeInfo.key === 'S'

  // V7 核心：根据 species + stage + color tier 生成图片路径
  var spritePath = SpeciesConfig.getSpeciesImagePath(pet.species, stageKey, colorTier)

  // 【V8.5诊断】确认图片路径生成是否正确
  console.log('[SpritePath] species=' + (pet.species || 'NULL') +
    ' stageKey=' + stageKey + ' (from DB=' + (pet.stage || '-') +
    ' growthStage=' + (growthStage.key || '-') + ' gv=' + gv + ')' +
    ' path=' + (spritePath || 'EMPTY'))

  var displayName = (pet.name || speciesInfo.name)
  var buffInfo = SpeciesConfig.getBuff(pet.species)

  // V7 异色/稀有视觉增强
  var shinyEffect = isShiny ? {
    extraGlow: true,
    glowColor: '#FFD700',
    shimmerClass: 'shiny-shimmer',
    shinyBadge: '✨异色',
  } : isRare ? {
    extraGlow: true,
    glowColor: '#448AFF',
    shimmerClass: 'rare-glow',
    shinyBadge: '💎稀有',
  } : null

  return {
    isEgg: false,
    species: pet.species || '',
    rarity: pet.rarity || 'common',
    stage: stageKey,
    mood: pet.mood || 'normal',

    // V7 图片路径（替代旧的 baseSprite）
    baseSprite: spritePath,
    fallbackEmoji: speciesInfo.icon || '🐾',

    // V7 异色信息
    isShiny: isShiny,
    colorTier: colorTier,           // V7.1: normal/rare/shiny
    isRare: isRare,                 // V7.1: 是否稀有档
    shinyEffect: shinyEffect,

    // V8.0 天赋信息
    talent: talentValue,
    talentGrade: talentGradeInfo.key,           // F/D/C/B/A/S
    talentName: talentGradeInfo.name,            // 普通/良好/优秀/卓越/天才/传奇
    talentIcon: talentGradeInfo.icon,             // ⚪/🔵/🟢/🟡/🟠/👑
    talentColor: talentGradeInfo.color,
    talentStars: talentStars,                     // 1~5星
    isLegendaryTalent: isLegendaryTalent,          // 是否S级
    isGeniusTalent: isGeniusTalent,                // 是否A或S级

    rarityEffect: {
      cssClass: rc.cssClass,
      badgeClass: rc.badgeClass,
      color: rc.color,
      name: rc.name,
      tier: rc.tier,
      glow: rc.glow,
      border: rc.border,
      particle: rc.particle,
      colorLayer: rc.colorLayer,
    },

    moodEffect: {
      cssClass: moodInfo.class || ('mood-' + (pet.mood || 'normal')),
      animClass: pc ? ('personality-anim-' + pc.animStyle) : '',
      emoji: moodInfo.emoji,
      moodName: moodInfo.name,
      moodColor: moodInfo.color,
    },

    titleEffect: {
      levelTitle: TitleConfig.getLevelTitle(pet.level || 1),
    },

    // BUFF信息
    buffEffect: buffInfo ? {
      type: buffInfo.type,
      label: buffInfo.label,
      value: buffInfo.value,
      desc: buffInfo.desc,
      isActive: true,
    } : null,

    displayName: displayName,
    displaySubtitle: speciesInfo.name + (isShiny ? ' ✨' : isRare ? ' 💎' : '') + ' · ' + growthStage.name,
    displayBadge: rc.name + (isShiny ? ' ✨' : isRare ? ' 💎' : ''),
    hideAttributes: false,

    // V7 成长值与阶段信息
    growthValue: gv,
    currentStage: growthStage,
    nextStage: SpeciesConfig.getNextStage(gv),
    stageProgress: SpeciesConfig.getStageProgress(gv),

    containerClass: 'pet-display-hatched rarity-' + (pet.rarity || 'common') +
      ' stage-' + stageKey + ' mood-' + (pet.mood || 'normal') +
      (isShiny ? ' shiny-pet' : '') + (isRare ? ' rare-pet' : ''),
    spriteAnimClass: pc ? ('perso-' + pc.animStyle) : 'mood-normal',
  }
}

function _emptyAppearance() {
  return {
    isEgg: true, baseSprite: '', fallbackEmoji: '🥚',
    rarityEffect: {}, moodEffect: {},
    personalityEffect: null, titleEffect: {},
    buffEffect: null,
    displayName: '', displaySubtitle: '', hideAttributes: true,
    containerClass: '', spriteAnimClass: '',
  }
}

/** 蛋动画映射 */
function _getEggAnimClass(eggStage) {
  var map = {
    crack: 'egg-crack-anim',
    glow:  'egg-glow-anim',
    shake: 'egg-shake-anim',
    ready: 'egg-shake-anim',
  }
  return map[eggStage] || ''
}


// ===== 物种查询 =====

function _getSpeciesInfo(species) {
  var s = SpeciesConfig.getSpecies(species)
  if (s) return { name: s.name, icon: s.icon || '', category: s.category, asset: s.asset || '' }
  return { name: '未知', icon: '❓', category: 'unknown', asset: '' }
}

function getSpeciesInfo(species) {
  return module.exports.SPECIES[species] || { name: '未知', icon: '❓', asset: '' }
}

function getPetDisplay(pet) {
  if (!pet) return { icon: '🥚', asset: '', label: '神秘成长蛋' }
  if (!(pet.is_hatched === true)) {
    var et = SpeciesConfig.getEggType(pet.egg_type)
    return { icon: (et && et.emoji) || '🥚', asset: '', label: (et && et.name) || '神秘成长蛋' }
  }
  var sp = _getSpeciesInfo(pet.species)
  return { icon: sp.icon, asset: sp.asset, label: pet.name || sp.name }
}

function getPetSprite(pet) {
  if (!pet) return { sprite: '', fallbackEmoji: '🥚', rarityColor: '#95A5A6', rarityName: '普通' }
  var speciesInfo = _getSpeciesInfo(pet.species)
  var rc = require('./rarityConfig').getRarityConfig(pet.rarity || 'common')
  return {
    sprite: speciesInfo.asset || '',
    fallbackEmoji: speciesInfo.icon || '🐾',
    rarityColor: rc.color || '#95A5A6',
    glowClass: rc.cssClass || '',
    particleClass: 'particle-' + (rc.particle.type || ''),
    borderClass: rc.cssClass || '',
    displayName: pet.name || speciesInfo.name || '未知',
  }
}


// ===== 计算函数 =====

function calcXpPercent(xp, stage) {
  var si = module.exports.getStageInfo(stage)
  var max = si.nextXp
  if (max >= 9999) return 100
  return Math.min(100, Math.round((xp % max) / max * 100))
}

function getAttrPercent(val) {
  return Math.min(100, Math.max(0, val || 0))
}

function calcBondProgress(bond) {
  var val = bond || 0
  var levels = module.exports.BOND_LEVELS
  var current = levels[0]
  for (var i = levels.length - 1; i >= 0; i--) {
    if (val >= levels[i].min) { current = levels[i]; break }
  }
  var range = current.max - current.min
  var progress = range > 0 ? Math.min(100, Math.max(0, ((val - current.min) / range) * 100)) : 100
  var remaining = Math.max(0, current.max - val)
  return {
    current: val,   // 【V8.5修复】原始亲密度值，供 WXML 显示 "X / 1000"
    name: current.name, icon: current.icon, color: current.color,
    min: current.min, max: current.max, percent: Math.round(progress),
    remaining: remaining, isMax: val >= current.max, isHighest: current === levels[levels.length - 1],
    nextName: current === levels[levels.length - 1] ? null : (levels[levels.indexOf(current) + 1] || {}).name || ''
  }
}

function buildAttrList(attrs) {
  var labels = module.exports.ATTR_LABELS
  var list = Object.keys(labels).map(function(key) {
    var attrConfig = labels[key] || {}
    var maxVal = attrConfig.maxVal || 10
    var rawVal = Math.max(0, (attrs || {})[key] || 0)
    var capped = Math.min(maxVal, rawVal)
    return {
      key: key, label: attrConfig.name, icon: attrConfig.icon,
      color: attrConfig.color, val: capped,
      percent: Math.round((capped / maxVal) * 100)
    }
  })
  list.sort(function(a, b) { return b.val - a.val })
  if (list.length > 0) { list[0].isTop = true; list[0].itemClass = 'attr-top' }
  for (var i = 1; i < list.length; i++) { list[i].itemClass = '' }
  return list
}

function getMoodDisplay(moodKey) {
  var m = module.exports.MOOD[moodKey] || module.exports.MOOD.normal
  var bubbleMap = {
    excited: '今天状态超棒！一起冲鸭！',
    happy: '今天也一起努力吧！',
    normal: '嗯…平平淡淡的一天~',
    sleepy: '好困…zzz…让我再睡一会…',
    bored: '好无聊啊…有没有好玩的事？',
    sad: '心情有点低落…需要安慰…'
  }
  return { emoji: m.emoji, name: m.name, color: m.color, bubble: bubbleMap[moodKey] || bubbleMap.normal }
}

function calcDexProgress(ownedSpeciesList) {
  var allSpecies = module.exports.SPECIES_KEYS
  var owned = new Set((ownedSpeciesList || []).filter(Boolean))
  var collected = allSpecies.filter(function(s) { return owned.has(s) })
  var uncollected = allSpecies.filter(function(s) { return !owned.has(s) })
  return {
    total: allSpecies.length, collected: collected.length, uncollected: uncollected.length,
    percent: allSpecies.length > 0 ? Math.round((collected.length / allSpecies.length) * 100) : 0,
    collectedSpecies: collected.map(function(k) {
      return { key: k, name: (module.exports.SPECIES[k] || {}).name || k, icon: (module.exports.SPECIES[k] || {}).icon || '', owned: true }
    }),
    uncollectedSpecies: uncollected.map(function(k) {
      return { key: k, name: (module.exports.SPECIES[k] || {}).name || '???', icon: (module.exports.SPECIES[k] || {}).icon || '?', owned: false }
    }),
    isComplete: collected.length >= allSpecies.length
  }
}

function getEggStageByProgress(growthValue) {
  var p = growthValue || 0
  // V6.1：基于新蛋子阶段（花纹蛋→发光→破壳→已孵化），阈值不变
  if (p >= 100) return { key: 'hatched',      name: '已孵化',   emoji: '🎉', desc: '孵化成功！' }
  if (p >= 50)  return { key: 'cracking_egg', name: '即将破壳', emoji: '🫣', desc: '蛋壳晃动，快要出来了！' }
  if (p >= 25)  return { key: 'glowing_egg',  name: '发光蛋',   emoji: '✨', desc: '蛋散发出柔和的光芒' }
  return { key: 'pattern_egg', name: '花纹蛋',     emoji: '🥚', desc: '一颗神秘的蛋，表面隐约可见花纹' }
}

function calcDexByCategory(ownedSpeciesList) {
  var owned = {}
  ;(ownedSpeciesList || []).forEach(function(k) { if (k) owned[k] = true })
  var categories = SpeciesConfig.categories
  return Object.keys(categories).map(function(catKey) {
    var members = SpeciesConfig.getSpeciesByCategory(catKey)
    return {
      key: catKey, name: categories[catKey].name, icon: categories[catKey].icon,
      total: members.length,
      collected: members.filter(function(m) { return owned[m.id] }).length,
      percent: members.length > 0 ? Math.round(members.filter(function(m) { return owned[m.id] }).length / members.length * 100) : 0
    }
  })
}

function checkBondMilestone(oldBond, newBond) {
  var milestones = module.exports.BOND_MILESTONES
  for (var i = 0; i < milestones.length; i++) {
    if ((oldBond || 0) < milestones[i].threshold && (newBond || 0) >= milestones[i].threshold) {
      return milestones[i]
    }
  }
  return null
}

function getDailyGreeting(species, personality, petName) {
  var name = petName || '小伙伴'
  var greetings = {
    // === 保留现有物种问候语 ===
    hamster:       '今天也要一起学习成长哦！',
    chinchilla:    '新的一天，新的美食～',
    shiba:         '主人早安！今天也充满干劲！',
    corgi:         '小短腿也有大能量！冲鸭！',
    husky:         '二哈模式启动！今天要拆家吗？开玩笑的～',
    wolf:          '…保持专注。',
    orange_cat:    '(看了你一眼）…早安。',
    black_cat:     '…别想多了，我只是路过。',

    // === 新增物种问候语 ===
    calico_cat:         '今天也要像老虎一样威风！',
    snow_leopard:       '雪山上的王者向你问好～',
    lynx:               '耳朵竖起来，认真听主人说话哦！',
    golden_retriever:   '主人主人！今天也超级爱你！',
    capybara:           '……（淡定地看着你）',
    fox:                '嘿嘿，今天有什么好玩的？',
    raccoon:            '（眼罩一闪）发现了什么宝藏吗？',
  }
  var greeting = greetings[species] || '今天也一起加油吧！'
  return name + '：' + greeting
}

/** 根据物种获取BUFF信息（供模板使用） */
function getBuffDisplay(speciesId) {
  return SpeciesConfig.getBuff(speciesId) || null
}

/** 获取蛋类型显示信息 */
function getEggTypeDisplay(eggTypeKey) {
  return SpeciesConfig.getEggType(eggTypeKey) || SpeciesConfig.EGG_TYPES.forest_egg
}

/** 获取成长值来源配置 */
function getGrowthSourceConfig(sourceKey) {
  return SpeciesConfig.GROWTH_SOURCES[sourceKey] || null
}


// ===== Helper exports =====
module.exports.getSpeciesInfo = getSpeciesInfo
module.exports.getAttributeInfo = function(attrType) { return module.exports.ATTRIBUTE[attrType] || { name: '未知', color: '#999', desc: '' } }
module.exports.getStageInfo = function(stage) { return module.exports.STAGES[stage] || module.exports.STAGES.BABY }
module.exports.getEggStageInfo = function(eggStage) { return module.exports.EGG_STAGES[eggStage] || module.exports.EGG_STAGES.pattern_egg }
module.exports.getRarityInfo = function(rarityKey) { return require('./rarityConfig').getRarityConfig(rarityKey) }
module.exports.getMoodInfo = function(moodKey) { return module.exports.MOOD[moodKey] || module.exports.MOOD.normal }
module.exports.getBondLevelInfo = function(bond) {
  var levels = module.exports.BOND_LEVELS
  for (var i = levels.length - 1; i >= 0; i--) { if (bond >= levels[i].min) return levels[i]; }
  return levels[0]
}
module.exports.getPetDisplay = getPetDisplay
module.exports.calcXpPercent = calcXpPercent
module.exports.getAttrPercent = getAttrPercent
module.exports.getPetAppearance = getPetAppearance
module.exports.calcDexProgress = calcDexProgress
module.exports.calcBondProgress = calcBondProgress
module.exports.buildAttrList = buildAttrList
module.exports.getMoodDisplay = getMoodDisplay
module.exports.getEggStageByProgress = getEggStageByProgress
module.exports.calcDexByCategory = calcDexByCategory
module.exports.checkBondMilestone = checkBondMilestone
module.exports.getDailyGreeting = getDailyGreeting
module.exports.getPetSprite = getPetSprite
module.exports.getBuffDisplay = getBuffDisplay
module.exports.getEggTypeDisplay = getEggTypeDisplay
module.exports.getGrowthSourceConfig = getGrowthSourceConfig

// ===== V6.1 新增导出 =====

/** 根据成长值获取当前阶段（代理到 SpeciesConfig） */
module.exports.getStageByGrowth = function(growthValue) {
  return SpeciesConfig.getStageByGrowth(growthValue)
}

/** 获取下一阶段 */
module.exports.getNextStage = function(growthValue) {
  return SpeciesConfig.getNextStage(growthValue)
}

/** 获取当前阶段内进度百分比（0~100） */
module.exports.getStageProgressPercent = function(growthValue) {
  return SpeciesConfig.getStageProgress(growthValue)
}

/** 检查是否跨阶段，返回新阶段或null */
module.exports.checkStageUp = function(oldGrowth, newGrowth) {
  return SpeciesConfig.checkStageUp(oldGrowth, newGrowth)
}

/** 获取所有成长阶段列表 */
module.exports.getAllGrowthStages = function() {
  return SpeciesConfig.GROWTH_STAGES
}

/** 获取四维属性定义 */
module.exports.getV6Attributes = function() {
  return SpeciesConfig.ATTRIBUTES
}

// 暴露SpeciesConfig快捷访问
module.exports.SpeciesConfig = SpeciesConfig

module.exports.BOND_MILESTONES = [
  { threshold: 100, name: '初识', icon: '🤝', desc: '宠物记住了你的名字', color: '#AED581' },
  { threshold: 300, name: '伙伴', icon: '📸', desc: '解锁合照纪念', color: '#81C784' },
  { threshold: 500, name: '信赖', icon: '🏅', desc: '解锁专属称号', color: '#4FC3F7' },
  { threshold: 800, name: '羁绊', icon: '💬', desc: '解锁秘密对话', color: '#CE93D8' },
  { threshold: 1000, name: '灵魂', icon: '❤️', desc: '灵魂伴侣，永不分离', color: '#EF5350' },
]
