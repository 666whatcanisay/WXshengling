const cloudApi = require("../../utils/cloudApi");
const schedule = require('../../utils/planSchedule');
const { accountScope } = require('../../utils/userSession');
const isClosed = status => ['done', 'abandoned', 'deleted'].includes(status)
const TASK_CREATION_PREFIX = 'manual_task_creation_v1:'

Page({
  data: {
    goal: null, goalClosed: false, tasks: [], filteredTasks: [], completedTaskCount: 0,
    result: null, showAdd: false, submittingTask: false, closingGoal: false, taskTitle: "", taskXp: 10,
    taskCreationPending: false, taskCreationStorageError: '', taskCreationDate: '',
    today: "", selectedDate: "", filter: "all", sortBy: "date", loading: false, loadError: false, goalId: null,
    focusedTask: '', taskAnchor: '', focusMissing: false, accountChanged: false,
  },

  onLoad(e) {
    const ds = schedule.today()
    const goalId = e.id || null
    const date = schedule.validDate(e.date) && e.date <= ds ? e.date : ds
    this.setData({ today: ds, selectedDate: date, goalId, focusedTask: typeof e.task === 'string' && date === e.date ? e.task : '' })
    if (goalId && this.ownsDetailSession(this.detailSession())) this.readTaskCreation()
    return this.loadGoalDetail(goalId)
  },

  detailSession() {
    if (this._detailSession === undefined) {
      const { globalData } = getApp()
      this._detailScope = accountScope(globalData)
      this._detailSession = this._detailScope ? globalData.userInfo : null
    }
    return this._detailSession
  },

  ownsDetailSession(session) {
    const { globalData } = getApp()
    return !!session && this._detailSession === session && globalData.userInfo === session && this._detailScope === accountScope(globalData)
  },

  async loadGoalDetail(id) {
    const session = this.detailSession()
    if (!id || !this.ownsDetailSession(session)) return
    const selectedDate = this.data.selectedDate || schedule.today()
    const loadId = (this._loadId || 0) + 1
    this._loadId = loadId
    const current = () => loadId === this._loadId && this.ownsDetailSession(session)
    this.setData({ loading: true, loadError: false })
    try {
      // 【V8.5修复】callCloud 已自动解包 .data，res 直接是目标对象
      const res = await cloudApi.goalDetail(id)
      if (!current()) return
      const goalData = res
      if (!goalData) throw new Error('目标不存在')
      const taskRes = await cloudApi.tasks({ date: selectedDate, goal_id: id })
      if (!current()) return
      const rawTasks = Array.isArray(taskRes) ? taskRes : (taskRes.data || [])
      const taskList = rawTasks.filter(t => t.goal_id === id)

      const completed = taskList.filter(t => t.completed).length
      this.setData({
        goal: {
          id: goalData._id, title: goalData.title, description: goalData.description || "",
          target_days: goalData.target_days || goalData.target_value || 30, status: goalData.status || "active",
          statusLabel: this.statusText(goalData.status || 'active'),
          progress: goalData.progress || 0, emoji: goalData.emoji || "🎯",
        },
        goalClosed: isClosed(goalData.status),
        tasks: taskList.map(t => ({ ...t, task_date: t.date || selectedDate })),
        completedTaskCount: completed,
      })
      this.applyFilter()
      if (this.data.focusedTask && !this.data.taskAnchor) {
        const index = this.data.filteredTasks.findIndex(task => String(task.id) === this.data.focusedTask)
        this.setData({ taskAnchor: index >= 0 ? 'goal-task-' + index : '', focusMissing: index < 0 })
      }
    } catch (err) {
      if (!current()) return
      this.setData({ loadError: true })
      console.error("[目标详情] 加载失败:", err)
      wx.showToast({ title: "加载失败", icon: "none" })
    } finally {
      if (current()) this.setData({ loading: false })
    }
  },

  onShow() {
    if (this.ownsDetailSession(this.detailSession())) return
    this._detailSession = null
    this.setData({ accountChanged: true, goal: null, tasks: [], filteredTasks: [], completedTaskCount: 0,
      loading: false, loadError: false, result: null, showAdd: false, submittingTask: false, closingGoal: false,
      taskCreationPending: false, taskCreationStorageError: '', taskCreationDate: '',
      taskTitle: '', focusedTask: '', taskAnchor: '', focusMissing: false })
  },
  onUnload() { this._detailSession = null },

  statusText(s) {
    const map = { active: "进行中", doing: "进行中", todo: "待开始", done: "已完成", abandoned: "已放弃" }
    return map[s] || s
  },

  applyFilter() {
    let filtered = [...this.data.tasks]
    if (this.data.filter === "completed") filtered = filtered.filter(t => t.completed)
    else if (this.data.filter === "pending") filtered = filtered.filter(t => !t.completed)
    if (this.data.sortBy === "date") filtered.sort((a, b) => (a.task_date || "") > (b.task_date || "") ? 1 : -1)
    else if (this.data.sortBy === "xp") filtered.sort((a, b) => (b.xp_reward || 0) - (a.xp_reward || 0))
    this.setData({ filteredTasks: filtered })
  },

  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.filter }, () => this.applyFilter()) },
  setSort(e) { this.setData({ sortBy: e.currentTarget.dataset.sort }, () => this.applyFilter()) },
  onTaskDateChange(e) {
    if (!this.ownsDetailSession(this.detailSession()) || !schedule.validDate(e.detail.value)) return
    this.setData({ selectedDate: e.detail.value, result: null, tasks: [], filteredTasks: [], completedTaskCount: 0,
      focusedTask: '', taskAnchor: '', focusMissing: false })
    return this.loadGoalDetail(this.data.goalId)
  },
  retryLoad() { return this.loadGoalDetail(this.data.goalId) },

  async checkinTask(e) {
    const session = this.detailSession()
    if (!this.ownsDetailSession(session)) return
    const taskId = e.currentTarget.dataset.id
    const { goalId, selectedDate } = this.data
    const current = () => this.ownsDetailSession(session) && this.data.goalId === goalId && this.data.selectedDate === selectedDate
    const task = this.data.tasks.find(item => item.id === taskId)
    if (!task || task.completed || this.data.goalClosed) return
    if (selectedDate > schedule.today()) return wx.showToast({ title: '这项任务尚未到执行日期', icon: 'none' })
    const inFlight = this._taskCheckins || (this._taskCheckins = new Set())
    if (inFlight.has(taskId)) return
    inFlight.add(taskId)
    try {
      const res = await cloudApi.taskCheckin({ task_id: taskId, pet_growth: true })
      if (!current()) return
      if (!res?.success) throw new Error('打卡结果未确认')
      const tasks = this.data.tasks.map(t => t.id === taskId ? { ...t, completed: true } : t)
      const completed = tasks.filter(t => t.completed).length
      this.setData({
        tasks, completedTaskCount: completed,
        result: res.already_completed ? null : { xp_added: res.xp_earned || 0, streak_bonus: 0, total_xp: res.xp_earned || 0 },
      })
      this.applyFilter()
      if (this.data.loading) this.loadGoalDetail(goalId)
    } catch (err) {
      if (!current()) return
      wx.showToast({ title: typeof err === 'string' ? err : err.message || "打卡失败", icon: "none" })
    } finally {
      inFlight.delete(taskId)
    }
  },

  closeResult() { this.setData({ result: null }) },
  taskCreationKey() {
    return TASK_CREATION_PREFIX + JSON.stringify([this._detailScope, this.data.goalId])
  },
  readTaskCreation() {
    try {
      const saved = wx.getStorageSync(this.taskCreationKey()) || null
      if (saved && (saved.version !== 1 || saved.goal_id !== this.data.goalId || !schedule.validDate(saved.date) ||
          typeof saved.title !== 'string' || !saved.title.trim() || !Number.isInteger(saved.xp_reward) ||
          typeof saved.request_id !== 'string' || !/^[\w:.-]{1,128}$/.test(saved.request_id))) throw new Error('待确认记录无效')
      this.setData({ taskCreationPending: !!saved, taskCreationStorageError: '', taskCreationDate: saved?.date || '' })
      return saved
    } catch (_) {
      this.setData({ taskCreationStorageError: '本机待确认记录读取失败，暂时无法添加任务。' })
      return undefined
    }
  },
  showTaskCreation(request) {
    this._shownTaskCreationId = request.request_id
    this.setData({ showAdd: true, taskTitle: request.title, taskXp: request.xp_reward,
      taskCreationPending: true, taskCreationDate: request.date })
  },
  showAddTask() {
    if (!this.ownsDetailSession(this.detailSession()) || !this.data.goalId || this.data.submittingTask) return
    const pending = this.readTaskCreation()
    if (pending) return this.showTaskCreation(pending)
    if (pending === undefined || this.data.goalClosed) return
    this._shownTaskCreationId = null
    this.setData({ showAdd: true, taskTitle: '', taskXp: 10 })
  },
  cancelAdd() { if (!this.data.submittingTask) this.setData({ showAdd: false }) },
  onTaskTitle(e) { if (!this.data.taskCreationPending && !this.data.submittingTask) this.setData({ taskTitle: e.detail.value }) },
  selectTaskXp(e) { if (!this.data.taskCreationPending && !this.data.submittingTask) this.setData({ taskXp: Number(e.currentTarget.dataset.xp) }) },

  async submitTask() {
    const session = this.detailSession()
    if (!this.ownsDetailSession(session) || !this.data.goalId || this.data.submittingTask) return
    const { goalId, selectedDate } = this.data
    const key = this.taskCreationKey()
    let pending = this.readTaskCreation()
    if (pending === undefined) return
    if (pending && pending.request_id !== this._shownTaskCreationId) return this.showTaskCreation(pending)
    if (!pending && this._shownTaskCreationId) {
      this._shownTaskCreationId = null
      this.setData({ showAdd: false })
      return this.loadGoalDetail(goalId)
    }
    if (!pending) {
      if (this.data.goalClosed) return
      const title = this.data.taskTitle.trim()
      if (!title || title.length > 200) return wx.showToast({ title: '任务名称需为1至200字', icon: 'none' })
      const request_id = 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
      pending = { version: 1, request_id, title, xp_reward: this.data.taskXp ?? 10, goal_id: goalId, date: selectedDate }
      try { wx.setStorageSync(key, pending) }
      catch (_) {
        this.setData({ taskCreationStorageError: '本机未能保留任务原稿，请稍后重试。' })
        return
      }
      this.showTaskCreation(pending)
    }
    this.setData({ submittingTask: true })
    try {
      const { request_id, title, xp_reward, goal_id, date } = pending
      const receipt = await cloudApi.createTask({ request_id, title, xp_reward, goal_id, date })
      if (!this.ownsDetailSession(session)) return
      if (!receipt?.rejected && (!receipt?.success || !receipt.id)) throw new Error('添加结果未确认')
      if (wx.getStorageSync(key)?.request_id === request_id) wx.removeStorageSync(key)
      this._shownTaskCreationId = null
      this.readTaskCreation()
      if (receipt.rejected) return wx.showToast({ title: receipt.message || '任务未受理，请核对表单', icon: 'none' })
      this.setData({ showAdd: false })
      if (date === this.data.selectedDate) await this.loadGoalDetail(goalId)
      if (this.ownsDetailSession(session)) wx.showToast({ title: '任务已添加', icon: 'success' })
    } catch (err) {
      if (!this.ownsDetailSession(session)) return
      const outdated = err === '未知操作: createTaskOnce'
      wx.showToast({ title: outdated ? '云端待更新，任务原稿已保留' : '添加结果待确认，请继续确认原任务', icon: 'none' })
    } finally {
      if (this.ownsDetailSession(session)) this.setData({ submittingTask: false })
    }
  },

  abandonGoal() { this.closeGoal('abandoned') },
  completeGoal() { this.closeGoal('done') },
  closeGoal(status) {
    const session = this.detailSession()
    if (!this.ownsDetailSession(session) || !this.data.goal || this.data.goalClosed || this.data.closingGoal) return
    const goalId = this.data.goalId
    const done = status === 'done'
    this.setData({ closingGoal: true })
    wx.showModal({
      title: done ? '确认完成' : '确认放弃',
      content: done ? '恭喜！确定要标记这个目标为已完成吗？' : '确定要放弃这个目标吗？',
      confirmColor: done ? '#52c41a' : '#ff4d4f',
      success: async (res) => {
        try {
          if (!res.confirm || !this.ownsDetailSession(session)) return
          const result = await cloudApi.updateGoal(goalId, { status })
          if (!this.ownsDetailSession(session)) return
          if (!result?.success) throw new Error('操作结果未确认')
          this._loadId = (this._loadId || 0) + 1
          this.setData({ loading: false, goalClosed: true, showAdd: false, 'goal.status': status, 'goal.statusLabel': this.statusText(status) })
          wx.showToast({ title: done ? '目标已完成 🎉' : '已放弃', icon: 'success' })
          setTimeout(() => { if (this.ownsDetailSession(session)) wx.navigateBack() }, 800)
        } catch (err) {
          if (!this.ownsDetailSession(session)) return
          wx.showToast({ title: typeof err === 'string' ? err : err.message || '操作失败', icon: 'none' })
        } finally {
          if (this.ownsDetailSession(session)) this.setData({ closingGoal: false })
        }
      },
      fail: () => { if (this.ownsDetailSession(session)) this.setData({ closingGoal: false }) },
    })
  },
})
