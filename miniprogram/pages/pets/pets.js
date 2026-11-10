﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿const cloudApi = require('../../utils/cloudApi')
const PetConst = require('../../utils/petConstants')
const PersonalityConfig = require('../../utils/personalityConfig')
const TitleConfig = require('../../utils/titleConfig')
const { getPetPortrait } = require('../../utils/petPortrait')
const { createNavigation } = require('../../utils/aiNavigation')
const { accountScope } = require('../../utils/userSession')
const REWARD_PENDING_PREFIX = 'forest_reward_pending_v1:'

function getPetId(pet) {
  return pet && (pet._id || pet.id)
}

const DEFAULT_BACKPACK = [
  { name: '普通饲料', count: 3, icon: '🍍', desc: '+10EXP' },
  { name: '高级饲料', count: 1, icon: '🍠', desc: '+30EXP' },
  { name: '成长药水', count: 0, icon: '🍓', desc: '+30~50XP' },
  { name: '补签卡', count: 1, icon: '🎣', desc: '补签一次' },
]

function log(tag, msg, data) {
  var t = new Date().toISOString().slice(11, 23)
  if (data) console.log('[PetV6][' + t + '] ' + tag + ': ' + msg, JSON.stringify(data))
  else console.log('[PetV6][' + t + '] ' + tag + ': ' + msg)
}

