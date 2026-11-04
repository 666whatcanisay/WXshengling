const cloudApi = require("../../utils/cloudApi");
const PetConst = require('../../utils/petConstants')

function getGreeting() {
  const h = new Date().getHours()
  if (h < 6) return "凌晨好"
  if (h < 9) return "早上好"
  if (h < 12) return "上午好"
  if (h < 14) return "中午好"
  if (h < 18) return "下午好"
  if (h < 22) return "晚上好"
  return "夜深了"
}

function generateEncouragement(streakDays, completionRate, totalXp) {
  const templates = [
    { text: `🔥 今天已经坚持${streakDays}天啦，再坚持3天宠物就会进化！`, icon: "🔥" },
    { text: `💪 今日完成率${completionRate}%，比昨天进步了！`, icon: "💪" },
    { text: `🌟 累计获得${totalXp}XP，距离下一等级不远了！`, icon: "🌟" },
    { text: `🎯 本周目标完成率${completionRate}%，非常棒！`, icon: "🎯" },
    { text: `🌈 坚持就是胜利，你正在变得更好！`, icon: "🌈" },
  ]
  return templates[Math.floor(Math.random() * templates.length)]
}

function log(tag, msg, data) {
  const t = new Date().toISOString().slice(11, 23)
  if (data) { console.log(`[Home][${t}] ${tag}: ${msg}`, JSON.stringify(data)) }
  else { console.log(`[Home][${t}] ${tag}: ${msg}`) }
}

