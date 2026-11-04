const cloudApi = require("../../utils/cloudApi");
const schedule = require('../../utils/planSchedule');

Page({
  data: {
    goal: null, tasks: [], filteredTasks: [], completedTaskCount: 0,
    result: null, showAdd: false, taskTitle: "", taskXp: 10,
    today: "", selectedDate: "", filter: "all", sortBy: "date", loading: false, loadError: false, goalId: null,
  },

  onLoad(e) {
    const ds = schedule.today()
    const goalId = e.id || null
    this.setData({ today: ds, selectedDate: ds, goalId })
    this.loadGoalDetail(goalId)
  },

  async loadGoalDetail(id) {
    if (!id) return
    const selectedDate = this.data.selectedDate || schedule.today()
    const loadId = (this._loadId || 0) + 1
    this._loadId = loadId
    this.setData({ loading: true, loadError: false })
    try {
      // 【V8.5修复】callCloud 已自动解包 .data，res 直接是目标对象
      const res = await cloudApi.goalDetail(id)
      const goalData = res
      if (!goalData) throw new Error('目标不存在')
      const taskRes = await cloudApi.tasks({ date: selectedDate, goal_id: id })
      const rawTasks = Array.isArray(taskRes) ? taskRes : (taskRes.data || [])
      const taskList = rawTasks.filter(t => t.goal_id === id)
      if (loadId !== this._loadId) return

      const completed = taskList.filter(t => t.completed).length
      this.setData({
        goal: {
          id: goalData._id, title: goalData.title, description: goalData.description || "",
          target_days: goalData.target_days || goalData.target_value || 30, status: goalData.status || "active",
          statusLabel: this.statusText(goalData.status || 'active'),
          progress: goalData.progress || 0, emoji: goalData.emoji || "🎯",
        },
        tasks: taskList.map(t => ({ ...t, task_date: t.date || selectedDate })),
        completedTaskCount: completed,
      })
      this.applyFilter()
    } catch (err) {
      if (loadId !== this._loadId) return
      this.setData({ loadError: true })
      console.error("[目标详情] 加载失败:", err)
      wx.showToast({ title: "加载失败", icon: "none" })
    } finally {
      if (loadId === this._loadId) this.setData({ loading: false })
    }
  },

  onShow() {},

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
    this.setData({ selectedDate: e.detail.value, result: null, tasks: [], filteredTasks: [], completedTaskCount: 0 })
    return this.loadGoalDetail(this.data.goalId)
  },
  retryLoad() { return this.loadGoalDetail(this.data.goalId) },

  async checkinTask(e) {
    const taskId = e.currentTarget.dataset.id
    if (this.data.selectedDate > schedule.today()) return wx.showToast({ title: '这项任务尚未到执行日期', icon: 'none' })
    try {
      const res = await cloudApi.taskCheckin({ task_id: taskId })
      const tasks = this.data.tasks.map(t => t.id === taskId ? { ...t, completed: true } : t)
      const completed = tasks.filter(t => t.completed).length
      this.setData({
        tasks, completedTaskCount: completed,
        result: res.already_completed ? null : { xp_added: res.xp_earned || 0, streak_bonus: 0, total_xp: res.xp_earned || 0 },
      })
      this.applyFilter()
    } catch (err) {
      wx.showToast({ title: err.message || "打卡失败", icon: "none" })
    }
  },

  closeResult() { this.setData({ result: null }) },
  showAddTask() { this.setData({ showAdd: true, taskTitle: "", taskXp: 10 }) },
  cancelAdd() { this.setData({ showAdd: false }) },
  onTaskTitle(e) { this.setData({ taskTitle: e.detail.value }) },
  selectTaskXp(e) { this.setData({ taskXp: Number(e.currentTarget.dataset.xp) }) },

  async submitTask() {
    const title = this.data.taskTitle.trim()
    if (!title) return wx.showToast({ title: "请输入任务名称", icon: "none" })
    try {
      await cloudApi.createTask({ title, xp_reward: this.data.taskXp || 10, goal_id: this.data.goalId, date: this.data.selectedDate })
      this.setData({ showAdd: false })
      await this.loadGoalDetail(this.data.goalId)
      wx.showToast({ title: "任务已添加", icon: "success" })
    } catch (err) {
      wx.showToast({ title: "添加失败", icon: "error" })
    }
  },

  abandonGoal() {
    wx.showModal({
      title: "确认放弃", content: "确定要放弃这个目标吗？",
      confirmColor: "#ff4d4f",
      success: async (res) => {
        if (res.confirm) {
          try {
            await cloudApi.updateGoal(this.data.goalId, { status: "abandoned" })
            wx.showToast({ title: "已放弃", icon: "success" })
            setTimeout(() => wx.navigateBack(), 800)
          } catch (err) {
            wx.showToast({ title: "操作失败", icon: "error" })
          }
        }
      }
    })
  },

  completeGoal() {
    wx.showModal({
      title: "确认完成", content: "恭喜！确定要标记这个目标为已完成吗？",
      confirmColor: "#52c41a",
      success: async (res) => {
        if (res.confirm) {
          try {
            await cloudApi.updateGoal(this.data.goalId, { status: "done" })
            wx.showToast({ title: "目标已完成 🎉", icon: "success" })
            setTimeout(() => wx.navigateBack(), 800)
          } catch (err) {
            wx.showToast({ title: "操作失败", icon: "error" })
          }
        }
      }
    })
  },
})