Page({
  // ===== 缓存：避免重复调用 buildDisplayPet（修复轮播切换卡顿）=====
  _displayCache: {},
  _profileCache: {},

  data: {
    loading: true,
    activePet: null,
    // V6 多宠物卡片列表
    displayPets: [],
    currentSwiperIndex: 0,     // V6: 当前轮播索引
    campVisible: false,

    app: null,
    isEgg: false,
    xpPercent: 0,
    hatchPercent: 0,
    growthLogs: [],
    attributes: null,

    // 鎬ф牸绯荤粺
    personalityInfo: null,
    personalityDialogue: '',

    // 绉板彿绯荤粺
    levelTitle: null,
    streakTitle: null,
    specialTitles: [],

    // 铔嬫彮鏅撳姩鐢?
    showHatchReveal: false,
    hatchRevealData: null,

    // 浜掑姩鍙嶉
    interacting: false,
    interactionFeedback: '',
    showFeedbackToast: false,
    floatingFeedback: null,

    // UI 鐘舵€?
    showRenameModal: false,
    renameInput: '',
    activeSection: 'stats',
    backpack: [],
    backpackLoadError: false,

    // 鏂板寮哄寲鏁版嵁
    bondProgress: null,
    attrList: [],
    topAttrKey: '',
    moodDisplay: null,
    dexProgress: null,
    dexByCategory: [],
    eggStageInfo: null,
    dailyGreeting: '',
    showDailyGreeting: false,
    bondMilestone: null,
    showBondMilestone: false,
    awakenPreviewText: '',
    showDexModal: false,
    dexSpeciesList: [],

    // ===== 四维属性（V8.6：统一到活力/智慧/幸运/共鸣，上限10）=====
    BOND_ICON_MAP: {},
    BOND_NAME_MAP: {},
    BOND_COLOR_MAP: {},

    // 鎻檽寮圭獥棰勮绠楀瓧娈?
    _revealSpeciesText: '',
    _revealRarityColor: '#999',
    _revealRarityShadow: 'rgba(0,0,0,0)',
    _revealRarityName: '??',
    _revealAttrName: '',
    _revealAttrColor: '#999',
    _revealPersoName: '',
    _revealPersoIcon: '?',
    _revealPersoColor: '#999',
    _revealAttrs: null,      // 带val的ATTR_LIST副本

    // V5 蛋类型预计算字段（扁平简单值，供WXML直接使用）
    _eggTypeName: '',
    _eggTypeColor: '',
    _eggTypeEmoji: '',

    // V5 BUFF预计算字段（仅已孵化宠物）
    _buffLabel: '',
    _buffDesc: '',
    _hasBuff: false,

    // V5 成长值
    _growthValue: 0,
    _growthPercent: 0,

    // V6 成长池
    _poolValue: 0,
    _poolTotalEarned: 0,

    // ===== 蛋花纹系统 =====
    _eggPatternType: '',       // leaf / brick / cloud
    _eggPatternDesc: '',        // 叶脉纹理 / 砖瓦纹理 / 云纹流光
    _eggPatternChars: [],       // 花纹字符数组 ['🍃','🌿',...]
    _eggBgGradient: '',         // CSS渐变字符串

    // ===== 蛋刷新系统 =====
    showRefreshModal: false,
    refreshEggOptions: [],      // 可选的蛋类型列表
    refreshSelectedIndex: -1,

    // ===== 新手礼包 =====
    showStarterGift: false,     // 是否显示领取入口
    starterClaimed: false,      // 是否已领取
    showChildrenDayGift: false,  // V10.4：儿童节礼包入口

    // ===== 经验泉水系统 =====
    showFountain: true,           // 是否显示泉水组件
    fountainPoolValue: 0,         // 池中经验总量
    fountainTotalEarned: 0,       // 累计获得总量

    // 分配弹窗
    showAllocateModal: false,
    allocateTargetId: '',         // 选中的目标宠物ID
    allocateTargetName: '',       // 目标名称（显示用）
    allocateAmount: '',            // 用户输入的分配数量
    allocateMaxPool: 0,           // 最大可分配数量
    allocatePetList: [],          // 可分配的目标列表（所有蛋+已孵化宠物）
    allocateSelectedIndex: -1,    // 选中目标的索引

    // V6 多阶段显示
    _currentStageName: '',
    _currentStageIcon: '',
    _nextStageName: '',
    _stageProgressPercent: 0,
    _growthValueDisplay: '0',

    // V6 阶段升级弹窗
    showStageUpModal: false,
    _stageUpData: null,
    _attrBonusList: [],

    // V6 性格输入弹窗
    showPersonalityModal: false,
    personalityInput: '',

    // P4：性格期望弹窗（跨阶段升级时）
    showPersonalityPromptModal: false,
    promptPetId: '',
    promptTargetStage: '',
    personalityPromptText: '',
    // P3：成长记录
    growthRecords: [],
    showGrowthRecords: false,

    // ===== 宠物陪伴事件系统（V6 Phase 6）=====
    unreadEvents: [],
    showEventModal: false,
    currentEvent: null,
    eventContentLines: [],

    // P7：完整档案弹窗
    showProfileModal: false,
    profileData: null,

    // UI状态开关
    showEggState: false,
    showHatchedState: false,
    showRarityGlow: false,
    showParticle: false,
    showEmptyPetState: false,
    showFloatingFeedback: false,
    allocationPending: null,
    itemPending: null,
    rewardStorageError: '',
    rewardBusy: false,
    showStatsPanel: false,
    showGrowthPanel: false,
    showBackpackPanel: false,
    showBondRemaining: false,
    canAwaken: false,

    appRarityColor: "#95A5A6",
    appBorderWidth: 1,
    appBorderColor: "#8B6914",
    appRarityName: "普通",
    appParticleType: "sparkle",
    appGlowIntensity: 0.3,
    interactBounceClass: "",
    eggAnimClass: "",
    petLevel: 1,
    dexCollected: 0,
    dexTotal: 0,
    dexPercent: 0,
    bagEmpty: true,
    statsTabActive: "",
    growthTabActive: "",
    backpackTabActive: "",
    bondPercent: 0,
    bondRemainingText: "",
    moodBgColor: "transparent",
    moodBorderColor: "transparent",
    colorLayerStyle: "",     // 颜色滤镜CSS字符串
    fbX: 0,
    fbY: 0,
    fbText: "",
  },

  onShow: function() {
    this.setData({ campVisible: true })
    const session = this.syncRewardSession()
    if (session) this.refreshRewardPending()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    // 【安全修复】离线模式不加载云端数据，避免串号
    var app = getApp()
    var petIntent = createNavigation(wx, getApp).takePetIntent()
    if (app.isOfflineMode) {
      console.warn('[Pets] 离线模式，跳过云端数据加载')
      this.setData({ loading: false })
      return
    }
    this._petSelectionIntent = petIntent
    this._initBondMaps()
    var load = this.loadData()
    this.loadGrowthPool()
    return load
  },

  onHide: function() {
    this._rewardView = (this._rewardView || 0) + 1
    this._petSelectionIntent = null
    this.setData({ campVisible: false })
  },

  _initBondMaps: function() {
    var levels = PetConst.BOND_LEVELS
    var iconMap = {}, nameMap = {}, colorMap = {}
    levels.forEach(function(l) {
      for (var v = l.min; v <= l.max; v++) {
        iconMap[v] = l.icon; nameMap[v] = l.name; colorMap[v] = l.color
      }
    })
    this.setData({ BOND_ICON_MAP: iconMap, BOND_NAME_MAP: nameMap, BOND_COLOR_MAP: colorMap })
  },

  // 图片加载失败时清除当前宠物的baseSprite，回退到emoji显示
  onImageError: function(e) {
    var idx = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : undefined
    if (idx === undefined) {
      // 兜底：清除顶层app.baseSprite
      var app = this.data.app || {}
      if (app.baseSprite) {
        console.warn('[PetImageError] species=? stage=? baseSprite=' + app.baseSprite)
        this.setData({ 'app.baseSprite': '' })
      }
      return
    }

    var displayPets = this.data.displayPets || []
    var dp = displayPets[idx]
    if (!dp || !dp.app || !dp.app.baseSprite) return

    var errPath = dp.app.baseSprite
    var rawPath = dp.app.rawBaseSprite || ''
    var rawPet = dp._raw || {}
    console.warn('[PetImageError] species=' + (rawPet.species || '?') +
      ' stage=' + (rawPet.stage || dp.app.stage || '?') +
      ' rawBaseSprite=' + rawPath +
      ' baseSprite=' + errPath)

    // 清除displayPets中对应宠物的baseSprite
    var key = 'displayPets[' + idx + '].app.baseSprite'
    var updateData = {}
    updateData[key] = ''

    // 如果是当前活跃宠物，同步清除顶层app.baseSprite
    if (idx === this.data.currentSwiperIndex) {
      updateData['app.baseSprite'] = ''
    }

    this.setData(updateData)
  },

  // V6: 构建单只宠物的完整预计算显示对象
  buildDisplayPet: function(pet) {
    var self = this
    var isEgg = !(pet.is_hatched === true)

    // 构建外观引擎（V5：已包含 buffEffect / eggTypeInfo / growthValue）
    var app = PetConst.getPetAppearance(pet)

    // ===== V5 成长值系统 =====
    var growthValue = pet.growth_value || 0
    var growthPercent = Math.min(100, Math.max(0, growthValue))

    // 蛋孵化阶段
    var eggStage = PetConst.getEggStageByProgress(growthValue)

    // XP 进度
    var xpPct = PetConst.calcXpPercent(pet.experience || 0, pet.stage)

    // 原始属性
    var rawAttrs = pet.attributes || {}

    // 性格系统
    var persoInfo = PersonalityConfig.getPersonalityConfig(pet.personality)
    var persoDialogue = persoInfo ? PersonalityConfig.getPersonalityDialogue(pet.personality, pet.name || '小宝贝') : ''

    // 称号系统
    var lvTitle = TitleConfig.getLevelTitle(pet.level || 1)

    // 亲密度
    var bondP = PetConst.calcBondProgress(pet.bond || 0)

    // 属性列表
    var attrList = PetConst.buildAttrList(rawAttrs)
    var topAttrKey = attrList.length > 0 ? attrList[0].key : ''

    // 心情
    var moodDisp = PetConst.getMoodDisplay(pet.mood || 'normal')

    // 颜色滤镜层
    var colorLayerStyle = ''
    if (app.rarityEffect && app.rarityEffect.colorLayer && app.rarityEffect.colorLayer.enabled) {
      colorLayerStyle = 'filter: hue-rotate(' + app.rarityEffect.colorLayer.hueRotate + 'deg) saturate(' + (1 + app.rarityEffect.colorLayer.saturate / 100) + ')'
    }

    // 预计算扁平属性（V8.6：从四维属性中取最高项作为属性倾向）
    var topAttrConfig = PetConst.ATTR_LABELS[topAttrKey] || {}
    var _attrTypeName = !isEgg ? (topAttrConfig.name || '') : ''
    var sp = PetConst.getSpeciesInfo(pet.species)
    var _speciesName = !isEgg ? (sp.name || '') : ''
    var stageInfo = app.currentStage || {}
    var _stageName = !isEgg ? (stageInfo.name || '') : ''

    // ===== V5 蛋类型预计算 =====
    var _eggTypeName = ''
    var _eggTypeColor = ''
    var _eggTypeEmoji = ''
    if (isEgg) {
      var eggTypeInfo = PetConst.getEggTypeDisplay(pet.egg_type)
      _eggTypeName = eggTypeInfo ? eggTypeInfo.name : ''
      _eggTypeColor = eggTypeInfo ? eggTypeInfo.color : ''
      _eggTypeEmoji = eggTypeInfo ? eggTypeInfo.emoji : ''
    }

    // V6 花纹预计算
    var _eggPatternType = ''
    var _eggPatternDesc = ''
    var _eggPatternChars = []
    var _eggBgGradient = ''
    if (app.eggPattern) {
      _eggPatternType = app.eggPattern.type || ''
      _eggPatternDesc = app.eggPattern.patternDesc || ''
      _eggPatternChars = app.eggPattern.patternChars || []
      _eggBgGradient = app.eggPattern.bgGradient || ''
    }

    // ===== V5 BUFF预计算 =====
    var _buffLabel = ''
    var _buffDesc = ''
    var _hasBuff = false
    if (!isEgg && app.buffEffect && app.buffEffect.isActive) {
      _buffLabel = app.buffEffect.label || ''
      _buffDesc = app.buffEffect.desc || ''
      _hasBuff = true
    }

    // ===== V6 多阶段系统预计算 =====
    var _currentStageName = ''
    var _currentStageIcon = ''
    var _nextStageName = ''
    var _stageProgressPercent = 0
    var _growthValueDisplay = String(growthValue)

    if (!isEgg && app.currentStage) {
      _currentStageName = app.currentStage.name || ''
      _currentStageIcon = app.currentStage.icon || ''
      _stageProgressPercent = app.stageProgress || 0
      if (app.nextStage) {
        _nextStageName = app.nextStage.name || ''
      }
    }

    if (growthValue > 100) {
      _growthValueDisplay = String(growthValue)
    }

    // 觉醒判断
    var canAwaken = !isEgg && ['ADULT', 'PERFECT'].includes(app.currentStage?.key) && pet.awakened !== true

    // 粒子特效
    var showParticle = !!(app && app.rarityEffect && app.rarityEffect.particle && app.rarityEffect.particle.enabled)

    // 亲密度剩余提示
    var showBondRemaining = bondP && !bondP.isHighest ? true : false
    var bondRemainingText = bondP && !bondP.isHighest && bondP.nextName ? '距离' + bondP.nextName + '还差' + (bondP.remaining || 0) + '点' : ''
    var bondPercent = bondP && bondP.percent ? bondP.percent : 0

    // 稀有度视觉参数
    var showRarityGlow = !!(app && app.rarityEffect && app.rarityEffect.glow && app.rarityEffect.glow.enabled)
    var appRarityColor = app && app.rarityEffect && app.rarityEffect.color ? app.rarityEffect.color : "#95A5A6"
    var appBorderWidth = app && app.rarityEffect && app.rarityEffect.border && app.rarityEffect.border.width ? app.rarityEffect.border.width : 1
    var appBorderColor = app && app.rarityEffect && app.rarityEffect.border && app.rarityEffect.border.color ? app.rarityEffect.border.color : "#8B6914"
    var appRarityName = app && app.rarityEffect && app.rarityEffect.name ? app.rarityEffect.name : "普通"
    var appParticleType = app && app.rarityEffect && app.rarityEffect.particle && app.rarityEffect.particle.type ? app.rarityEffect.particle.type : "sparkle"
    var appGlowIntensity = app && app.rarityEffect && app.rarityEffect.glow && app.rarityEffect.glow.intensity ? app.rarityEffect.glow.intensity : 0.3

    // 动画类
    var eggAnimClass = app && app.spriteAnimClass ? app.spriteAnimClass : ""

    // 成长记录
    var growthRecords = (pet.growth_records || []).map(function(r) {
      return {
        time: r.time,
        stage: r.stage,
        message: r.message,
        timeStr: r.time ? new Date(r.time).toLocaleDateString() : '',
      }
    })

    // 未读事件
    var unreadEvents = (pet.pet_events || []).filter(function(e) { return e.read === false })

    return {
      _id: pet._id || pet.id,
      _raw: pet,
      isEgg: isEgg,
      isHatched: !isEgg,
      portrait: getPetPortrait(pet, app),

      // V7 异色
      isShiny: app.isShiny === true,
      isRare: app.isRare === true,
      // V7.1 颜色档次
      colorTier: app.colorTier || 'normal',
      colorLabel: pet.color_label || '普通',
      // V8.0 天赋
      talent: pet.talent || 1,
      talentGrade: app.talentGrade || 'F',
      talentName: app.talentName || '普通',
      // V8.0 天赋显示字段（扁平化供WXML直接使用）
      appTalentIcon: app.talentIcon || '⚪',
      appTalentName: app.talentName || '普通',
      appTalentColor: app.talentColor || '#9E9E9E',

      // 外观引擎
      app: app,

      // 蛋类型
      _eggTypeName: _eggTypeName,
      _eggTypeColor: _eggTypeColor,
      _eggTypeEmoji: _eggTypeEmoji,

      // 花纹
      _eggPatternType: _eggPatternType,
      _eggPatternDesc: _eggPatternDesc,
      _eggPatternChars: _eggPatternChars,
      _eggBgGradient: _eggBgGradient,

      // BUFF
      _buffLabel: _buffLabel,
      _buffDesc: _buffDesc,
      _hasBuff: _hasBuff,

      // 成长值
      _growthValue: growthValue,
      _growthPercent: growthPercent,

      // 多阶段
      _currentStageName: _currentStageName,
      _currentStageIcon: _currentStageIcon,
      _nextStageName: _nextStageName,
      _stageProgressPercent: _stageProgressPercent,
      _growthValueDisplay: _growthValueDisplay,

      // 其他
      hatchPercent: growthPercent,
      eggStageInfo: eggStage,
      xpPercent: xpPct,
      attributes: rawAttrs,
      personalityInfo: persoInfo,
      personalityDialogue: persoDialogue,
      levelTitle: lvTitle,
      bondProgress: bondP,
      attrList: attrList,
      topAttrKey: topAttrKey,
      moodDisplay: moodDisp,
      colorLayerStyle: colorLayerStyle,
      canAwaken: canAwaken,
      _attrTypeName: _attrTypeName,
      _speciesName: _speciesName,
      _stageName: _stageName,

      // 稀有度光晕
      showRarityGlow: showRarityGlow,
      appRarityColor: appRarityColor,
      appGlowIntensity: appGlowIntensity,
      appBorderWidth: appBorderWidth,
      appBorderColor: appBorderColor,
      appRarityName: appRarityName,
      appParticleType: appParticleType,

      // 动画
      eggAnimClass: eggAnimClass,

      // 记录和事件
      growthRecords: growthRecords,
      unreadEvents: unreadEvents,

      // 池子（异步填充）
      _poolValue: 0,

      // 宠物等级
      petLevel: pet && pet.level ? pet.level : 1,

      // 粒子特效
      showParticle: showParticle,
      // 亲密度
      showBondRemaining: showBondRemaining,
      bondRemainingText: bondRemainingText,
      bondPercent: bondPercent,
      // 称号（页面级，在宠物卡片内展示）
      streakTitle: null,
      specialTitles: [],
    }
  },

  // ===== 展示已确认的云端库存 =====
  _mergeBackpack: function(cloudBackpack) {
    var ICON_MAP = { '普通饲料': '🍍', '高级饲料': '🍠', '成长药水': '🍓', '补签卡': '🎣' }
    var DESC_MAP = { '普通饲料': '+10EXP', '高级饲料': '+30EXP', '成长药水': '+30~50XP', '补签卡': '补签一次' }

    var rawBackpack
    if (Array.isArray(cloudBackpack)) {
      // 云端数据 → 补充 icon/desc（云端只存 name+count）
      rawBackpack = cloudBackpack.map(function(item) {
        return {
          name: item.name,
          count: item.count || 0,
          icon: ICON_MAP[item.name] || '📦',
          desc: DESC_MAP[item.name] || '',
        }
      })
    } else {
      // A successful null reply means no backpack has been created yet.
      rawBackpack = cloudBackpack === null ? DEFAULT_BACKPACK : []
    }

    // 标记空物品
    var final = rawBackpack.map(function(item) {
      return Object.assign({}, item, { isEmptyClass: item.count <= 0 ? 'item-empty' : '' })
    })
    return final
  },

  async loadBackpack() {
    const app = getApp()
    const { currentOpenid, userInfo } = app.globalData
    const request = this._backpackRead = {}
    const current = () => request === this._backpackRead &&
      currentOpenid === app.globalData.currentOpenid && userInfo === app.globalData.userInfo
    try {
      const result = await cloudApi.getBackpack({ includeGiftStatus: true })
      if (!current()) return
      const hasGiftStatus = typeof result?.children_day_claimed === 'boolean'
      const items = hasGiftStatus ? result.backpack : result
      if (items !== null && !Array.isArray(items)) throw new Error('背包返回格式不正确')
      const backpack = this._mergeBackpack(items)
      if (hasGiftStatus && result.children_day_claimed) this._childrenGiftConfirmed = true
      this.setData({ backpack, bagEmpty: !backpack.some(item => item.count > 0), backpackLoadError: false,
        showChildrenDayGift: !this._childrenGiftConfirmed && (hasGiftStatus || items === null) })
    } catch (_) {
      if (current()) this.setData({ backpackLoadError: true })
    }
  },

  loadData: function() {
    var self = this
    var app = getApp()
    var owner = app.globalData.currentOpenid
    var session = app.globalData.userInfo
    var loadId = this._campLoadId = (this._campLoadId || 0) + 1
    var intent = this._petSelectionIntent
    var isCurrentLoad = function() {
      return loadId === self._campLoadId && owner === app.globalData.currentOpenid && session === app.globalData.userInfo
    }
    var takeTarget = function() {
      if (!intent || intent.scope !== accountScope(app.globalData) || self._petSelectionIntent !== intent) return ''
      self._petSelectionIntent = null
      return intent.petId
    }
    wx.showLoading({ title: '加载中...' })

    // 【V10.4】并行请求：云端背包 + 宠物数据
    var bpPromise = this.loadBackpack()
    var petsPromise = cloudApi.petOverview()

    return Promise.all([petsPromise, bpPromise]).then(async function(results) {
      if (!isCurrentLoad()) return
      var petsList = results[0]

      if (!petsList || petsList.length === 0) {
        self._displayCache = {}
        self._profileCache = {}
        self.setData({
          loading: false,
          activePet: null,
          activePetId: '',
          currentSwiperIndex: 0,
          petList: [],
          profileData: null,
          isEgg: false,
          displayPets: [],
          showEmptyPetState: true,
          showEggState: false,
          showHatchedState: false,
        })
        wx.hideLoading()
        if (takeTarget()) wx.showToast({ title: '这只宠物已不在森林里', icon: 'none' })
        return
      }

      // 遍历所有宠物，构建显示列表
      var displayPets = []
      var displayCache = {}
      for (var i = 0; i < petsList.length; i++) {
        var dp = self.buildDisplayPet(petsList[i])
        displayPets.push(dp)
        displayCache[dp._id] = dp
      }

      // 【V12】将 cloud:// fileID 转换为临时 HTTPS 链接后再 setData
      await self.resolvePetImageUrls(displayPets)
      if (!isCurrentLoad()) return
      self._displayCache = displayCache
      self._profileCache = {}

      var targetId = takeTarget()
      var targetIndex = targetId ? displayPets.findIndex(function(dp) { return dp._id === targetId }) : -1
      // 普通刷新按 ID 保留当前宠物。
      var selectedId = getPetId(self.data.activePet)
      var selectedIndex = targetIndex >= 0 ? targetIndex : Math.max(0, displayPets.findIndex(function(dp) { return dp._id === selectedId }))
      var firstDp = displayPets[selectedIndex]
      var firstPet = petsList[selectedIndex]

      // 合并所有未读事件（打上所属宠物 ID）
      var allUnreadEvents = []
      for (var j = 0; j < displayPets.length; j++) {
        var ue = displayPets[j].unreadEvents
        var ownerId = displayPets[j]._id || (petsList[j] && (petsList[j]._id || petsList[j].id))
        for (var k = 0; k < ue.length; k++) {
          ue[k]._petId = ownerId
          allUnreadEvents.push(ue[k])
        }
      }

      // 初始化图鉴（V10.5：历史物种 + 当前宠物合并）
      var currentSpecies = (petsList || []).map(function(p) { return p && p.species }).filter(Boolean)
      // 先用当前物种做初始显示，异步同步历史后再覆盖
      var initialDexP = PetConst.calcDexProgress(currentSpecies)
      var initialDexCat = PetConst.calcDexByCategory(currentSpecies)

      // 【V10.5】同步历史物种到云端，返回合并后的完整列表
      cloudApi.syncEverOwnedSpecies(currentSpecies).then(function(syncRes) {
        if (!isCurrentLoad()) return
        var mergedSpecies = (syncRes && syncRes.all_ever_owned_species)
          ? syncRes.all_ever_owned_species
          : currentSpecies
        var dexP = PetConst.calcDexProgress(mergedSpecies)
        var dexCat = PetConst.calcDexByCategory(mergedSpecies)
        console.log('[Pet] 图鉴同步完成: 历史物种=', JSON.stringify(mergedSpecies), '收集=', dexP.collected, '/', dexP.total)
        self.setData({ dexProgress: dexP, dexByCategory: dexCat })
      }).catch(function(err) {
        console.warn('[Pet] 图鉴同步失败，使用本地数据:', err)
      })

      var activeSection = 'stats'

      self.setData({
        loading: false,
        activePet: firstPet,
        activePetId: getPetId(firstPet) || '',
        currentSwiperIndex: selectedIndex,
        petList: petsList,
        app: firstDp.app,
        isEgg: firstDp.isEgg,
        hatchPercent: firstDp.hatchPercent,
        eggStageInfo: firstDp.eggStageInfo,
        xpPercent: firstDp.xpPercent,
        attributes: firstDp.attributes,
        personalityInfo: firstDp.personalityInfo,
        personalityDialogue: firstDp.personalityDialogue,
        levelTitle: firstDp.levelTitle,
        streakTitle: null,
        specialTitles: [],
        bondProgress: firstDp.bondProgress,
        attrList: firstDp.attrList,
        topAttrKey: firstDp.topAttrKey,
        moodDisplay: firstDp.moodDisplay,
        dexProgress: initialDexP,
        dexByCategory: initialDexCat,
        activeSection: activeSection,
        colorLayerStyle: firstDp.colorLayerStyle,

        // 预计算字段（V4 兼容）
        _attrTypeName: firstDp._attrTypeName,
        _speciesName: firstDp._speciesName,
        _stageName: firstDp._stageName,
        canAwaken: firstDp.canAwaken,

        // V5 蛋类型预计算字段
        _eggTypeName: firstDp._eggTypeName,
        _eggTypeColor: firstDp._eggTypeColor,
        _eggTypeEmoji: firstDp._eggTypeEmoji,

        // V6 花纹预计算字段
        _eggPatternType: firstDp._eggPatternType,
        _eggPatternDesc: firstDp._eggPatternDesc,
        _eggPatternChars: firstDp._eggPatternChars,
        _eggBgGradient: firstDp._eggBgGradient,

        // V5 BUFF预计算字段
        _buffLabel: firstDp._buffLabel,
        _buffDesc: firstDp._buffDesc,
        _hasBuff: firstDp._hasBuff,

        // V5 成长值
        _growthValue: firstDp._growthValue,
        _growthPercent: firstDp._growthPercent,

        // V6 多阶段显示
        _currentStageName: firstDp._currentStageName,
        _currentStageIcon: firstDp._currentStageIcon,
        _nextStageName: firstDp._nextStageName,
        _stageProgressPercent: firstDp._stageProgressPercent,
        _growthValueDisplay: firstDp._growthValueDisplay,

        // P3：成长记录
        growthRecords: firstDp.growthRecords,

        // 宠物陪伴事件：合并所有未读事件
        unreadEvents: allUnreadEvents,

        profileData: self.buildPetProfile(firstPet, firstDp),

        // UI状态
        showEggState: firstDp.isEgg,
        showHatchedState: !firstDp.isEgg,
        showRarityGlow: firstDp.showRarityGlow,
        showParticle: !!(firstDp.app && firstDp.app.rarityEffect && firstDp.app.rarityEffect.particle && firstDp.app.rarityEffect.particle.enabled),
        showEmptyPetState: false,
        showStatsPanel: activeSection === "stats",
        showGrowthPanel: activeSection === "growth",
        showBackpackPanel: activeSection === "backpack",
        showBondRemaining: firstDp.bondProgress && !firstDp.bondProgress.isHighest ? true : false,

        // 稀有度视觉参数
        appRarityColor: firstDp.appRarityColor,
        appBorderWidth: firstDp.appBorderWidth,
        appBorderColor: firstDp.appBorderColor,
        appRarityName: firstDp.appRarityName,
        appParticleType: firstDp.appParticleType,
        appGlowIntensity: firstDp.appGlowIntensity,

        // 动画/数值
        interactBounceClass: "",
        eggAnimClass: firstDp.eggAnimClass,
        petLevel: firstDp.petLevel,
        dexCollected: initialDexP && initialDexP.collected ? initialDexP.collected : 0,
        dexTotal: initialDexP && initialDexP.total ? initialDexP.total : 0,
        dexPercent: initialDexP && initialDexP.percent ? initialDexP.percent : 0,
        statsTabActive: "tab-active",
        growthTabActive: "",
        backpackTabActive: "",
        bondPercent: firstDp.bondProgress && firstDp.bondProgress.percent ? firstDp.bondProgress.percent : 0,
        bondRemainingText: firstDp.bondProgress && !firstDp.bondProgress.isHighest && firstDp.bondProgress.nextName ? "距离" + firstDp.bondProgress.nextName + "还差" + firstDp.bondProgress.remaining + "点" : "",
        moodBgColor: firstDp.moodDisplay && firstDp.moodDisplay.color ? firstDp.moodDisplay.color + "20" : "transparent",
        moodBorderColor: firstDp.moodDisplay && firstDp.moodDisplay.color ? firstDp.moodDisplay.color + "40" : "transparent",

        // V6 多宠物卡片列表
        displayPets: displayPets,
      })
      wx.hideLoading()
      if (targetId && targetIndex < 0) wx.showToast({ title: '这只宠物已不在森林里', icon: 'none' })

      // 每日问候（仅当不是蛋状态时显示）
      if (!firstDp.isEgg && firstPet.personality) {
        var todayKey = 'pet_greeting_' + new Date().toDateString()
        if (!wx.getStorageSync(todayKey)) {
          wx.setStorageSync(todayKey, '1')
          var greeting = PetConst.getDailyGreeting(firstPet.species, firstPet.personality, firstPet.name)
          self.setData({ dailyGreeting: greeting })
          setTimeout(function() {
            self.setData({ showGreeting: false })
          }, 5000)
        }
      }
      // 【V10.5 已移除】旧的 petCollection 异步调用会覆盖 syncEverOwnedSpecies 的正确数据
      // 图鉴现在由 syncEverOwnedSpecies 统一管理（历史+当前合并）

    }).catch(function(err) {
      if (!isCurrentLoad()) return
      wx.hideLoading()
      self.setData({ loading: false })
      if (takeTarget()) wx.showToast({ title: '宠物列表加载失败，请返回图鉴重试', icon: 'none' })
      console.error('[PetV5] loadData error:', err)
    })
  },

  // ===== V12: 将 displayPets 中的 cloud:// fileID 转换为临时 HTTPS 链接 =====
  /**
   * 收集所有 cloud:// fileID，调用 wx.cloud.getTempFileURL 批量转换为临时链接
   * 原地修改 displayPets，并保留原始 fileID 到 rawBaseSprite
   * @param {Array} displayPets
   * @returns {Promise<Array>}
   */
  resolvePetImageUrls: async function(displayPets) {
    if (!displayPets || displayPets.length === 0) return displayPets

    // 1. 收集所有 cloud:// fileID
    var fileList = []
    var petIndexMap = {}  // fileID → [dpIndex1, dpIndex2, ...]

    for (var i = 0; i < displayPets.length; i++) {
      var dp = displayPets[i]
      if (dp.isEgg || dp.portrait) continue  // 蛋和动态立绘不依赖旧云图
      var bs = dp.app && dp.app.baseSprite
      if (bs && typeof bs === 'string' && bs.indexOf('cloud://') === 0) {
        // 保存原始 fileID
        dp.app.rawBaseSprite = bs
        if (!petIndexMap[bs]) {
          petIndexMap[bs] = []
          fileList.push(bs)
        }
        petIndexMap[bs].push(i)
      }
    }

    if (fileList.length === 0) return displayPets

    var urlByFileId = {}
    try {
      var res = await wx.cloud.getTempFileURL({ fileList: fileList })
      var tempUrls = res.fileList || []
      tempUrls.forEach(function(item) {
        if (item.tempFileURL && (item.errMsg || '').indexOf('fail') === -1) {
          urlByFileId[item.fileID] = item.tempFileURL
        }
      })
    } catch (err) {
      console.warn('[PetImageResolve] getTempFileURL 调用失败:', err)
    }
    fileList.forEach(function(fileId) {
      petIndexMap[fileId].forEach(function(index) {
        displayPets[index].app.baseSprite = urlByFileId[fileId] || ''
      })
    })

    return displayPets
  },

  // 铔嬫彮鏅?

  showHatchReveal: function() {
    var pet = this.data.activePet
    if (!pet) return
    var app = this.data.app || {}
    var rc = app.rarityEffect || {}
    var pi = this.data.personalityInfo
    var attrType = pet.attr_type || ''
    var attrInfo = PetConst.getAttributeInfo(attrType)
    var rawAttrs = pet.attributes || {}
    var attrListWithVals = PetConst.buildAttrList(rawAttrs)

    this.setData({
      showHatchReveal: true,
      _revealPetId: getPetId(pet),
      _revealSpeciesText: PetConst.getSpeciesInfo(pet.species).name || '???',
      _revealRarityColor: rc.color || '#95A5A6',
      _revealRarityShadow: rc.color || 'rgba(0,0,0,0)',
      _revealRarityName: rc.name || '??',
      _revealAttrName: attrInfo ? attrInfo.name : '',
      _revealAttrColor: attrInfo ? attrInfo.color : '#999',
      _revealPersoName: pi ? pi.name : '',
      _revealPersoIcon: pi ? (pi.icon || '?') : '?',
      _revealPersoColor: pi ? (pi.color || '#999') : '',
      _revealAttrs: attrListWithVals,
    })
  },

  closeHatchReveal: function() {
    const revealed = this.data._revealPetId
    this.setData({ showHatchReveal: false, hatchRevealData: null, _revealPetId: '' })
    if (getPetId(this.data.activePet) === revealed && revealed) {
      this.setData({ ['activePet._hatch_revealed']: true })
    }
  },

  chatWithRevealedPet: function() {
    const petId = this.data._revealPetId
    createNavigation(wx, getApp).openPartner('chat', { petId, onOpen: () => {
      if (this.data._revealPetId === petId) this.closeHatchReveal()
    } })
  },

  // 铔嬪垱寤?

  // 领取新蛋（支持最多3只）
  createNewEgg: function() {
    var self = this
    var petCount = (this.data.displayPets || []).length
    if (petCount >= 3) {
      return wx.showToast({ title: '最多只能有3只宠物哦', icon: 'none' })
    }
    // 检查是否有未孵化的蛋
    var hasUnhatched = (this.data.displayPets || []).some(function(p) { return p.isEgg === true })
    if (hasUnhatched) {
      return wx.showToast({ title: '请先孵化当前的蛋再领取新蛋', icon: 'none' })
    }
    wx.showLoading({ title: '生成中...' })
    cloudApi.createEgg().then(function() {
      wx.hideLoading()
      wx.showToast({ title: '获得新蛋 🥚', icon: 'success' })
      self.loadData()
      self.loadGrowthPool()
    }).catch(function(err) {
      wx.hideLoading()
      var msg = typeof err === 'string' ? err : (err && err.message ? err.message : '领取失败')
      wx.showToast({ title: msg, icon: 'none' })
    })
  },

  // 【注意】此函数为旧版冗余入口，实际使用 createNewEgg()
  createEgg: function() {
    var p = this.data.activePet
    if (p) {
      if (p.is_hatched === false) return wx.showToast({ title: '已有正在孵化的蛋哦', icon: 'none' })
      return wx.showToast({ title: '已有宠物啦，先孵化或释放再领新蛋', icon: 'none' })
    }
    var self = this
    wx.showLoading({ title: '生成中...' })
    cloudApi.createEgg().then(function() {
      wx.hideLoading()
      wx.showToast({ title: '获得新蛋 🥚', icon: 'success' })
      self.loadData()
    }).catch(function() {
      wx.hideLoading()
      wx.showToast({ title: '领取失败', icon: 'none' })
    })
  },

  // 互动系统（含动画反馈）— V8.5优化：避免 getPetAppearance 全量重建

  petInteract: function(e) {
    if (this.data.isEgg) {
      return wx.showToast({ title: '蛋还不能互动哦，先孵化吧～', icon: 'none' })
    }

    var type = e.currentTarget.dataset.type || 'pet'
    var pet = this.data.activePet
    var petId = getPetId(pet)
    if (!petId) return
    const inFlight = this._petInteractionRequests || (this._petInteractionRequests = new Set())
    if (inFlight.has(petId)) return
    inFlight.add(petId)

    var self = this

    // 动画反馈：立即触发（不阻塞）
    self.setData({ interacting: true, interactBounceClass: "interact-bounce" })
    setTimeout(function() { self.setData({ interacting: false, interactBounceClass: "" }) }, 600)

    return cloudApi.petInteract(petId, type).then(function(res) {
      if (!res.success) {
        wx.showToast({ title: res.message || '互动失败', icon: 'none' })
        return
      }

      // 响应可能在滑到另一只后返回，只更新发起互动的那只。
      var current = self.data.petList.find(function(item) { return getPetId(item) === petId })
      if (!current) return
      var xpEarned = res.xp_earned || 0
      var bondAdded = res.bond_added || 0
      var updatedPet = {
        experience: res.new_xp != null ? res.new_xp : (current.experience || 0) + xpEarned,
        level: res.new_level || current.level,
        stage: res.new_stage || current.stage,
        bond: res.new_bond != null ? res.new_bond : current.bond,
        mood: res.mood || current.mood,
        mood_message: res.mood_message || current.mood_message,
      }
      if (!self._refreshPetUI(petId, updatedPet)) return

      var feedbackLines = []
      if (xpEarned > 0) feedbackLines.push('+' + xpEarned + ' XP')
      if (bondAdded > 0) feedbackLines.push('+' + bondAdded + ' 亲密度')
      self._showFloatingFeedback(feedbackLines.join('\n'))

      var milestone = PetConst.checkBondMilestone(current.bond || 0, updatedPet.bond || 0)
      if (milestone) {
        self.setData({ bondMilestone: milestone, showBondMilestone: true })
        setTimeout(function() {
          if (self.data.showBondMilestone) self.setData({ showBondMilestone: false })
        }, 4000)
      }
    }).catch(function() {
      wx.showToast({ title: '互动失败', icon: 'none' })
    }).finally(function() {
      inFlight.delete(petId)
    })
  },

  _showFloatingFeedback: function(text) {
    var self = this
    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    var x = 30 + Math.random() * 40
    var y = 30 + Math.random() * 20
    self.setData({
      floatingFeedback: { text: text, x: x, y: y, id: id },
      showFloatingFeedback: true,
    })
    setTimeout(function() {
      if (self.data.floatingFeedback && self.data.floatingFeedback.id === id) {
        self.setData({ showFloatingFeedback: false })
      }
    }, 1500)
  },

  // ===== 物品使用（V10.3：按类型分发真实效果）=====

  syncRewardSession() {
    const { globalData } = getApp()
    const scope = accountScope(globalData)
    const user = scope ? globalData.userInfo : null
    if (this._rewardSession?.scope === scope && this._rewardSession.user === user) return user ? this._rewardSession : null
    const changed = !!this._rewardSession
    if (this._rewardFlight) wx.hideLoading()
    this._rewardFlight = null
    this._shownAllocationId = null
    this._rewardSession = { scope, user }
    if (changed) {
      this._childrenGiftConfirmed = false
      this.setData({ activePet: null, petList: [], displayPets: [], backpack: [], fountainPoolValue: 0,
        bagEmpty: true, backpackLoadError: false, showStarterGift: false, starterClaimed: false, showChildrenDayGift: false,
        allocateAmount: '', allocateTargetId: '', allocateTargetName: '', allocatePetList: [],
        showHatchReveal: false, _revealPetId: '', showStageUpModal: false, showPersonalityModal: false, showPersonalityPromptModal: false })
    }
    this.setData({ allocationPending: null, itemPending: null, rewardStorageError: '',
      rewardBusy: false, showAllocateModal: false })
    return user ? this._rewardSession : null
  },

  ownsRewardSession(session) {
    const { globalData } = getApp()
    return this._rewardSession === session && session.user === globalData.userInfo && session.scope === accountScope(globalData)
  },

  readRewardPending(kind, session) {
    const key = REWARD_PENDING_PREFIX + kind + ':' + session.scope
    const entry = wx.getStorageSync(key) || null
    if (!entry) return null
    const { request } = entry
    if (entry.version !== 1 || typeof entry.label !== 'string' || !request ||
        typeof request.request_id !== 'string' || !/^[\w:.-]{1,128}$/.test(request.request_id)) {
      throw new Error('待确认记录无效')
    }
    if (kind === 'allocation') {
      if (typeof request.pet_id !== 'string' || !request.pet_id || !Number.isSafeInteger(request.amount) || request.amount < 1) {
        throw new Error('待确认灌注无效')
      }
    } else if (request.itemName === '补签卡') {
      if (typeof request.task_id !== 'string' || !request.task_id) throw new Error('待确认补签无效')
    } else if (!['普通饲料', '高级饲料', '成长药水'].includes(request.itemName) || typeof request.pet_id !== 'string' || !request.pet_id) {
      throw new Error('待确认道具无效')
    }
    return entry
  },

  refreshRewardPending() {
    const session = this._rewardSession
    if (!session?.user || !this.ownsRewardSession(session)) return
    let readFailed = false
    for (const kind of ['allocation', 'item']) {
      try { this.setData({ [kind + 'Pending']: this.readRewardPending(kind, session) }) }
      catch (_) { readFailed = true }
    }
    this.setData({ rewardStorageError: readFailed ? '本机待确认记录读取失败，点击重试。' : '' })
  },

  saveRewardPending(kind, session, entry) {
    wx.setStorageSync(REWARD_PENDING_PREFIX + kind + ':' + session.scope, entry)
    this.setData({ [kind + 'Pending']: entry, rewardStorageError: '' })
  },

  clearRewardPending(kind, session, entry) {
    const saved = this.readRewardPending(kind, session)
    if (saved?.request.request_id === entry.request.request_id) {
      wx.removeStorageSync(REWARD_PENDING_PREFIX + kind + ':' + session.scope)
      this.setData({ [kind + 'Pending']: null })
    } else {
      this.setData({ [kind + 'Pending']: saved })
    }
  },

  useItem(e) {
    this.syncRewardSession()
    return this.settleBackpackItem(this.data.backpack?.[e.currentTarget.dataset.index])
  },
  resumeBackpackItem() { return this.settleBackpackItem(null, true) },

  async settleBackpackItem(item, resume = false) {
    const session = this.syncRewardSession()
    if (this._rewardFlight) return
    if (!session) return wx.showToast({ title: '请先登录', icon: 'none' })
    let entry
    try {
      entry = this.readRewardPending('item', session)
      this.setData({ itemPending: entry })
    } catch (_) {
      this.setData({ rewardStorageError: '本机待确认记录读取失败，请重试。' })
      return
    }
    if (resume && !entry) return
    if (!resume && entry) return wx.showToast({ title: '请先确认上次道具使用', icon: 'none' })
    if (!resume && (!item || item.count <= 0)) return wx.showToast({ title: '道具数量不足', icon: 'none' })
    const pet = this.data.activePet
    const petId = getPetId(pet)
    const makeup = (entry?.request.itemName || item?.name) === '补签卡'
    if (!entry && !makeup && !petId) return wx.showToast({ title: '请先选择宠物', icon: 'none' })
    const operation = this._rewardFlight = {}
    this.setData({ rewardBusy: true })
    wx.showLoading({ title: '使用中...', mask: true })
    let result
    try {
      if (!entry) {
        const request = { itemName: item.name, request_id: 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2) }
        let label = pet?.name || '所选宠物'
        if (makeup) {
          const tasks = await cloudApi.tasks()
          if (!this.ownsRewardSession(session)) return
          const task = tasks.find(row => !row.completed && row.goal_id && (row.id || row._id))
          if (!task) return wx.showToast({ title: '今天没有可补签的任务', icon: 'none' })
          request.task_id = task.id || task._id
          label = task.title || '所选任务'
        } else {
          request.pet_id = petId
        }
        const next = { version: 1, request, label }
        try { this.saveRewardPending('item', session, next) }
        catch (_) {
          this.setData({ rewardStorageError: '本机未能保留道具操作，请稍后重试。' })
          return
        }
        entry = next
      }
      result = await cloudApi.useBackpackItemOnce(entry.request)
      if (!this.ownsRewardSession(session)) return
      if (!result?.success && !result?.rejected) throw new Error('使用结果未确认')
      this.clearRewardPending('item', session, entry)
    } catch (error) {
      if (!this.ownsRewardSession(session)) return
      const outdated = error === '未知操作: useBackpackItemOnce'
      wx.showToast({ title: outdated ? '云端待更新，道具操作已保留' : entry ? '使用结果待确认，请继续确认' : '暂时无法读取补签任务', icon: 'none' })
      return
    } finally {
      if (this._rewardFlight === operation) {
        this._rewardFlight = null
        wx.hideLoading()
        if (this.ownsRewardSession(session)) this.setData({ rewardBusy: false })
      }
    }
    if (!this.ownsRewardSession(session) || !this.data.campVisible) return
    if (result.rejected) return wx.showToast({ title: result.message || '道具操作未受理', icon: 'none' })
    if (Array.isArray(result.backpack)) {
      this._backpackRead = null
      const backpack = this._mergeBackpack(result.backpack)
      this.setData({ backpack, backpackLoadError: false, bagEmpty: !backpack.some(row => row.count > 0) })
    }
    if (makeup) {
      this.loadData()
      wx.showToast({ title: result.already_completed ? '这项任务已完成' : '补签成功', icon: 'success' })
    } else if (result.already_used) {
      if (result.pet) this._refreshPetUI(entry.request.pet_id, result.pet)
      wx.showToast({ title: '已确认这次道具使用', icon: 'none' })
    } else if (result.pet && this._refreshPetUI(entry.request.pet_id, result.pet)) {
      this._showFloatingFeedback(result.attribute ? result.attribute + '+1 ⭐' : '+' + result.xp_added + ' XP')
    }
  },

  // 更新同一宠物的原始记录、卡片和当前选择。返回它现在是否可见。
  _refreshPetUI: function(petId, patch) {
    const pets = this.data.petList || []
    var index = pets.findIndex(function(item) { return getPetId(item) === petId })
    if (index < 0) return false

    var updatedPet = Object.assign({}, pets[index], patch)
    var dp = this.buildDisplayPet(updatedPet)
    var oldCard = this.data.displayPets[index]
    var fileId = dp.app.baseSprite
    var needsUrl = !dp.isEgg && !dp.portrait && typeof fileId === 'string' && fileId.indexOf('cloud://') === 0
    if (needsUrl && oldCard && oldCard.app.rawBaseSprite === fileId && /^https:\/\//.test(oldCard.app.baseSprite)) {
      dp.app.rawBaseSprite = fileId
      dp.app.baseSprite = oldCard.app.baseSprite
      needsUrl = false
    } else if (needsUrl) {
      dp.app.baseSprite = ''
    }

    this._displayCache[petId] = dp
    delete this._profileCache[petId]
    var update = {}
    update['petList[' + index + ']'] = updatedPet
    update['displayPets[' + index + ']'] = dp
    this.setData(update)
    var selected = index === this.data.currentSwiperIndex
    if (selected) this.switchToPetByIndex(index)

    if (needsUrl) {
      var self = this
      var sprite = { isEgg: false, app: { baseSprite: fileId } }
      this.resolvePetImageUrls([sprite]).then(function() {
        if (self._displayCache[petId] !== dp) return
        var cardIndex = self.data.displayPets.findIndex(function(card) { return card._id === petId })
        if (cardIndex < 0) return
        dp.app.rawBaseSprite = fileId
        dp.app.baseSprite = sprite.app.baseSprite
        var imageUpdate = {}
        imageUpdate['displayPets[' + cardIndex + '].app'] = dp.app
        if (cardIndex === self.data.currentSwiperIndex) imageUpdate.app = dp.app
        self.setData(imageUpdate)
      })
    }
    return selected
  },

  // 鏀瑰悕

  showRenameModal: function() {
    this.setData({ showRenameModal: true, renameInput: this.data.activePet ? this.data.activePet.name : '' })
  },

  onRenameInput: function(e) {
    this.setData({ renameInput: e.detail.value })
  },

  cancelRenameModal: function() {
    this.setData({ showRenameModal: false })
  },

  renamePet: function() {
    var newName = this.data.renameInput && this.data.renameInput.trim()
    if (!newName) return wx.showToast({ title: '名称不能为空', icon: 'none' })
    var pet = this.data.activePet
    var self = this
    if (pet) {
      var petId = getPetId(pet)
      cloudApi.petUpdate(petId, { name: newName }).then(function() {
        self._refreshPetUI(petId, { name: newName })
        self.setData({ showRenameModal: false })
        wx.showToast({ title: '改名成功 🎊', icon: 'success' })
      }).catch(function() {
        wx.showToast({ title: '改名失败', icon: 'none' })
      })
    }
  },




  // 鍥鹃壌绯荤粺

  showDexModal: function() {
    var dex = this.data.dexProgress
    if (!dex) {
      console.warn('[Dex] dexProgress 为空，无法打开图鉴')
      return
    }

    // 【V10.5】从 SpeciesConfig 原始数据获取图标（绕过中间映射丢失问题）
    var rawList = PetConst.SpeciesConfig && PetConst.SpeciesConfig.list ? PetConst.SpeciesConfig.list : []
    console.log('[Dex] SpeciesConfig.list 长度:', rawList.length, '前3个:', rawList.slice(0, 3))
    console.log('[Dex] collectedSpecies:', JSON.stringify(dex.collectedSpecies))
    console.log('[Dex] uncollectedSpecies:', (dex.uncollectedSpecies || []).length, '个')

    var configMap = {}
    rawList.forEach(function(s) { configMap[s.id] = s })

    var allSpecies = []
    if (dex.collectedSpecies && dex.collectedSpecies.length > 0) {
      dex.collectedSpecies.forEach(function(s) {
        var cfg = configMap[s.key] || {}
        console.log('[Dex] 已拥有物种:', s.key, '→ cfg.name=', cfg.name, 'cfg.icon=', cfg.icon)
        allSpecies.push({
          key: s.key,
          name: cfg.name || s.name || s.key,
          icon: cfg.icon || s.icon || '🐾',
          owned: true,
          itemClass: 'dex-owned',
          displayIcon: cfg.icon || s.icon || '🐾',
          displayName: cfg.name || s.name || s.key,
          displayStatus: '已获得'
        })
      })
    }
    if (dex.uncollectedSpecies && dex.uncollectedSpecies.length > 0) {
      dex.uncollectedSpecies.forEach(function(s) {
        allSpecies.push({
          key: s.key,
          name: '???',
          icon: '?',
          owned: false,
          itemClass: 'dex-unowned',
          displayIcon: '?',
          displayName: '???',
          displayStatus: '???'
        })
      })
    }
    console.log('[Dex] 最终图鉴列表:', allSpecies.length, '条')
    this.setData({ showDexModal: true, dexSpeciesList: allSpecies })
  },

  closeDexModal: function() {
    this.setData({ showDexModal: false })
  },

  // 触发觉醒进化
  triggerAwaken: function() {
    var self = this
    var pet = this.data.activePet
    if (!pet) return

    wx.showModal({
      title: '确认觉醒',
      content: '觉醒后宠物将获得全新称号和特效，此操作不可逆！确定要觉醒吗？',
      confirmText: '觉醒进化',
      success: function(res) {
        if (!res.confirm) return
        wx.showLoading({ title: '觉醒中...' })
        var petId = getPetId(pet)
        cloudApi.awakenPet(petId).then(function(result) {
          wx.hideLoading()
          if (result && result.success) {
            self._refreshPetUI(petId, {
              awakened: true,
              name: result.awakened_name || result.new_name || pet.name,
            })
            wx.showToast({ title: '✨ 觉醒成功！', icon: 'success' })
          } else {
            wx.showToast({ title: result.message || '觉醒失败', icon: 'none' })
          }
        }).catch(function(err) {
          wx.hideLoading()
          wx.showToast({ title: '觉醒失败', icon: 'none' })
        })
      }
    })
  },

  // Section切换

  switchSection: function(e) {
    var section = e.currentTarget.dataset.section || 'stats'
    this.setData({
      activeSection: section,
      statsTabActive: section === 'stats' ? 'tab-active' : '',
      growthTabActive: section === 'growth' ? 'tab-active' : '',
      backpackTabActive: section === 'backpack' ? 'tab-active' : '',
    })
  },

  goCreateGoal: function() {
    wx.switchTab({ url: '/pages/goals/goals' })
  },

  // P7：完整档案弹窗

  buildPetProfile: function(_pet, dp) {
    var SpeciesConfig = require('../../utils/speciesConfig')
    var _app = dp.app
    var _isEgg = dp.isEgg

    // 基本信息
    var speciesInfo = !_isEgg && _pet.species ? SpeciesConfig.getSpecies(_pet.species) : null
    var currentStage = !_isEgg && _app.currentStage ? _app.currentStage : null

    // 四维属性（V6新属性：vitality, wisdom, luck, resonance）
    var rawAttrs2 = _pet.attributes || {}
    var v6AttrList = [
      { key: 'vitality', label: '活力', icon: '🔥', color: '#EF5350' },
      { key: 'wisdom', label: '智慧', icon: '📖', color: '#42A5F5' },
      { key: 'luck', label: '幸运', icon: '⭐', color: '#FFD54F' },
      { key: 'resonance', label: '共鸣', icon: '💗', color: '#AB47BC' },
    ].map(function(attr) {
      var val = rawAttrs2[attr.key] || 0
      var percent = Math.min(100, Math.max(0, val))
      return {
        key: attr.key,
        label: attr.label,
        icon: attr.icon,
        color: attr.color,
        val: val,
        percent: percent,
      }
    })

    // BUFF信息
    var buffInfo = null
    if (!_isEgg && _app.buffEffect && _app.buffEffect.isActive) {
      buffInfo = {
        label: _app.buffEffect.label || '',
        desc: _app.buffEffect.desc || '',
      }
    }

    // 亲密度信息
    var bondVal = _pet.bond || 0
    var bondLevelInfo = PetConst.getBondLevelInfo ? PetConst.getBondLevelInfo(bondVal) : { name: '陌生人', icon: '🤝', color: '#999' }

    // 心情
    var moodKey = _pet.mood || 'normal'
    var moodConfig = (PetConst.MOOD && PetConst.MOOD[moodKey]) || {}
    var moodEmoji = moodConfig.emoji || '😐'

    // 陪伴天数
    var companionDays = Math.max(0, Math.floor((Date.now() - (_pet.hatch_time || _pet.created_at || Date.now())) / 86400000))

    // 蛋类型信息（如果是蛋）
    var eggTypeInfo = null
    if (_isEgg) {
      eggTypeInfo = _app.eggTypeInfo || {}
    }

    return {
      // 基本信息
      species: _pet.species || '',
      speciesName: speciesInfo ? (speciesInfo.name || '未知') : (_isEgg ? '神秘蛋' : '未知'),
      speciesIcon: speciesInfo ? (speciesInfo.icon || '❓') : (_isEgg ? '🥚' : '❓'),
      name: _pet.name || _app.displayName || '未命名',
      stage: currentStage ? currentStage.key : '',
      stageName: currentStage ? currentStage.name : (_isEgg ? '蛋期' : '未知'),
      stageIcon: currentStage ? currentStage.icon : (_isEgg ? '🥚' : '❓'),
      growthValue: _pet.growth_value || 0,
      stageMaxGrowth: currentStage ? (currentStage.maxGrowth || 100) : 100,
      level: _pet.level || 1,

      // 四维属性
      attrList: v6AttrList,

      // 成长记录
      growthRecords: dp.growthRecords,

      // 性格设定
      personalityPrompt: _pet.personality_prompt || _pet.personality_desc || '暂无设定',

      // BUFF
      buffLabel: buffInfo ? buffInfo.label : null,
      buffDesc: buffInfo ? buffInfo.desc : null,

      // 陪伴信息
      bond: bondVal,
      bondLevel: bondLevelInfo,
      mood: moodKey,
      moodEmoji: moodEmoji,
      companionDays: companionDays,

      // 蛋类型
      isEgg: _isEgg,
      eggType: _isEgg ? eggTypeInfo : null,
    }
  },

  openProfile: function() {
    if (!this.data.profileData) return
    this.setData({ showProfileModal: true })
  },

  closeProfile: function() {
    this.setData({ showProfileModal: false })
  },

  // ===== V6 成长池 =====

  loadGrowthPool: function() {
    var self = this
    const app = getApp()
    const owner = app.globalData.currentOpenid
    const session = app.globalData.userInfo
    const request = this._growthPoolRead = {}
    return cloudApi.getGrowthPool().then(function(res) {
      if (request !== self._growthPoolRead || owner !== app.globalData.currentOpenid || session !== app.globalData.userInfo || !res?.success) return
      const poolVal = res.growth_pool || 0
      const displayPets = (self.data.displayPets || []).map(pet => ({ ...pet, _poolValue: poolVal }))
      const starterClaimed = self.data.starterClaimed || !!res.starter_claimed
      self.setData({ _poolValue: poolVal, _poolTotalEarned: res.total_earned || 0, fountainPoolValue: poolVal,
        fountainTotalEarned: res.total_earned || 0, displayPets,
        showStarterGift: !starterClaimed && poolVal < 100, starterClaimed })
    }).catch(function() {})
  },

  // ===== V6 阶段升级弹窗 =====

  handleHatchResult: function(res) {
    if (!res) return
    // 需要性格输入
    if (res.need_personality === true) {
      this.setData({ showPersonalityModal: true, personalityInput: '' })
      return
    }
    // 阶段升级
    if (res.stage_up) {
      var stageUpData = res.stage_up
      var attrBonusList = []
      if (stageUpData.attrBonus) {
        var attrMap = { wisdom: { icon: '🧠', name: '智慧' }, luck: { icon: '🍀', name: '幸运' }, vitality: { icon: '❤️', name: '活力' }, resonance: { icon: '💗', name: '共鸣' } }
        var bonus = stageUpData.attrBonus
        if (bonus.wisdom) attrBonusList.push({ key: 'wisdom', icon: attrMap.wisdom.icon, name: attrMap.wisdom.name, value: bonus.wisdom })
        if (bonus.luck) attrBonusList.push({ key: 'luck', icon: attrMap.luck.icon, name: attrMap.luck.name, value: bonus.luck })
        if (bonus.vitality) attrBonusList.push({ key: 'vitality', icon: attrMap.vitality.icon, name: attrMap.vitality.name, value: bonus.vitality })
        if (bonus.resonance) attrBonusList.push({ key: 'resonance', icon: attrMap.resonance.icon, name: attrMap.resonance.name, value: bonus.resonance })
      }
      this.setData({
        showStageUpModal: true,
        _stageUpData: stageUpData,
        _attrBonusList: attrBonusList,
      })
    }
    // P4：跨阶段升级时需要性格期望
    if (res.need_personality_prompt) {
      var activePetId = this.data.activePet ? (this.data.activePet.id || this.data.activePet._id) : ''
      this.setData({
        showPersonalityPromptModal: true,
        promptPetId: activePetId,
        promptTargetStage: (res.stage_up && res.stage_up.name) || '',
        personalityPromptText: '',
      })
    }
  },

  closeStageUpModal: function() {
    this.setData({ showStageUpModal: false, _stageUpData: null, _attrBonusList: [] })
  },

  // ===== V6 性格输入弹窗 =====

  onPersonalityInput: function(e) {
    this.setData({ personalityInput: e.detail.value })
  },

  cancelPersonalityModal: function() {
    this.setData({ showPersonalityModal: false, personalityInput: '' })
  },

  submitPersonality: function() {
    var desc = this.data.personalityInput && this.data.personalityInput.trim()
    if (!desc) return wx.showToast({ title: '请输入性格描述', icon: 'none' })
    if (desc.length > 50) return wx.showToast({ title: '最多50个字哦', icon: 'none' })

    var pet = this.data.activePet
    if (!pet) return
    var self = this
    var petId = getPetId(pet)
    cloudApi.setPersonality({ pet_id: petId, personality_desc: desc }).then(function(res) {
      self.setData({
        showPersonalityModal: false,
        personalityInput: '',
      })
      self._refreshPetUI(petId, { personality_desc: desc })
      wx.showToast({ title: '性格记录成功 ✨', icon: 'success' })
    }).catch(function() {
      wx.showToast({ title: '记录失败', icon: 'none' })
    })
  },

  // ===== 经验泉水系统 =====

  // 打开分配弹窗
  openAllocateModal: function() {
    const session = this.syncRewardSession()
    if (this._rewardFlight) return
    if (!session) return wx.showToast({ title: '请先登录', icon: 'none' })
    try {
      const pending = this.readRewardPending('allocation', session)
      this.setData({ allocationPending: pending })
      if (pending) {
        this._shownAllocationId = pending.request.request_id
        return this.setData({ showAllocateModal: true })
      }
    } catch (_) {
      this.setData({ rewardStorageError: '本机待确认记录读取失败，点击重试。' })
      return
    }
    this._shownAllocationId = null
    if (this.data.fountainPoolValue <= 0) {
      return wx.showToast({ title: '泉水是空的哦～', icon: 'none' })
    }
    // 构建可分配目标列表：当前所有宠物（包括蛋）
    var petList = []
    var allPets = this.data.petList || []

    // 获取蛋类型配置（用于显示名称和颜色）
    var SpeciesConfig = require('../../utils/speciesConfig')

    for (var i = 0; i < allPets.length; i++) {
      var p = allPets[i]
      var gv = p.growth_value || 0
      var isEgg = !(p.is_hatched === true)

      // 从原始数据构建显示信息（不用预计算字段，因为原始数据没有那些）
      var name, emoji, color
      if (isEgg) {
        var eggTypeCfg = SpeciesConfig.getEggType(p.egg_type)
        name = (eggTypeCfg && eggTypeCfg.name) || '神秘蛋'
        emoji = (eggTypeCfg && eggTypeCfg.emoji) || '🥚'
        color = (eggTypeCfg && eggTypeCfg.color) || '#7CB342'
      } else {
        name = p.name || '未命名'
        var spInfo = SpeciesConfig.getSpecies(p.species)
        emoji = (spInfo && spInfo.icon) || '🐾'
        color = '#AED581'
      }
      var stageText = isEgg ? ('成长值 ' + gv + '/100') : ('Lv.' + (p.level || 1))

      petList.push({
        id: p.id || p._id,
        name: name,
        emoji: emoji,
        growthValue: gv,
        isEgg: isEgg,
        stageText: stageText,
        eggTypeColor: color,
      })
    }

    if (petList.length === 0) {
      return wx.showToast({ title: '没有可分配的宠物', icon: 'none' })
    }

    // 默认选第一个
    var firstPet = petList[0]

    this.setData({
      showAllocateModal: true,
      allocatePetList: petList,
      allocateMaxPool: this.data.fountainPoolValue,
      allocateSelectedIndex: 0,
      allocateTargetId: firstPet.id,
      allocateTargetName: firstPet.name,
      allocateAmount: '0', // 默认0，让用户自己选择
    })
  },

  // 选择目标宠物
  selectAllocateTarget: function(e) {
    if (this.data.allocationPending || this._rewardFlight) return
    var idx = e.currentTarget.dataset.index
    var list = this.data.allocatePetList
    if (!list || !list[idx]) return
    var target = list[idx]
    this.setData({
      allocateSelectedIndex: idx,
      allocateTargetId: target.id,
      allocateTargetName: target.name,
    })
  },

  // 输入分配数量
  onAllocateInput: function(e) {
    if (this.data.allocationPending || this._rewardFlight) return
    this.setData({ allocateAmount: e.detail.value })
  },

  // 确认分配
  async confirmAllocate() {
    const session = this.syncRewardSession()
    if (this._rewardFlight) return
    if (!session) return wx.showToast({ title: '请先登录并选择宠物', icon: 'none' })
    let entry
    try {
      entry = this.readRewardPending('allocation', session)
      this.setData({ allocationPending: entry })
    } catch (_) {
      this.setData({ rewardStorageError: '本机待确认记录读取失败，点击重试。' })
      return
    }
    if (entry && entry.request.request_id !== this._shownAllocationId) return this.openAllocateModal()
    if (!entry && this._shownAllocationId) {
      this._shownAllocationId = null
      return this.closeAllocateModal()
    }
    if (!entry) {
      const amountStr = this.data.allocateAmount?.trim()
      const amount = Number(amountStr)
      if (!/^\d+$/.test(amountStr) || !Number.isSafeInteger(amount) || amount < 1) {
        return wx.showToast({ title: '请输入有效的整数', icon: 'none' })
      }
      const petId = this.data.allocateTargetId
      if (!petId) return wx.showToast({ title: '请先选择宠物', icon: 'none' })
      if (amount > this.data.allocateMaxPool) return wx.showToast({ title: '不能超过池子余额', icon: 'none' })
      entry = { version: 1, label: this.data.allocateTargetName || '所选宠物',
        request: { pet_id: petId, amount, request_id: 'fountain-' + Date.now() + '-' + Math.random().toString(36).slice(2) } }
      try { this.saveRewardPending('allocation', session, entry) }
      catch (_) {
        this.setData({ rewardStorageError: '本机未能保留灌注操作，请稍后重试。' })
        return
      }
    }
    const operation = this._rewardFlight = {}
    this._shownAllocationId = entry.request.request_id
    this.setData({ rewardBusy: true, showAllocateModal: false })
    wx.showLoading({ title: '灌注中...', mask: true })
    let result
    try {
      result = await cloudApi.allocatePoolOnce(entry.request)
      if (!this.ownsRewardSession(session)) return
      if (!result?.success && !result?.rejected) throw new Error('灌注结果未确认')
      this.clearRewardPending('allocation', session, entry)
      this._shownAllocationId = null
    } catch (error) {
      if (!this.ownsRewardSession(session)) return
      const outdated = error === '未知操作: allocatePoolOnce'
      wx.showToast({ title: outdated ? '云端待更新，灌注操作已保留' : '灌注结果待确认，请继续确认', icon: 'none' })
      return
    } finally {
      if (this._rewardFlight === operation) {
        this._rewardFlight = null
        wx.hideLoading()
        if (this.ownsRewardSession(session)) this.setData({ rewardBusy: false })
      }
    }
    if (!this.ownsRewardSession(session) || !this.data.campVisible) return
    if (result.rejected) return wx.showToast({ title: result.message || '灌注操作未受理', icon: 'none' })
    this.showAllocationResult(result, entry.request, session)
  },

  showAllocationResult(res, request, session) {
    const self = this
    const { amount, pet_id: petId } = request
    const view = this._rewardView
    const current = () => view === self._rewardView && self.ownsRewardSession(session) && self.data.campVisible
    // 刷新池子和宠物数据
    self.loadGrowthPool()
    self.loadData()

    // 显示结果
    if (res.message) {
      var title = res.hatched && res.allocated < amount ? '已孵化，剩余成长留在泉水' : res.message
      wx.showToast({ title: title, icon: 'none', duration: 2000 })
    }

    // 处理孵化结果（V8.4修复：分配触发孵化时显示揭晓弹窗）
    if (res.hatched === true && res.pet) {
      // 延迟显示揭晓弹窗（等loadData刷新完UI后再展示）
      setTimeout(function() {
        if (!current()) return
        var revealPet = res.pet
        var rc = { color: '#95A5A6', name: '普通' }
        if (revealPet.rarity === 'rare') rc = { color: '#448AFF', name: '稀有' }
        else if (revealPet.rarity === 'epic') rc = { color: '#9C27B0', name: '史诗' }
        else if (revealPet.rarity === 'legendary') rc = { color: '#FF9800', name: '传说' }

        var spInfo = PetConst.getSpeciesInfo(revealPet.species)
        var attrType = revealPet.attribute_type || ''
        var attrInfo = PetConst.getAttributeInfo(attrType)
        var rawAttrs = revealPet.attributes || {}
        var attrListWithVals = PetConst.buildAttrList(rawAttrs)

        self.setData({
          showHatchReveal: true,
          _revealPetId: getPetId(revealPet),
          _revealSpeciesText: spInfo.name || '神秘生物',
          _revealRarityColor: rc.color,
          _revealRarityShadow: rc.color,
          _revealRarityName: rc.name,
          _revealAttrName: attrInfo ? attrInfo.name : '',
          _revealAttrColor: attrInfo ? attrInfo.color : '#999',
          _revealAttrs: attrListWithVals,
        })
      }, 800)
    }

    // 处理阶段升级弹窗
    if (res.stage_up) {
      var attrBonusList = Object.keys(res.attr_bonus || {}).map(function(k) {
        var icons = { wisdom: '💡', luck: '🍀', vitality: '❤️', resonance: '💗' }
        var names = { wisdom: '智慧', luck: '幸运', vitality: '活力', resonance: '共鸣' }
        return { key: k, icon: icons[k] || '⭐', name: names[k] || k, value: res.attr_bonus[k] }
      })

      setTimeout(function() {
        if (!current()) return
        self.setData({
          showStageUpModal: true,
          _stageUpData: res.stage_up,
          _attrBonusList: attrBonusList,
        })
      }, 1500)
    }

    // 处理孵化后性格输入
    if (res.need_personality) {
      setTimeout(function() {
        if (!current()) return
        self.setData({ showPersonalityModal: true })
      }, 2000)
    }

    // P4：跨阶段升级时需要性格期望
    if (res.need_personality_prompt) {
      self.setData({
        showPersonalityPromptModal: true,
        promptPetId: petId,
        promptTargetStage: (res.stage_up && res.stage_up.name) || '',
        personalityPromptText: '',
      })
    }
  },

  // 关闭分配弹窗
  closeAllocateModal: function() {
    this.setData({
      showAllocateModal: false,
      allocateTargetId: '',
      allocateTargetName: '',
      allocateAmount: '',
      allocateSelectedIndex: -1,
      allocatePetList: [],
    })
  },

  // 一键填入全部
  setAllAmount: function() {
    if (this.data.allocationPending || this._rewardFlight) return
    this.setData({ allocateAmount: String(this.data.allocateMaxPool) })
  },

  // 快捷投入按钮
  quickAddAmount: function(e) {
    if (this.data.allocationPending || this._rewardFlight) return
    var addAmount = parseInt(e.currentTarget.dataset.amount) || 0
    var currentVal = parseInt(this.data.allocateAmount) || 0
    var maxPool = this.data.allocateMaxPool || 0

    if (addAmount === 0) {
      // 全部投入
      this.setData({ allocateAmount: String(maxPool) })
    } else {
      var newVal = currentVal + addAmount
      if (newVal > maxPool) newVal = maxPool
      this.setData({ allocateAmount: String(newVal) })
    }
  },

  // ===== 蛋刷新系统 =====

  // V6: 打开蛋类型刷新弹窗（支持多宠物，通过 data-index 传入）
  openRefreshEggModal: function(e) {
    var idx = e && e.currentTarget ? (e.currentTarget.dataset.index || 0) : this.data.currentSwiperIndex
    var displayPets = this.data.displayPets || []
    if (!displayPets[idx]) return wx.showToast({ title: '没有宠物', icon: 'none' })
    var pet = displayPets[idx]._raw
    if (!pet) return wx.showToast({ title: '没有宠物', icon: 'none' })
    if (pet.is_hatched === true) return wx.showToast({ title: '已孵化不能换哦', icon: 'none' })

    var SpeciesConfig = require('../../utils/speciesConfig')
    var options = SpeciesConfig.getEggTypeOptions()
    var currentType = pet.egg_type || 'forest_egg'

    // 找到当前类型索引
    var currentIndex = -1
    for (var i = 0; i < options.length; i++) {
      if (options[i].key === currentType) { currentIndex = i; break }
    }

    this.setData({
      showRefreshModal: true,
      refreshEggOptions: options,
      refreshSelectedIndex: currentIndex,
      _refreshTargetIndex: idx,  // 记录要刷新哪只宠物
    })
  },

  selectRefreshEggType: function(e) {
    this.setData({ refreshSelectedIndex: e.currentTarget.dataset.index })
  },

  confirmRefreshEgg: function() {
    var idx = this.data.refreshSelectedIndex
    var options = this.data.refreshEggOptions
    console.log('[PetV6] confirmRefreshEgg idx=' + idx + ' options=', options)
    if (!options || !options[idx]) return wx.showToast({ title: '请选择蛋类型', icon: 'none' })

    var targetIdx = this.data._refreshTargetIndex || 0
    var displayPets = this.data.displayPets || []
    if (!displayPets[targetIdx]) return

    var pet = displayPets[targetIdx]._raw
    if (!pet) return

    var targetType = options[idx].key
    console.log('[PetV6] 确认更换 → targetType=' + targetType + ' pet[' + targetIdx + '].egg_type=' + (pet.egg_type || ''))
    var self = this
    self.setData({ showRefreshModal: false })

    wx.showLoading({ title: '转换中...' })
    cloudApi.refreshEgg({
      pet_id: pet.id || pet._id,
      target_egg_type: targetType,
    }).then(function(res) {
      wx.hideLoading()
      wx.showToast({ title: res.message || '换好了！', icon: 'success' })
      self.loadData()
    }).catch(function(err) {
      wx.hideLoading()
      wx.showToast({ title: typeof err === 'string' ? err : '刷新失败', icon: 'none' })
    })
  },

  closeRefreshModal: function() {
    this.setData({ showRefreshModal: false, refreshSelectedIndex: -1, refreshEggOptions: [] })
  },

  // V6: 轮播切换时更新当前活跃宠物（swiper bindchange）
  onSwiperChange: function(e) {
    var idx = e.detail.current || 0
    this.switchToPetByIndex(idx)
  },

  // V6: 点击指示点切换宠物
  switchToPet: function(e) {
    var idx = e.currentTarget.dataset.index || 0
    this.switchToPetByIndex(idx)
  },

  // V6: 内部切换方法 — V8.5优化：使用缓存避免 buildDisplayPet 重复调用
  switchToPetByIndex: function(idx) {
    var displayPets = this.data.displayPets || []
    var petsList = this.data.petList || []
    if (!displayPets[idx] || !petsList[idx]) return

    var rawPet = petsList[idx]

    // 【V8.5优化】优先使用缓存（loadData 时已全部 build 并缓存），避免重建卡顿
    var dp = this._displayCache[rawPet._id || rawPet.id]
    if (!dp) {
      dp = this.buildDisplayPet(rawPet)
      this._displayCache[dp._id] = dp
    }

    var petId = getPetId(rawPet)
    var profileData = this._profileCache[petId]
    if (!profileData) {
      profileData = this.buildPetProfile(rawPet, dp)
      this._profileCache[petId] = profileData
    }

    this.setData({
      currentSwiperIndex: idx,
      activePet: rawPet,
      isEgg: dp.isEgg,

      app: dp.app,
      hatchPercent: dp.hatchPercent,
      eggStageInfo: dp.eggStageInfo,
      xpPercent: dp.xpPercent,
      attributes: dp.attributes,
      personalityInfo: dp.personalityInfo,
      personalityDialogue: dp.personalityDialogue,
      levelTitle: dp.levelTitle,
      bondProgress: dp.bondProgress,
      attrList: dp.attrList,
      topAttrKey: dp.topAttrKey,
      moodDisplay: dp.moodDisplay,
      colorLayerStyle: dp.colorLayerStyle,

      _attrTypeName: dp._attrTypeName,
      _speciesName: dp._speciesName,
      _stageName: dp._stageName,
      canAwaken: dp.canAwaken,

      _eggTypeName: dp._eggTypeName,
      _eggTypeColor: dp._eggTypeColor,
      _eggTypeEmoji: dp._eggTypeEmoji,

      _eggPatternType: dp._eggPatternType,
      _eggPatternDesc: dp._eggPatternDesc,
      _eggPatternChars: dp._eggPatternChars,
      _eggBgGradient: dp._eggBgGradient,

      _buffLabel: dp._buffLabel,
      _buffDesc: dp._buffDesc,
      _hasBuff: dp._hasBuff,

      _growthValue: dp._growthValue,
      _growthPercent: dp._growthPercent,

      _currentStageName: dp._currentStageName,
      _currentStageIcon: dp._currentStageIcon,
      _nextStageName: dp._nextStageName,
      _stageProgressPercent: dp._stageProgressPercent,
      _growthValueDisplay: dp._growthValueDisplay,

      growthRecords: dp.growthRecords,

      activePetId: rawPet.id || rawPet._id || '',

      profileData: profileData,
    })
  },

  /** 手滑切换宠物（swiper bindchange） */
  onCampSwiperChange: function(e) {
    var idx = e.detail.current
    this.switchToPetByIndex(idx)
  },

  // ===== 森林礼包 =====
  claimStarterXp() { return this.claimForestGift(true) },
  claimChildrenDayGift() { return this.claimForestGift(false) },

  async claimForestGift(starter) {
    const session = this.syncRewardSession()
    if (!session || this._rewardFlight || !this.data[starter ? 'showStarterGift' : 'showChildrenDayGift']) return
    const operation = this._rewardFlight = {}
    this.setData({ rewardBusy: true })
    wx.showLoading({ title: '领取中...', mask: true })
    let receipt
    try {
      receipt = await (starter ? cloudApi.claimStarterXp() : cloudApi.claimChildrenDayGift())
    } catch (_) {
      // A refresh can reconcile a committed claim even if its response was lost.
    } finally {
      if (this._rewardFlight === operation) {
        this._rewardFlight = null
        wx.hideLoading()
        if (this.ownsRewardSession(session)) this.setData({ rewardBusy: false })
      }
    }
    if (!this.ownsRewardSession(session)) return
    const confirmed = receipt?.success === true || receipt?.already_claimed === true
    if (confirmed) {
      if (starter) this.setData({ showStarterGift: false, starterClaimed: true })
      else {
        this._childrenGiftConfirmed = true
        this.setData({ showChildrenDayGift: false })
      }
    }
    if (!this.data.campVisible) return
    wx.showToast({
      title: receipt?.message || (confirmed ? '礼包已领取' : '领取结果待确认，请核对礼包状态'),
      icon: confirmed && !receipt.already_claimed ? 'success' : 'none',
    })
    if (confirmed || !receipt) return starter ? this.loadGrowthPool() : this.loadBackpack()
  },

  randomRefreshEgg: function() {
    var pet = this.data.activePet
    if (!pet) return wx.showToast({ title: '没有宠物', icon: 'none' })
    if (pet.is_hatched === true) return wx.showToast({ title: '已孵化不能换哦', icon: 'none' })

    var self = this
    wx.showLoading({ title: '随机变换...' })
    cloudApi.refreshEgg({
      pet_id: pet.id || pet._id,
      // 不传 target_egg_type → 随机
    }).then(function(res) {
      wx.hideLoading()
      wx.showToast({ title: res.message || '换好了！', icon: 'success' })
      self.loadData()
    }).catch(function(err) {
      wx.hideLoading()
      wx.showToast({ title: typeof err === 'string' ? err : '刷新失败', icon: 'none' })
    })
  },

  // ===== P3：成长记录切换 =====

  toggleGrowthRecords: function() {
    this.setData({ showGrowthRecords: !this.data.showGrowthRecords })
  },

  // ===== P4：性格期望弹窗 =====

  submitPersonalityPrompt: function() {
    var text = this.data.personalityPromptText.trim()
    if (!text) {
      return wx.showToast({ title: '请输入性格期望', icon: 'none' })
    }
    var self = this
    cloudApi.setPersonalityPrompt({
      pet_id: this.data.promptPetId,
      prompt: text,
    }).then(function(res) {
      self.setData({
        showPersonalityPromptModal: false,
        personalityPromptText: '',
      })
      wx.showToast({ title: '性格期望已记录', icon: 'success' })
      self.loadData()
    }).catch(function(err) {
      wx.showToast({ title: err.message || '设置失败', icon: 'none' })
    })
  },

  closePersonalityPromptModal: function() {
    this.setData({ showPersonalityPromptModal: false, personalityPromptText: '' })
  },

  onPersonalityPromptInput: function(e) {
    this.setData({ personalityPromptText: e.detail.value })
  },

  // ===== 宠物陪伴事件系统（V6 Phase 6）=====

  showEventDetail: function(e) {
    var eventId = e.currentTarget.dataset.id
    var event = this.data.unreadEvents.find(function(ev) { return ev.id === eventId })
    if (!event) return
    this.setData({
      showEventModal: true,
      currentEvent: event,
      eventContentLines: (event.content || '').split('\n'),
    })
  },

  closeEventModal: function() {
    // 标记已读（使用事件自带的 _petId，确保找到正确的宠物）
    if (this.data.currentEvent && !this.data.currentEvent.read) {
      var evtPetId = this.data.currentEvent._petId
        || this.data.activePetId
        || (this.data.activePet && (this.data.activePet._id || this.data.activePet.id))
      cloudApi.markEventRead({
        pet_id: evtPetId,
        event_id: this.data.currentEvent.id,
      }).catch(function(){})
    }
    this.setData({ showEventModal: false, currentEvent: null })
    this.loadData() // 刷新移除已读
  },
})
