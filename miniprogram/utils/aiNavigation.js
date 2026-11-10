// Tab pages cannot receive navigateTo query parameters. Keep one account-scoped,
// in-memory handoff; never send a message or start a model call automatically.
const { accountScope } = require('./userSession')
let pending = null
let pendingSteward = null
let pendingGoal = null
let pendingPet = null
function createNavigation(wx, getApp) {
  const scope = () => accountScope(getApp().globalData)
  function openPlanner(prompt) {
    return openPartner('plan', { prompt })
  }
  function openPartner(mode, options) {
    if (!['plan', 'review', 'coach', 'chat'].includes(mode)) return false
    options = options || {}
    const id = scope()
    if (!id) {
      wx.showToast({ title: '请先登录再使用 AI 伙伴', icon: 'none' })
      return false
    }
    const intent = { scope: id, mode, prompt: String(options.prompt || '').trim().slice(0, 1200), goalId: String(options.goalId || ''),
      ...(options.refreshDraft === true ? { refreshDraft: true } : {}) }
    if (options.stewardRunId) {
      intent.stewardRunId = options.stewardRunId
      intent.steward = options.steward || null
    }
    if (mode === 'coach' && typeof options.date === 'string') intent.date = options.date.slice(0, 10)
    if (mode === 'chat') {
      if (!options.petId) return false
      intent.petId = String(options.petId)
    }
    pending = intent
    wx.switchTab({
      url: '/pages/ai/ai',
      success(result) {
        if (id === scope() && typeof options.onOpen === 'function') options.onOpen(result)
      },
      fail() {
        if (pending !== intent) return
        pending = null
        if (id === scope()) wx.showToast({ title: '暂时无法打开 AI 伙伴，请重试', icon: 'none' })
      }
    })
    return true
  }
  function takePlannerIntent() {
    const intent = pending
    pending = null
    return intent && intent.scope === scope() ? intent : null
  }
  function openSteward(options) {
    const id = scope()
    if (!id || !options || !options.goalId) return false
    const intent = { scope: id, goalId: String(options.goalId), date: String(options.date || '') }
    if (options.suggestion) intent.suggestion = options.suggestion
    pendingSteward = intent
    wx.navigateTo({ url: '/pages/forest-steward/forest-steward', fail() {
      if (pendingSteward !== intent) return
      pendingSteward = null
      if (id === scope()) wx.showToast({ title: '管家暂时无法打开，请重试', icon: 'none' })
    } })
    return true
  }
  function takeStewardIntent() {
    const intent = pendingSteward; pendingSteward = null
    return intent && intent.scope === scope() ? intent : null
  }
  function openNewGoal(title) {
    const id = scope()
    if (!id) {
      wx.showToast({ title: '请先登录再新建目标', icon: 'none' })
      return
    }
    const intent = { scope: id, title }
    pendingGoal = intent
    wx.switchTab({ url: '/pages/goals/goals', fail() {
      if (pendingGoal !== intent) return
      pendingGoal = null
      if (id === scope()) wx.showToast({ title: '暂时无法打开目标页', icon: 'none' })
    } })
  }
  function takeNewGoalTitle() {
    const intent = pendingGoal
    pendingGoal = null
    return intent && intent.scope === scope() ? intent.title : ''
  }
  function openPet(petId) {
    const id = scope()
    if (!id || typeof petId !== 'string' || !petId) return false
    const intent = { scope: id, petId }
    pendingPet = intent
    wx.switchTab({ url: '/pages/pets/pets', fail() {
      if (pendingPet !== intent) return
      pendingPet = null
      if (id === scope()) wx.showToast({ title: '暂时无法打开森林，请重试', icon: 'none' })
    } })
    return true
  }
  function takePetIntent() {
    const intent = pendingPet
    pendingPet = null
    return intent && intent.scope === scope() ? intent : null
  }
  return { openPlanner, openPartner, openSteward, takeStewardIntent, takePartnerIntent: takePlannerIntent, takePlannerIntent,
    openNewGoal, takeNewGoalTitle, openPet, takePetIntent }
}
module.exports = { createNavigation }