Page({
  // ===== 缓存：避免重复 buildDisplayPet =====
  _displayCache: {},

  data: {
    greeting: "", user: {},
    activePet: null, petEmoji: "", petTalk: "", petStatusClass: "normal", petStatusText: "",
    isEgg: false,
    todayGrowth: { xp: 0, completedTasks: 0, totalTasks: 0, streakDays: 0, completionRate: 0 },
    goals: [],
    signedIn: false, signInDays: 0,
    encouragement: null,
    todayTasks: [],
    achievements: [],
    moods: ["😊 开心", "😐 平静", "😔 低落", "😤 焦虑"],
    selectedMood: -1, moodSubmitted: false, moodRecorded: "",
    showTutorial: false, tutorialStep: 0,
    loading: true,
    // 轮播
    displayPets: [],
    homeSwiperIndex: 0,
    tutorialSteps: [
      { title: "欢迎来到AI成长伙伴", desc: "这是一个陪伴你成长、养成好习惯的智能助手", icon: "👋" },
      { title: "创建第一个目标", desc: "设定你的成长目标，AI会帮你生成每日任务", icon: "🎯" },
      { title: "领养宠物伙伴", desc: "完成任务获取经验，让你的宠物一起成长", icon: "🐾" },
      { title: "开始成长之旅", desc: "完成新手任务，获得100XP奖励！", icon: "🚀" },
    ],
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 【安全修复】离线模式不加载云端数据，避免串号
    var app = getApp()
    if (app.isOfflineMode) {
      console.warn('[Home] 离线模式，跳过云端数据加载')
      this.setData({ loading: false })
      return
    }
    this.loadDashboard()
  },

  async loadDashboard() {
    this.setData({ loading: true })
    try {
      const app = getApp()
      const greeting = getGreeting()

      // 从云端加载仪表盘数据
      const dash = await cloudApi.dashboard()

      const activePet = dash.activePet || null
      // 使用 PetConst 统一映射，支持蛋状态
      let petEmoji, petTalk, isEgg = false
      if (activePet) {
        if (activePet.is_hatched === false) {
          isEgg = true
          // 【V8.4修复】使用实际蛋类型emoji，与森林页保持一致（防御性编码）
          var _eggEmoji = '🥚', _eggName = '神秘蛋'
          try {
            var _eggInfo = PetConst.getEggTypeDisplay(activePet.egg_type)
            if (_eggInfo) {
              _eggEmoji = _eggInfo.emoji || '🥚'
              _eggName = _eggInfo.name || '神秘蛋'
            }
          } catch(e) {
            console.warn('[Home] getEggTypeDisplay 异常:', e.message)
          }
          petEmoji = _eggEmoji
          var gv = activePet.growth_value || 0
          var hatchPct = Math.min(100, gv)
          petTalk = _eggEmoji + ' ' + _eggName + ' · 成长值 ' + gv + '/100 · 孵化中 ' + hatchPct + '%'
        } else {
          const spInfo = PetConst.getSpeciesInfo(activePet.species)
          petEmoji = spInfo.icon
          // 【V8.5修复】统一使用森林同款 getMoodDisplay 心情体系
          const moodDisp = PetConst.getMoodDisplay(activePet.mood || 'normal')
          petTalk = moodDisp.bubble
        }
      } else {
        petEmoji = '🥚'
        petTalk = '快创建目标获得神秘蛋吧～'
      }

      const encouragement = generateEncouragement(
        dash.user?.streak_days || 0,
        dash.todayGrowth?.completionRate || 0,
        dash.user?.total_xp || 0
      )

      const showTutorial = !wx.getStorageSync('tutorial_done')

      this.setData({
        greeting, loading: false,
        user: dash.user || {},
        activePet,
        petEmoji, petTalk,
        petStatusClass: activePet ? (activePet.status || "normal") : "normal",
        petStatusText: activePet && !activePet.is_hatched ? '孵化中' : (activePet ? (function() {
          var md = PetConst.getMoodDisplay(activePet.mood || 'normal')
          return md.name + ' ' + md.emoji
        })() : ''),
        isEgg,
        todayGrowth: dash.todayGrowth || { xp: 0, completedTasks: 0, totalTasks: 0, streakDays: 0, completionRate: 0 },
        goals: dash.goals || [],
        signedIn: dash.signedIn || false,
        signInDays: dash.user?.streak_days || 0,
        todayTasks: dash.todayTasks || [],
        achievements: dash.achievements || [],
        encouragement,
        showTutorial,
      })

      // 缓存用户信息
      app.globalData.userInfo = dash.user || app.globalData.userInfo

      // 异步加载所有宠物（轮播图用，不阻塞页面渲染）
      this._loadAllPetsForCarousel()
    } catch (err) {
      console.error('[Home] 加载首页数据失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请下拉刷新', icon: 'none' })
    }
  },

  // ===== 首页宠物轮播 =====

  /** 异步加载所有宠物，构建轮播展示数据 */
  _loadAllPetsForCarousel: function() {
    var self = this
    cloudApi.pets().then(function(petsRaw) {
      var petsList = Array.isArray(petsRaw) ? petsRaw : (petsRaw && petsRaw.data ? petsRaw.data : [])
      if (!petsList || petsList.length === 0) return

      var displayPets = []
      for (var i = 0; i < petsList.length; i++) {
        var dp = self._buildHomeDisplayPet(petsList[i])
        displayPets.push(dp)
      }

      self.setData({ displayPets: displayPets })
    }).catch(function() {
      // 加载失败不影响主页核心功能
    })
  },

  /** 构建首页轻量级宠物显示对象（比森林 buildDisplayPet 轻量） */
  _buildHomeDisplayPet: function(pet) {
    var cacheKey = pet._id || pet.id
    if (this._displayCache[cacheKey]) return this._displayCache[cacheKey]

    var isEgg = !(pet.is_hatched === true)
    var dp = {
      _id: cacheKey,
      isEgg: isEgg,
      name: pet.name || '未命名',
      growth_value: pet.growth_value || 0,
      growthPercent: 0,
      species: pet.species || '',
    }

    if (isEgg) {
      var eggInfo = PetConst.getEggTypeDisplay(pet.egg_type)
      dp.emoji = eggInfo ? eggInfo.emoji : '🥚'
      dp.eggName = eggInfo ? eggInfo.name : '神秘蛋'
      dp.eggColor = eggInfo ? eggInfo.color : '#7CB342'
      dp.talk = dp.emoji + ' ' + dp.eggName + ' · 成长值 ' + dp.growth_value + '/100'
      dp.statusText = '孵化中'
      dp.growthPercent = Math.min(100, dp.growth_value)
      dp.rarityColor = eggInfo ? eggInfo.color : '#7CB342'
    } else {
      var spInfo = PetConst.getSpeciesInfo(pet.species)
      dp.emoji = spInfo.icon || '🐾'
      dp.speciesName = spInfo.name || ''
      var moodDisp = PetConst.getMoodDisplay(pet.mood || 'normal')
      dp.talk = moodDisp.bubble || ''
      dp.statusText = moodDisp.name + ' ' + moodDisp.emoji
      var SpeciesConfig = require('../../utils/speciesConfig')
      var stageInfo = SpeciesConfig.getStageByGrowth(dp.growth_value)
      var nextStage = SpeciesConfig.getNextStage(dp.growth_value)
      var stagePct = SpeciesConfig.getStageProgress(dp.growth_value)
      dp.stageProgress = {
        currentStage: stageInfo ? stageInfo.name : '',
        nextStage: nextStage ? nextStage.name : '',
        percent: stagePct || 0,
        growthValue: dp.growth_value,
        growthNeeded: 0
      }
      // 【V8.6修复】使用外观引擎获取稀有度（与森林 buildDisplayPet 保持同一个数据源）
      // 之前使用 PetConst.RARITY 间接取 petRarity.js，链路不同可能导致不一致
      var petApp = PetConst.getPetAppearance(pet)
      var re = petApp && petApp.rarityEffect ? petApp.rarityEffect : {}
      dp.rarityColor = re.color || '#95A5A6'
      dp.rarityName = re.name || pet.rarity || '普通'
      console.log('[HomeRarity] pet=' + cacheKey + ' rarity=' + pet.rarity + ' color=' + dp.rarityColor + ' name=' + dp.rarityName)
      dp.level = pet.level || 1
    }

    this._displayCache[cacheKey] = dp
    return dp
  },

  /** 切换轮播宠物 */
  switchHomePet: function(e) {
    var idx = e.currentTarget.dataset.index
    var dp = this.data.displayPets[idx]
    if (!dp) return

    var activePet = this.data.activePet
    // 尽量保持 activePet 引用（用于签到/打卡的成长值联动），只在名字等基础信息上做更新
    this.setData({
      homeSwiperIndex: idx,
      petEmoji: dp.emoji,
      petTalk: dp.talk,
      petStatusText: dp.statusText,
      isEgg: dp.isEgg,
      petStatusClass: dp.isEgg ? 'normal' : 'normal',
    })
  },

  /** 手滑切换轮播宠物 */
  onHomeSwiperChange: function(e) {
    var idx = e.detail.current
    this.setData({ homeSwiperIndex: idx })
    // 同步更新底部展示信息
    var dp = this.data.displayPets[idx]
    if (dp) {
      this.setData({
        petEmoji: dp.emoji,
        petTalk: dp.talk,
        petStatusText: dp.statusText,
        isEgg: dp.isEgg,
        petStatusClass: dp.isEgg ? 'normal' : 'normal',
      })
    }
  },
  nextTutorialStep() {
    const step = this.data.tutorialStep + 1
    if (step >= this.data.tutorialSteps.length) { this.finishTutorial() }
    else { this.setData({ tutorialStep: step }) }
  },
  skipTutorial() { this.finishTutorial() },
  finishTutorial() {
    wx.setStorageSync('tutorial_done', true)
    this.setData({ showTutorial: false })
    wx.showToast({ title: '新手任务完成 +100XP', icon: 'success' })
  },

  // ===== 每日签到 =====
  async dailySignIn() {
    if (this.data.signedIn) {
      return wx.showToast({ title: '今天已签到', icon: 'none' })
    }
    try {
      const res = await cloudApi.dailyCheckin()
      if (res.already_signed) {
        this.setData({ signedIn: true })
        return wx.showToast({ title: '今天已签到', icon: 'none' })
      }
      const newDays = this.data.signInDays + 1
      const addedXp = res.xp_earned || 10
      // 签到增加成长值（V6：source=checkin, +10）
      try { await cloudApi.hatchProgress({ source: 'checkin' }) } catch(e) { /* 无蛋时忽略 */ }
      this.setData({
        signedIn: true,
        signInDays: newDays,
        todayGrowth: { ...this.data.todayGrowth, xp: (this.data.todayGrowth.xp || 0) + addedXp },
      })
      wx.showToast({ title: `签到成功 +${addedXp}XP 🎁`, icon: 'success' })
      log('签到', '签到成功', { days: newDays, xp: addedXp })
    } catch (err) {
      wx.showToast({ title: '签到失败', icon: 'error' })
    }
  },

  // ===== 心情记录 =====
  async selectMood(e) {
    const idx = Number(e.currentTarget.dataset.mood)
    const emoji = this.data.moods[idx]
    try {
      await cloudApi.emotions({ mood_index: idx, mood_label: emoji })
      this.setData({ selectedMood: idx, moodSubmitted: true, moodRecorded: emoji })
      wx.showToast({ title: '心情已记录 ✿', icon: 'success' })
      log('心情', '选择心情', { index: idx, emoji })
    } catch (err) {
      wx.showToast({ title: '记录失败', icon: 'error' })
    }
  },

  // ===== 快速打卡 =====
  async quickCheckin(e) {
    const taskId = e.currentTarget.dataset.id
    const task = this.data.todayTasks.find(t => t.id === taskId)
    if (!task) return
    if (task.completed) return wx.showToast({ title: '该任务已完成', icon: 'none' })

    try {
      const res = await cloudApi.taskCheckin({ task_id: taskId })
      // 仅首次成功结算才触发宠物成长，避免重复/已完成场景又写一次
      if (!res.already_completed) {
        try { await cloudApi.hatchProgress({ source: 'complete_goal' }) } catch(e) { /* 无蛋时忽略 */ }
      }

      const tasks = this.data.todayTasks.map(t =>
        t.id === taskId ? { ...t, completed: true } : t
      )
      const completedCount = tasks.filter(t => t.completed).length
      const totalCount = tasks.length
      const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
      // 仅用后端真实返回值；already_completed 时 xp_earned=0，不再假装拿了 task.xp_reward
      const addedXp = res.already_completed ? 0 : (res.xp_earned || 0)

      this.setData({
        todayTasks: tasks,
        todayGrowth: { ...this.data.todayGrowth, completedTasks: completedCount, completionRate, xp: (this.data.todayGrowth.xp || 0) + addedXp },
      })
      wx.showToast({ title: res.already_completed ? '任务已完成' : ('打卡成功 +' + addedXp + 'XP ⭐'), icon: 'success' })
      log('打卡', res.already_completed ? '重复打卡（后端已结算）' : '打卡成功', { taskId, xp: addedXp })
    } catch (err) {
      wx.showToast({ title: '打卡失败', icon: 'error' })
    }
  },

  // ===== 导航 =====
  goGoals() { wx.switchTab({ url: "/pages/goals/goals" }) },
  goPets() { wx.switchTab({ url: "/pages/pets/pets" }) },
  goMine() { wx.switchTab({ url: "/pages/mine/mine" }) },
  goAchievements() { wx.navigateTo({ url: "/pages/achievements/achievements" }) },
  goGrowthReport() { wx.navigateTo({ url: "/pages/growth-report/growth-report" }) },

  // ===== 下拉刷新 =====
  onPullDownRefresh() {
    this.loadDashboard().then(() => wx.stopPullDownRefresh())
  },
})
