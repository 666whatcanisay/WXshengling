﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿const cloudApi = require('../../utils/cloudApi')
const PetConst = require('../../utils/petConstants')
const PersonalityConfig = require('../../utils/personalityConfig')
const TitleConfig = require('../../utils/titleConfig')

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
    backpack: DEFAULT_BACKPACK,

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
    _isUsingItem: false,
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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    // 【安全修复】离线模式不加载云端数据，避免串号
    var app = getApp()
    if (app.isOfflineMode) {
      console.warn('[Pets] 离线模式，跳过云端数据加载')
      this.setData({ loading: false })
      return
    }
    this._initBondMaps()
    this.loadData()
    this.loadGrowthPool()
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
    var stageInfo = PetConst.getStageInfo(pet.stage)
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
    var canAwaken = !isEgg && pet.stage === 'ADULT' && !(pet.awakened === true)

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

      // V7 异色
      isShiny: pet.is_shiny === true,
      // V7.1 颜色档次
      colorTier: pet.color_tier || 'normal',
      colorLabel: pet.color_label || '普通',
      // V8.0 天赋
      talent: pet.talent || 1,
      talentGrade: pet.talent_grade || 'F',
      talentName: pet.talent_name || '普通',
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

  // ===== V10.4：合并背包（云端优先，本地兜底）=====
  _mergeBackpack: function(cloudBackpack) {
    var ICON_MAP = { '普通饲料': '🍍', '高级饲料': '🍠', '成长药水': '🍓', '补签卡': '🎣' }
    var DESC_MAP = { '普通饲料': '+10EXP', '高级饲料': '+30EXP', '成长药水': '+30~50XP', '补签卡': '补签一次' }

    var rawBackpack
    if (cloudBackpack && Array.isArray(cloudBackpack) && cloudBackpack.length > 0) {
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
      // 无云端数据 → 用本地存储或默认值
      var stored = wx.getStorageSync('pet_backpack')
      rawBackpack = (stored && Array.isArray(stored) && stored.length > 0)
        ? stored : DEFAULT_BACKPACK.slice()
    }

    // 标记空物品 + 同步到本地
    var final = rawBackpack.map(function(item) {
      return Object.assign({}, item, { isEmptyClass: item.count <= 0 ? 'item-empty' : '' })
    })
    wx.setStorageSync('pet_backpack', final)
    return final
  },

  loadData: function() {
    var self = this
    wx.showLoading({ title: '加载中...' })

    // 【V10.4】并行请求：云端背包 + 宠物数据
    var bpPromise = cloudApi.getBackpack().catch(function(err) {
      console.warn('[Pet] 云端背包同步失败，使用本地:', err)
      return null  // null 表示回退到本地
    })
    var petsPromise = cloudApi.petOverview()

    Promise.all([bpPromise, petsPromise]).then(async function(results) {
      var cloudBackpack = results[0]
      var petsList = results[1]

      // ===== 合并背包（云端优先，本地兜底）=====
      var finalBackpack = self._mergeBackpack(cloudBackpack)

      // 检查儿童节礼包：云端无记录 → 显示领取入口
      if (cloudBackpack === null || !cloudBackpack) {
        self.setData({ showChildrenDayGift: true })
      }

      if (!petsList || petsList.length === 0) {
        self.setData({
          loading: false,
          activePet: null,
          isEgg: false,
          displayPets: [],
          showEmptyPetState: true,
          showEggState: false,
          showHatchedState: false,
          backpack: finalBackpack,
          bagEmpty: !finalBackpack.some(function(i) { return i.count > 0 }),
        })
        wx.hideLoading()
        return
      }

      // 遍历所有宠物，构建显示列表
      var displayPets = []
      self._displayCache = {}  // 清空旧缓存
       self._profileCache = {} // 清空档案缓存
       for (var i = 0; i < petsList.length; i++) {
        var dp = self.buildDisplayPet(petsList[i])
        displayPets.push(dp)
        self._displayCache[dp._id] = dp  // 缓存以便轮播切换时复用
      }

      // 【V12】将 cloud:// fileID 转换为临时 HTTPS 链接后再 setData
      await self.resolvePetImageUrls(displayPets)

      // activePet 取第一个（供弹窗/交互使用）
      var firstDp = displayPets[0]
      var firstPet = petsList[0]

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
        activePetId: firstPet.id || firstPet._id || '',

      // P7：完整档案预计算字段（供弹窗使用）
      profileData: (function() {
        var SpeciesConfig = require('../../utils/speciesConfig')
        var _app = firstDp.app
        var _pet = firstPet
        var _isEgg = firstDp.isEgg

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
          growthRecords: firstDp.growthRecords,

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
      })(),

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
        bagEmpty: !finalBackpack.some(function(i) { return i.count > 0 }),
        backpack: finalBackpack,
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
      wx.hideLoading()
      self.setData({ loading: false })
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
      if (dp.isEgg) continue  // 蛋不走图片加载
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

    // 2. 调用 wx.cloud.getTempFileURL 批量转换
    try {
      var res = await wx.cloud.getTempFileURL({ fileList: fileList })
      var tempUrls = res.fileList || []

      for (var j = 0; j < tempUrls.length; j++) {
        var item = tempUrls[j]
        var fid = item.fileID
        var tempUrl = item.tempFileURL
        var errMsg = item.errMsg || ''
        var indices = petIndexMap[fid]

        if (indices && tempUrl && errMsg.indexOf('fail') === -1) {
          console.log('[PetImageResolve] fileID=' + fid + ' temp=' + tempUrl)
          for (var k = 0; k < indices.length; k++) {
            var idx = indices[k]
            if (displayPets[idx] && displayPets[idx].app) {
              displayPets[idx].app.baseSprite = tempUrl
            }
          }
        } else if (indices) {
          // 单个 fileID 转换失败
          console.warn('[PetImageResolve] 转换失败: fileID=' + fid + ' err=' + errMsg)
          for (var k = 0; k < indices.length; k++) {
            var idx = indices[k]
            if (displayPets[idx] && displayPets[idx].app) {
              displayPets[idx].app.baseSprite = ''
            }
          }
        }
      }
    } catch (err) {
      // 整个 API 调用失败，所有 cloud:// baseSprite 置空
      console.warn('[PetImageResolve] getTempFileURL 调用失败:', err)
      for (var i = 0; i < displayPets.length; i++) {
        var dp = displayPets[i]
        if (!dp.isEgg && dp.app && dp.app.baseSprite && typeof dp.app.baseSprite === 'string' && dp.app.baseSprite.indexOf('cloud://') === 0) {
          console.warn('[PetImageResolve] 回退 emoji species=' + ((dp._raw || {}).species || '?') + ' path=' + dp.app.baseSprite)
          dp.app.baseSprite = ''
        }
      }
    }

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
    this.setData({ showHatchReveal: false, hatchRevealData: null })
    if (this.data.activePet) {
      this.setData({ ['activePet._hatch_revealed']: true })
    }
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
    if (!pet) return

    var self = this

    // 动画反馈：立即触发（不阻塞）
    self.setData({ interacting: true, interactBounceClass: "interact-bounce" })
    setTimeout(function() { self.setData({ interacting: false, interactBounceClass: "" }) }, 600)

    cloudApi.petInteract(pet.id, type).then(function(res) {
      if (!res.success) {
        wx.showToast({ title: res.message || '互动失败', icon: 'none' })
        return
      }

      var xpEarned = res.xp_earned || 0
      var bondAdded = res.bond_added || 0
      var feedbackLines = []
      if (xpEarned > 0) feedbackLines.push('+' + xpEarned + ' XP')
      if (bondAdded > 0) feedbackLines.push('+' + bondAdded + ' 亲密度')
      var fbText = feedbackLines.join('\n')

      var newExp = res.new_xp || ((pet.experience || 0) + xpEarned)
      var newStage = pet.stage
      var stageChanged = false
      if (res.stage_changed) { newStage = res.new_stage; stageChanged = true }

      var updatedPet = Object.assign({}, pet, {
        experience: newExp,
        level: res.new_level || pet.level,
        stage: newStage,
        bond: res.new_bond || pet.bond,
        mood: res.mood || pet.mood,
        mood_message: res.mood_message || pet.mood_message,
      })

      // 【V8.5优化】只在阶段变化时才调用 getPetAppearance（重度）
      // 普通互动只更新 mood/attrs/bond 等轻量字段
      var updateData = { activePet: updatedPet }
      var moodChanged = updatedPet.mood !== pet.mood

      if (stageChanged) {
        var newApp = PetConst.getPetAppearance(updatedPet)
        var newColorStyle = ''
        if (newApp.rarityEffect && newApp.rarityEffect.colorLayer && newApp.rarityEffect.colorLayer.enabled) {
          newColorStyle = 'filter: hue-rotate(' + newApp.rarityEffect.colorLayer.hueRotate + 'deg) saturate(' + (1 + newApp.rarityEffect.colorLayer.saturate / 100) + ')'
        }
        updateData.app = newApp
        updateData.colorLayerStyle = newColorStyle
      } else {
        // 轻量增量更新：心情变了才更新 moodDisplay
        updateData.app = self.data.app
        if (moodChanged) {
          updateData.moodDisplay = PetConst.getMoodDisplay(updatedPet.mood || 'normal')
          var dialogue = PersonalityConfig.getPersonalityDialogue(pet.personality, updatedPet.name || '??')
          updateData.personalityDialogue = dialogue
        }
      }

      var newBondProgress = PetConst.calcBondProgress(updatedPet.bond || 0)
      updateData.xpPercent = PetConst.calcXpPercent(newExp, newStage)
      updateData.bondProgress = newBondProgress
      updateData.attrList = PetConst.buildAttrList(updatedPet.attributes || {})

      // 【V8.6修复】同步更新 displayPets 中的亲密度相关字段
      //   之前只更新了 bondProgress 对象，但 WXML 使用的是 dp.bondPercent 等派生字段
      //   且 setData 未包含 displayPets，框架不知道需要重新渲染
      var newBondPct = newBondProgress ? newBondProgress.percent : 0
      var newShowRemaining = newBondProgress && !newBondProgress.isHighest
      var newRemainingText = newBondProgress && !newBondProgress.isHighest && newBondProgress.nextName
        ? '距离' + newBondProgress.nextName + '还差' + (newBondProgress.remaining || 0) + '点' : ''

      var cacheKey = updatedPet._id || updatedPet.id
      var swiperIdx = self.data.currentSwiperIndex || 0
      var displayPets = self.data.displayPets || []
      if (self._displayCache[cacheKey]) {
        var cachedDp = self._displayCache[cacheKey]
        if (stageChanged && updateData.app) cachedDp.app = updateData.app
        cachedDp.xpPercent = updateData.xpPercent
        cachedDp.bondProgress = newBondProgress
        cachedDp.bondPercent = newBondPct
        cachedDp.showBondRemaining = newShowRemaining
        cachedDp.bondRemainingText = newRemainingText
        cachedDp.attrList = updateData.attrList
        if (moodChanged && updateData.moodDisplay) cachedDp.moodDisplay = updateData.moodDisplay
        if (stageChanged && updateData.colorLayerStyle) cachedDp.colorLayerStyle = updateData.colorLayerStyle
      }

      // 【V8.6修复】把当前宠物的 dp 写回 displayPets 数组并纳入 setData
      //   让微信框架感知到变化，触发 WXML 重新渲染亲密度进度条
      if (displayPets[swiperIdx] && displayPets[swiperIdx]._id === cacheKey) {
        updateData['displayPets[' + swiperIdx + '].bondProgress'] = newBondProgress
        updateData['displayPets[' + swiperIdx + '].bondPercent'] = newBondPct
        updateData['displayPets[' + swiperIdx + '].showBondRemaining'] = newShowRemaining
        updateData['displayPets[' + swiperIdx + '].bondRemainingText'] = newRemainingText
        updateData['displayPets[' + swiperIdx + '].xpPercent'] = updateData.xpPercent
        updateData['displayPets[' + swiperIdx + '].attrList'] = updateData.attrList
        if (moodChanged && updateData.moodDisplay) {
          updateData['displayPets[' + swiperIdx + '].moodDisplay'] = updateData.moodDisplay
        }
      }

      // 浮动反馈
      self._showFloatingFeedback(fbText)

      // 亲密度里程碑检查（异步，不阻塞）
      var milestone = PetConst.checkBondMilestone(pet.bond || 0, updatedPet.bond || 0)
      if (milestone) {
        updateData.bondMilestone = milestone
        updateData.showBondMilestone = true
        setTimeout(function() {
          if (self.data.showBondMilestone) {
            self.setData({ showBondMilestone: false })
          }
        }, 4000)
      }

      self.setData(updateData)

    }).catch(function() {
      wx.showToast({ title: '互动失败', icon: 'none' })
    })
  },

  _showFloatingFeedback: function(text) {
    var self = this
    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    var x = 30 + Math.random() * 40
    var y = 30 + Math.random() * 20
    self.setData({
      floatingFeedback: { text: text, x: x, y: y, id: id }
    })
    setTimeout(function() {
      if (self.data.floatingFeedback && self.data.floatingFeedback.id === id) {
        self.setData({ showFloatingFeedback: false })
      }
    }, 1500)
  },

  // ===== 物品使用（V10.3：按类型分发真实效果）=====

  useItem: function(e) {
    // 【防重复点击】
    if (this.data._isUsingItem) return
    this.setData({ _isUsingItem: true })

    var index = e.currentTarget.dataset.index
    var item = this.data.backpack[index]
    if (!item || item.count <= 0) {
      this.setData({ _isUsingItem: false })
      return wx.showToast({ title: '道具数量不足', icon: 'none' })
    }

    var self = this
    var pet = this.data.activePet

    // 按物品名分发效果
    var itemName = item.name
    if (itemName === '成长药水') {
      self._useGrowthPotion(index, item, pet)
    } else if (itemName === '补签卡') {
      self._useMakeupCard(index, item, pet)
    } else if (itemName === '普通饲料' || itemName === '高级饲料') {
      self._useFeed(index, item, pet)
    } else {
      self._useFeed(index, item, pet)
    }

    // 800ms 后解锁（覆盖大多数云端响应时间）
    setTimeout(function() { self.setData({ _isUsingItem: false }) }, 800)
  },

  // --- 饲料：直接加经验值+成长值到宠物（V10.5：云端确认后才更新UI）---
  _useFeed: function(index, item, pet) {
    if (!pet) return wx.showToast({ title: '没有可用的宠物', icon: 'none' })

    var xpMatch = (item.desc || '').match(/\+(\d+)/)
    var addXp = xpMatch ? parseInt(xpMatch[1]) : 10
    var self = this
    var petId = pet._id || pet.id

    console.log('[Pet][useFeed] 开始:', item.name, 'XP:', addXp, '当前exp:', pet.experience, '当前gv:', pet.growth_value, 'petId:', petId)

    wx.showLoading({ title: '使用中...' })

    // 先消耗物品
    this._consumeItem(index, item)

    var newExp = (pet.experience || 0) + addXp
    var newGv = (pet.growth_value || 0) + addXp  // 经验和成长值同步增加
    var newStage = pet.stage || 'EGG'
    var STAGE_THRESHOLDS = { EGG: 0, BABY: 50, YOUTH: 150, ADULT: 300, PERFECT: 500 }
    for (var sk in STAGE_THRESHOLDS) {
      if (newExp >= STAGE_THRESHOLDS[sk]) newStage = sk
    }

    console.log('[Pet][useFeed] 目标: exp=', newExp, 'gv=', newGv, 'stage=', newStage)

    // 写云端：同时更新 experience + growth_value
    cloudApi.petUpdate(petId, { experience: newExp, growth_value: newGv, stage: newStage }).then(function(res) {
      console.log('[Pet][useFeed] ✓ 云端写入成功:', JSON.stringify(res))
      wx.hideLoading()

      // 用完整更新后的数据构建新显示对象
      var updatedPet = Object.assign({}, pet, { experience: newExp, growth_value: newGv, stage: newStage })

      self._addGrowthLog(addXp, '使用了【' + item.name + '】')
      self._showFloatingFeedback('+' + addXp + ' XP')
      self._refreshPetUI(updatedPet)
    }).catch(function(err) {
      console.error('[Pet][useFeed] ✗ 云端写入失败:', err)
      wx.hideLoading()
      wx.showToast({ title: '使用失败，请检查网络', icon: 'none' })
      self._rollbackItem(index, item)
    })
  },

  // --- 成长药水（V10.5 重做）：90%概率加30-50XP，10%概率随机属性+1 ---
  _useGrowthPotion: function(index, item, pet) {
    if (!pet) return wx.showToast({ title: '没有可用的宠物', icon: 'none' })
    var self = this
    var petId = pet._id || pet.id

    wx.showLoading({ title: '使用中...' })

    // 随机判定：90% 加经验 / 10% 加属性
    var roll = Math.random()
    var isXpMode = roll < 0.9

    // 消耗物品
    this._consumeItem(index, item)

    var updateData = {}
    var fbText = ''

    if (isXpMode) {
      // 【90%】随机 30~50 XP（同步增加成长值，确保界面数字跳动）
      var addXp = Math.floor(Math.random() * 21) + 30  // 30~50
      var newExp = (pet.experience || 0) + addXp
      var newGv = (pet.growth_value || 0) + addXp
      var newStage = pet.stage || 'EGG'
      var STAGE_THRESHOLDS = { EGG: 0, BABY: 50, YOUTH: 150, ADULT: 300, PERFECT: 500 }
      for (var sk in STAGE_THRESHOLDS) {
        if (newExp >= STAGE_THRESHOLDS[sk]) newStage = sk
      }
      updateData.experience = newExp
      updateData.growth_value = newGv
      updateData.stage = newStage
      fbText = '+' + addXp + ' XP 🍓'

      console.log('[Potion] XP模式 +', addXp, '→ exp=', newExp, 'gv=', newGv, newStage)
    } else {
      // 【10%】随机属性 +1
      var ATTR_KEYS = ['strength', 'agility', 'intelligence', 'charm', 'luck']
      var rawAttrs = pet.attributes || {}
      var attrKey = ATTR_KEYS[Math.floor(Math.random() * ATTR_KEYS.length)]
      var newVal = (rawAttrs[attrKey] || 0) + 1
      updateData.attributes = Object.assign({}, rawAttrs)
      updateData.attributes[attrKey] = newVal
      fbText = attrKey + '+1 ⭐'

      console.log('[Potion] 属性模式', attrKey, '+1 →', newVal)
    }

    cloudApi.petUpdate(petId, updateData).then(function(res) {
      console.log('[Potion] ✓ 云端写入成功')
      wx.hideLoading()

      var updatedPet = Object.assign({}, pet, updateData)
      var reason = isXpMode
        ? ('使用了【成长药水】，+' + fbText)
        : ('使用了【成长药水】，' + fbText)
      self._addGrowthLog(isXpMode ? parseInt(fbText.match(/\d+/)[0]) : 0, reason)
      self._showFloatingFeedback(fbText)
      self._refreshPetUI(updatedPet)
    }).catch(function(err) {
      console.error('[Potion] ✗ 云端写入失败:', err)
      wx.hideLoading()
      wx.showToast({ title: '使用失败', icon: 'none' })
      self._rollbackItem(index, item)
    })
  },

  // --- 补签卡：对今日未完成任务进行补签 ---
  _useMakeupCard: function(index, item, pet) {
    var self = this

    // 查找今日未完成的任务
    cloudApi.tasks().then(function(tasks) {
      if (!tasks || tasks.length === 0) {
        self._rollbackItem(index, item)
        return wx.showToast({ title: '今天还没有创建任务哦', icon: 'none' })
      }

      var undoneTasks = tasks.filter(function(t) {
        return !t.completed && t.goal_id
      })

      if (undoneTasks.length === 0) {
        self._rollbackItem(index, item)
        return wx.showToast({ title: '今日任务全部已完成~', icon: 'none' })
      }

      // 消耗物品
      self._consumeItem(index, item)

      // 补签第一个未完成任务
      var targetTask = undoneTasks[0]
      cloudApi.taskCheckin({ task_id: targetTask._id || targetTask.id }).then(function(res) {
        self._addGrowthLog(0, '使用了【补签卡】，补签了「' + targetTask.title + '」')
        self._showFloatingFeedback('补签成功 🎣')
        wx.showToast({ title: '补签成功！+' + (res.xp_earned || 0) + 'XP', icon: 'success' })
        setTimeout(function() { self.loadData() }, 800)
      }).catch(function(err) {
        console.error('[Pet] 补签失败:', err)
        wx.showToast({ title: '补签失败，请重试', icon: 'none' })
        self._rollbackItem(index, item)
      })
    }).catch(function(err) {
      console.error('[Pet] 获取任务列表失败:', err)
      wx.showToast({ title: '获取任务失败，请检查网络', icon: 'none' })
    })
  },

  // --- 消耗物品：本地+云端双写（V10.4）---
  _consumeItem: function(index, item) {
    var backpack = this.data.backpack.slice()
    var newCount = item.count - 1
    backpack[index] = Object.assign({}, item, { count: newCount, isEmptyClass: newCount <= 0 ? 'item-empty' : '' })
    wx.setStorageSync('pet_backpack', backpack)
    this.setData({
      backpack: backpack,
      bagEmpty: !backpack.some(function(i) { return i.count > 0 })
    })
    // 【V10.4】同步扣减云端背包（异步，不阻塞 UI）
    cloudApi.useBackpackItem(item.name).catch(function(err) {
      console.warn('[Pet] 云端物品扣减失败:', err)
    })
  },

  // --- 回滚物品：本地+云端双恢复 ---
  _rollbackItem: function(index, item) {
    var backpack = this.data.backpack.slice()
    var newCount = item.count + 1
    backpack[index] = Object.assign({}, item, { count: newCount, isEmptyClass: newCount <= 0 ? 'item-empty' : '' })
    wx.setStorageSync('pet_backpack', backpack)
    this.setData({
      backpack: backpack,
      bagEmpty: !backpack.some(function(i) { return i.count > 0 })
    })
    // 【V10.4】回滚云端（异步）
    cloudApi.useBackpackItem(item.name).then(function() {
      // useBackpackItem 是扣减操作，回滚需要加回 → 这里通过重新同步解决
      cloudApi.getBackpack().then(function(cloudBp) {
        if (cloudBp) wx.setStorageSync('pet_backpack', cloudBp)
      }).catch(function() {})
    }).catch(function(err) {
      console.warn('[Pet] 云端回滚失败:', err)
    })
  },

  // --- 写入成长记录 ---
  _addGrowthLog: function(xpChange, reason) {
    cloudApi.addGrowthLog({ xp_change: xpChange, reason: reason, source: 'item_use' }).catch(function(err) {
      console.warn('[Pet] growth_log写入失败(非致命):', err)
    })
  },

  // --- 使用道具后刷新宠物UI（V10.5：重新构建displayPets确保所有派生字段同步）---
  _refreshPetUI: function(updatedPet) {
    // 【核心】用更新后的宠物数据重新构建完整显示对象
    //   这样 _growthValueDisplay / xpPercent / app / stage 等全部派生字段都会正确刷新
    var newDp = this.buildDisplayPet(updatedPet)

    var cacheKey = updatedPet._id || updatedPet.id
    var swiperIdx = this.data.currentSwiperIndex || 0

    // 更新缓存
    if (cacheKey) {
      this._displayCache[cacheKey] = newDp
    }

    // 构建 setData 对象
    var updateData = {
      activePet: updatedPet,
      app: newDp.app,
      xpPercent: newDp.xpPercent,
      colorLayerStyle: '',
      _growthValue: newDp._growthValue,
      _growthPercent: newDp._growthPercent,
      _growthValueDisplay: newDp._growthValueDisplay,
    }
    if (newDp.app && newDp.app.rarityEffect && newDp.app.rarityEffect.colorLayer && newDp.app.rarityEffect.colorLayer.enabled) {
      updateData.colorLayerStyle = 'filter: hue-rotate(' + newDp.app.rarityEffect.colorLayer.hueRotate + 'deg) saturate(' + (1 + newDp.app.rarityEffect.colorLayer.saturate / 100) + ')'
    }

    // 【关键】同步 displayPets 轮播数组
    var displayPets = this.data.displayPets || []
    if (displayPets[swiperIdx] && displayPets[swiperIdx]._id === cacheKey) {
      displayPets[swiperIdx] = newDp
      updateData.displayPets = displayPets
    }

    console.log('[Pet][_refreshPetUI] 刷新完成 exp=', updatedPet.experience, 'gv=', updatedPet.growth_value, 'display=', newDp._growthValueDisplay)

    this.setData(updateData)
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
      cloudApi.petUpdate(pet.id, { name: newName }).then(function() {
        var updatedPet = Object.assign({}, pet, { name: newName })
        self.setData({
          activePet: updatedPet,
          showRenameModal: false,
          app: PetConst.getPetAppearance(updatedPet),
        })
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
        cloudApi.awakenPet(pet.id).then(function(result) {
          wx.hideLoading()
          if (result && result.success) {
            var updatedPet = Object.assign({}, pet, {
              awakened: true,
              name: result.new_name || pet.name,
            })
            var newApp = PetConst.getPetAppearance(updatedPet)
            var newColorStyle = ''
            if (newApp.rarityEffect && newApp.rarityEffect.colorLayer && newApp.rarityEffect.colorLayer.enabled) {
              newColorStyle = 'filter: hue-rotate(' + newApp.rarityEffect.colorLayer.hueRotate + 'deg) saturate(' + (1 + newApp.rarityEffect.colorLayer.saturate / 100) + ')'
            }
            self.setData({
              activePet: updatedPet,
              app: newApp,
              canAwaken: false,
              colorLayerStyle: newColorStyle,
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
    cloudApi.getGrowthPool().then(function(res) {
      if (res.success) {
        var poolVal = res.growth_pool || 0
        // 同步池子值到每个 displayPet
        var displayPets = self.data.displayPets || []
        if (displayPets.length > 0) {
          for (var i = 0; i < displayPets.length; i++) {
            displayPets[i]._poolValue = poolVal
          }
        }
        self.setData({
          _poolValue: poolVal,
          _poolTotalEarned: res.total_earned || 0,
          fountainPoolValue: poolVal,
          fountainTotalEarned: res.total_earned || 0,
          displayPets: displayPets,
        })
      }
      // 检查新手礼包状态
      var starterClaimed = !!(res.starter_claimed)
      if (!starterClaimed && (res.growth_pool || 0) < 100) {
        self.setData({ showStarterGift: true, starterClaimed: false })
      } else {
        self.setData({ showStarterGift: false, starterClaimed: starterClaimed })
      }
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
    var self = this
    cloudApi.setPersonality({ pet_id: pet._id || pet.id, personality_desc: desc }).then(function(res) {
      self.setData({
        showPersonalityModal: false,
        personalityInput: '',
      })
      // 更新本地宠物数据
      if (pet) {
        var updatedPet = Object.assign({}, pet, { personality_desc: desc })
        self.setData({ activePet: updatedPet })
      }
      wx.showToast({ title: '性格记录成功 ✨', icon: 'success' })
    }).catch(function() {
      wx.showToast({ title: '记录失败', icon: 'none' })
    })
  },

  // ===== 经验泉水系统 =====

  // 打开分配弹窗
  openAllocateModal: function() {
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
    this.setData({ allocateAmount: e.detail.value })
  },

  // 确认分配
  confirmAllocate: function() {
    var amountStr = this.data.allocateAmount && this.data.allocateAmount.trim()
    if (!amountStr) return wx.showToast({ title: '请输入分配数量', icon: 'none' })

    var amount = parseInt(amountStr)
    if (isNaN(amount) || amount <= 0) return wx.showToast({ title: '请输入有效数字', icon: 'none' })
    if (amount > this.data.allocateMaxPool) return wx.showToast({ title: '不能超过池子余额', icon: 'none' })

    if (!this.data.allocateTargetId) return wx.showToast({ title: '请选择目标宠物', icon: 'none' })

    var self = this
    self.setData({ showAllocateModal: false }) // 先关弹窗

    wx.showLoading({ title: '灌注中...' })

    cloudApi.allocatePool({
      pet_id: self.data.allocateTargetId,
      amount: amount,
    }).then(function(res) {
      wx.hideLoading()

      // 刷新池子和宠物数据
      self.loadGrowthPool()
      self.loadData()

      // 显示结果
      if (res.message) {
        wx.showToast({ title: res.message, icon: 'success', duration: 2000 })
      }

      // 处理孵化结果（V8.4修复：分配触发孵化时显示揭晓弹窗）
      if (res.hatched === true && res.pet) {
        // 延迟显示揭晓弹窗（等loadData刷新完UI后再展示）
        setTimeout(function() {
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
          self.setData({ showPersonalityModal: true })
        }, 2000)
      }

      // P4：跨阶段升级时需要性格期望
      if (res.need_personality_prompt) {
        var targetId = self.data.allocateTargetId || ''
        self.setData({
          showPersonalityPromptModal: true,
          promptPetId: targetId,
          promptTargetStage: (res.stage_up && res.stage_up.name) || '',
          personalityPromptText: '',
        })
      }

    }).catch(function(err) {
      wx.hideLoading()
      var msg = typeof err === 'string' ? err : (err.message || '分配失败')
      wx.showToast({ title: msg, icon: 'none' })
    })
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
    this.setData({ allocateAmount: String(this.data.allocateMaxPool) })
  },

  // 快捷投入按钮
  quickAddAmount: function(e) {
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

    // P7：完整档案 — 同样使用缓存
    var profileData = this.data.profileData
    if (!this._profileCache) this._profileCache = {}
    var pCacheKey = rawPet._id || rawPet.id
    if (!this._profileCache[pCacheKey] || dp.isEgg) {
      var SpeciesConfig = require('../../utils/speciesConfig')
      var _app = dp.app
      profileData = (function() {
        if (!rawPet.is_hatched) return null
        var sp = SpeciesConfig.getSpecies(rawPet.species)
        if (!sp) return null
        var baseInfo = {
          species_id: sp.id,
          species_name: sp.name,
          category: sp.category,
          rarity: rawPet.rarity || 'common',
          color_tier: rawPet.color_tier || 'normal',
          color_label: rawPet.color_label || '普通',
          talent: rawPet.talent || 1,
          talent_grade: rawPet.talent_grade || 'F',
          talent_name: rawPet.talent_name || '普通',
          hatch_time: rawPet.hatch_time,
          awakened: rawPet.awakened === true,
        }
        var stageInfo = PetConst.getStageInfo(rawPet.stage)
        var attrNames = { vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' }
        var attrs = (rawPet.attributes || {})
        var attrDisplay = Object.keys(attrNames).map(function(k) {
          return { key: k, name: attrNames[k], value: attrs[k] || 0 }
        })
        return {
          base: baseInfo,
          stage: stageInfo ? { key: stageInfo.key, name: stageInfo.name } : null,
          level: rawPet.level || 1,
          bond: rawPet.bond || 0,
          mood: rawPet.mood || 'normal',
          attributes: attrDisplay,
          growth_records: dp.growthRecords,
          titles: rawPet.titles || [],
          personality: rawPet.personality,
        }
      })()
      if (!dp.isEgg) this._profileCache[pCacheKey] = profileData
    } else {
      profileData = this._profileCache[pCacheKey]
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

  // ===== 新手礼包 =====

  claimStarterXp: function() {
    var self = this
    wx.showLoading({ title: '领取中...' })
    cloudApi.claimStarterXp().then(function(res) {
      wx.hideLoading()
      if (res.success) {
        self.setData({ showStarterGift: false, starterClaimed: true })
        // 刷新池子
        self.loadGrowthPool()
        wx.showToast({ title: res.message, icon: 'success', duration: 2500 })
      } else {
        if (res.already_claimed) {
          self.setData({ showStarterGift: false, starterClaimed: true })
        }
        wx.showToast({ title: res.message || '领取失败', icon: 'none' })
      }
    }).catch(function(err) {
      wx.hideLoading()
      wx.showToast({ title: typeof err === 'string' ? err : '领取失败', icon: 'none' })
    })
  },

  // ===== V10.4：儿童节礼包（每人一次，各20个道具）=====
  claimChildrenDayGift: function() {
    var self = this
    wx.showLoading({ title: '领取中...' })
    cloudApi.claimChildrenDayGift().then(function(res) {
      wx.hideLoading()
      if (res.success) {
        self.setData({ showChildrenDayGift: false })
        // 刷新背包（从云端重新拉取）
        cloudApi.getBackpack().then(function(cloudBp) {
          var finalBackpack = self._mergeBackpack(cloudBp)
          self.setData({
            backpack: finalBackpack,
            bagEmpty: !finalBackpack.some(function(i) { return i.count > 0 }),
          })
        }).catch(function() {})
        wx.showToast({ title: res.message, icon: 'success', duration: 3000 })
      } else {
        if (res.already_claimed) {
          self.setData({ showChildrenDayGift: false })
        }
        wx.showToast({ title: res.message || '领取失败', icon: 'none' })
      }
    }).catch(function(err) {
      wx.hideLoading()
      console.error('[Pet] 儿童节礼包领取失败:', err)
      wx.showToast({ title: '网络错误，请重试', icon: 'none' })
    })
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
