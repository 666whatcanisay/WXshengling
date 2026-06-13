const cloudApi = require("../../utils/cloudApi");

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
  data: {
    greeting: "", user: {},
    activePet: null, petEmoji: "", petTalk: "", petStatusClass: "normal", petStatusText: "",
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
      const petEmoji = activePet ? ({ egg: "🧬", baby: "🐾", adult: "🦁" }[activePet.stage] || "🧬") : "🧬"
      const petTalks = { happy: ["主人今天也一起成长吧～"], normal: ["等主人回来呢～"], sad: ["主人最近忙忙的…"] }
      const petTalk = activePet ? (petTalks[activePet.status] || petTalks.normal)[0] : "快领养一只宠物吧～"

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
        petStatusClass: activePet?.status || "normal",
        petStatusText: { happy: "很开心", normal: "平静", sad: "有点悲伤" }[activePet?.status] || "平静",
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
    } catch (err) {
      console.error('[Home] 加载首页数据失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请下拉刷新', icon: 'none' })
    }
  },

  // ===== 新手引导 =====
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
      const tasks = this.data.todayTasks.map(t =>
        t.id === taskId ? { ...t, completed: true } : t
      )
      const completedCount = tasks.filter(t => t.completed).length
      const totalCount = tasks.length
      const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
      const addedXp = res.xp_earned || task.xp_reward || 10

      this.setData({
        todayTasks: tasks,
        todayGrowth: { ...this.data.todayGrowth, completedTasks: completedCount, completionRate, xp: (this.data.todayGrowth.xp || 0) + addedXp },
      })
      wx.showToast({ title: `打卡成功 +${addedXp}XP ⭐`, icon: 'success' })
      log('打卡', '打卡成功', { taskId, xp: addedXp })
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
