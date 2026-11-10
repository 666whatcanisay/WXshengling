const cloudApi = require('../../utils/cloudApi')
const schedule = require('../../utils/planSchedule')
const { accountScope } = require('../../utils/userSession')
const navigation = require('../../utils/aiNavigation').createNavigation(wx, getApp)
const stewardWorkspace = require('../../utils/stewardWorkspace').createWorkspace({ cloudApi, getApp, navigation })
const adjustmentWorkspace = require('../../utils/adjustmentWorkspace').createWorkspace({ wx, cloudApi, getApp })

const PREFIX = 'forest_steward_workspace_v2:'
const CLOSED_SECTIONS = { guide: false, run: false, today: false, review: false, coach: false }
const STATUS = { active: '进行中', doing: '进行中', todo: '待开始', done: '已完成', abandoned: '已放弃' }
function rows(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  throw new Error('数据格式不正确，请稍后重试')
}

Page({
  data: {
    ...stewardWorkspace.data,
    ...adjustmentWorkspace.data,
    today: '', loading: false, taskLoading: false, error: '', taskError: '',
    goals: [], currentGoal: null, tasks: [], completed: 0, pending: 0,
    goalPickerOpen: false, teamExpanded: false, resultTab: 'today',
    stewardSections: CLOSED_SECTIONS,
    demand: '', storageWarning: '', loadedAt: '', loggedIn: false,
    coachSummary: null, coachSummaryLoading: false, coachSummaryError: '', coachSummaryDate: '',
    roles: [
      { key: 'manager', icon: '🌲', name: '森林管家', duty: '根据需求与草案，组织规划和审核', state: '有界流程协调', available: true },
      { key: 'planner', icon: '📋', name: 'AI 规划师', duty: '聊清需求，生成可编辑的任务计划', state: '可独立使用', available: true },
      { key: 'critic', icon: '🔍', name: 'AI 审核师', duty: '依据明确要求，检查同一版计划草案', state: '规则检查 · 按需语义建议', available: true },
      { key: 'analyst', icon: '🏆', name: 'AI 教练', duty: '结合真实执行与主动反馈提出建议', state: '近7天事实 · 反馈 · 主动复盘', available: true },
      { key: 'pet', icon: '🐾', name: '宠物伙伴', duty: '独立陪伴；后续共享必要的成长线索', state: '现有聊天保留 · 联动待接入', available: false }
    ]
  },

  onShow() {
    this._closed = false
    const id = accountScope(getApp().globalData)
    if (id !== this._workspaceScope) {
      this._workspaceScope = id
      this._selectedId = ''
      this._coachEntry = null
      this._pendingCoachSuggestion = null
      this._coachSummaryEpoch = (this._coachSummaryEpoch || 0) + 1
      this.setData({ demand: '', currentGoal: null, tasks: [], goals: [], completed: 0, pending: 0, storageWarning: '', resultTab: 'today',
        coachSummary: null, coachSummaryLoading: false, coachSummaryError: '', coachSummaryDate: schedule.today(), stewardSections: CLOSED_SECTIONS })
      if (id) {
        try {
          const saved = wx.getStorageSync(PREFIX + id)
          if (saved && saved.version === 2) {
            this._selectedId = typeof saved.goalId === 'string' ? saved.goalId : ''
            this.setData({ demand: typeof saved.demand === 'string' ? saved.demand.slice(0, 1200) : '' })
          }
        } catch (e) { this.setData({ storageWarning: '本机工作区读取失败，可继续使用。' }) }
      }
    }
    const coachEntry = navigation.takeStewardIntent()
    if (coachEntry) {
      this._coachEntry = coachEntry
      this._pendingCoachSuggestion = null
    }
    this.setData({ loggedIn: !!id, today: schedule.today(), coachSummaryDate: schedule.validDate(this.data.coachSummaryDate) && this.data.coachSummaryDate <= schedule.today() ? this.data.coachSummaryDate : schedule.today() })
    this.refreshSteward()
    return this.reload()
  },
  onHide() {
    this._closed = true
    this._loadId = (this._loadId || 0) + 1
    this._coachSummaryEpoch = (this._coachSummaryEpoch || 0) + 1
    this.pauseSteward(); this.pauseAdjustment(); this.saveWorkspace()
    this.setData({ loading: false, taskLoading: false, coachSummaryLoading: false })
  },
  onUnload() { this.onHide() },
  ...stewardWorkspace.methods,
  ...adjustmentWorkspace.methods,
  onPullDownRefresh() { return this.reload().finally(() => wx.stopPullDownRefresh()) },

  ownsWorkspace() {
    return !!this._workspaceScope && this._workspaceScope === accountScope(getApp().globalData)
  },
  saveWorkspace() {
    if (!this.ownsWorkspace()) return
    try {
      wx.setStorageSync(PREFIX + this._workspaceScope, { version: 2, goalId: this._selectedId || '', demand: this.data.demand })
      this.setData({ storageWarning: '' })
    } catch (e) { this.setData({ storageWarning: '本机保存失败，离开前请自行保留需求文字。' }) }
  },

  async reload() {
    const loadId = this._loadId = (this._loadId || 0) + 1
    this._coachSummaryEpoch = (this._coachSummaryEpoch || 0) + 1
    this.setData({ loading: false, taskLoading: false, error: '', taskError: '', tasks: [], completed: 0, pending: 0, loadedAt: '', goalPickerOpen: false, today: schedule.today(), coachSummary: null, coachSummaryLoading: false, coachSummaryError: '' })
    if (!this.ownsWorkspace()) {
      this.setData({ goals: [], currentGoal: null, error: '请先登录，再读取你的目标与任务。' })
      return
    }
    this.setData({ loading: true })
    this.refreshAdjustmentFlow()
    try {
      const list = rows(await cloudApi.goals()).filter(g => g && g.status !== 'deleted').map(g => ({
        id: String(g._id || g.id || ''), title: g.title || '未命名目标',
        status: g.status || 'active', statusLabel: STATUS[g.status || 'active'] || '状态未知'
      })).filter(g => g.id)
      if (this._closed || !this.ownsWorkspace() || loadId !== this._loadId) return
      const entry = this._coachEntry
      const entryGoal = entry && entry.scope === this._workspaceScope && list.find(g => g.id === entry.goalId)
      this._coachEntry = null
      const goal = entry ? entryGoal || null : list.find(g => g.id === this._selectedId) || null
      if (entryGoal) this.setData({ resultTab: 'summary', coachSummaryDate: schedule.validDate(entry.date) && entry.date <= schedule.today() ? entry.date : schedule.today() })
      if (entryGoal && entry.suggestion) this._pendingCoachSuggestion = { scope: entry.scope, goalId: entry.goalId, date: entry.date, reference: entry.suggestion }
      this._selectedId = goal ? goal.id : ''
      this.setData({ goals: list, currentGoal: goal, loading: false })
      this.refreshAdjustmentFlow()
      this.saveWorkspace()
      if (entry && !entryGoal) this.setData({ storageWarning: '本次复盘对应的目标不在当前账号目标列表中，请重新选择；未切换到其他目标的复盘。' })
      if (goal) await Promise.all([this.loadTasks(loadId, goal.id), this.loadStewardCoach(goal.id)])
    } catch (e) {
      if (this._closed || !this.ownsWorkspace() || loadId !== this._loadId) return
      this.setData({ goals: [], currentGoal: null, loading: false, error: '目标暂时读取失败，请重试；这不表示你的目标已删除。' })
      this.refreshAdjustmentFlow()
    }
  },

  async loadTasks(loadId, goalId) {
    if (!this.ownsWorkspace()) return
    const date = schedule.today()
    this.setData({ taskLoading: true, taskError: '', tasks: [], completed: 0, pending: 0, loadedAt: '', today: date })
    try {
      const tasks = rows(await cloudApi.tasks({ date, goal_id: goalId })).filter(t => t && String(t.goal_id) === goalId && t.date === date)
        .map(t => ({ id: String(t.id || t._id || ''), title: t.title || '未命名任务', completed: t.completed === true,
          minutesLabel: Number.isFinite(t.estimated_minutes) && t.estimated_minutes > 0 ? '预计 ' + t.estimated_minutes + ' 分钟' : '未设置预计时长' }))
      if (this._closed || !this.ownsWorkspace() || loadId !== this._loadId) return
      const completed = tasks.filter(t => t.completed).length
      this.setData({ tasks, completed, pending: tasks.length - completed, taskLoading: false, loadedAt: '刚刚更新 · ' + date })
    } catch (e) {
      if (this._closed || !this.ownsWorkspace() || loadId !== this._loadId) return
      this.setData({ taskLoading: false, taskError: '今日任务暂时读取失败，不能据此判断完成情况。' })
    }
  },
  retryTasks() {
    if (!this.data.currentGoal) return
    const id = this._loadId = (this._loadId || 0) + 1
    return this.loadTasks(id, this.data.currentGoal.id)
  },
  toggleGoals() { this._goalPickerReturnTab = ''; if (!this.data.loading && !this.data.error) this.setData({ goalPickerOpen: !this.data.goalPickerOpen }) },
  closeGoals() { this._goalPickerReturnTab = ''; this.setData({ goalPickerOpen: false }) },
  selectGoal(e) {
    if (!this.ownsWorkspace() || this.data.loading) return
    if (this.data.adjustmentDirty && !this.cacheAdjustment()) return
    const goal = this.data.goals.find(g => g.id === e.currentTarget.dataset.id)
    if (!goal) return
    this._pendingCoachSuggestion = null
    this._selectedId = goal.id
    const tab = this._goalPickerReturnTab || 'today'
    this._goalPickerReturnTab = ''
    this.setData({ currentGoal: goal, goalPickerOpen: false, resultTab: tab, coachSummaryDate: schedule.today(),
      stewardSections: { ...this.data.stewardSections, today: false, coach: false } })
    this.refreshAdjustmentFlow()
    this.saveWorkspace()
    const id = this._loadId = (this._loadId || 0) + 1
    return Promise.all([this.loadTasks(id, goal.id), this.loadStewardCoach(goal.id)])
  },
  toggleTeam() { this.setData({ teamExpanded: !this.data.teamExpanded }) },
  toggleStewardSection(e) {
    const section = e.currentTarget.dataset.section
    this.setData({ stewardSections: { ...this.data.stewardSections, [section]: !this.data.stewardSections[section] } })
  },
  setResultTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (['today', 'review', 'summary'].includes(tab)) this.setData({ resultTab: tab })
    if (tab === 'summary' && this.data.currentGoal) return this.loadStewardCoach(this.data.currentGoal.id)
  },
  async loadStewardCoach(goalId) {
    if (typeof cloudApi.getCoachWorkspace !== 'function' || !goalId || !this.ownsWorkspace()) return
    const date = this.data.coachSummaryDate || schedule.today(), epoch = this._coachSummaryEpoch = (this._coachSummaryEpoch || 0) + 1
    this.setData({ coachSummary: null, coachSummaryLoading: true, coachSummaryError: '' })
    const valid = () => !this._closed && this.ownsWorkspace() && epoch === this._coachSummaryEpoch &&
      this.data.currentGoal?.id === goalId && date === this.data.coachSummaryDate
    try {
      const result = await cloudApi.getCoachWorkspace({ goal_id: goalId, date })
      if (valid()) this.setData({ coachSummary: result })
    } catch (error) {
      if (valid()) this.setData({ coachSummaryError: '近7天记录与复盘读取失败，请重试；暂不判断执行情况。' })
    } finally { if (valid()) { this.setData({ coachSummaryLoading: false }); if (this.data.resultTab === 'summary') await this.loadAdjustment() } }
  },
  refreshStewardCoach() { if (this.data.currentGoal) return this.loadStewardCoach(this.data.currentGoal.id) },
  useStewardCoachSuggestion(e) {
    const report = this.data.coachSummary?.report, index = Number(e.currentTarget.dataset.index)
    if (report?.status === 'done' && Number.isInteger(index) && report.result?.suggestions?.[index]) {
      return this.selectAdjustmentSuggestion({ report_id: report.id, fingerprint: report.fingerprint, index })
    }
  },
  onDemandInput(e) { if (this.ownsWorkspace()) this.setData({ demand: e.detail.value.slice(0, 1200) }) },
  onDemandBlur() { this.saveWorkspace() },
  clearDemand() { if (this.ownsWorkspace()) { this.setData({ demand: '' }); this.saveWorkspace() } },
  openPlanner() {
    if (!this.ownsWorkspace()) return false
    this.saveWorkspace()
    return navigation.openPlanner(this.data.demand)
  },
  openReview() { return navigation.openPartner('review') },
  openCoach() {
    if (!this.ownsWorkspace()) return false
    return navigation.openPartner('coach', { goalId: this.data.currentGoal ? this.data.currentGoal.id : '', date: this.data.coachSummaryDate || schedule.today() })
  },
  viewGoal() {
    const goal = this.data.currentGoal
    if (goal && this.ownsWorkspace()) wx.navigateTo({ url: '/pages/goal-detail/goal-detail?id=' + encodeURIComponent(goal.id) })
  },
  openStewardPublishedGoal() {
    const goalId = this.data.stewardRun?.publication_receipt?.goal_id
    if (goalId && this.ownsWorkspace()) wx.navigateTo({ url: '/pages/goal-detail/goal-detail?id=' + encodeURIComponent(goalId) })
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/login' }) }
})
