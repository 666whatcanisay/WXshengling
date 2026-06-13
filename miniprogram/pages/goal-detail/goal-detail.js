const cloudApi = require("../../utils/cloudApi");

Page({
  data: {
    goal: null, tasks: [], filteredTasks: [], completedTaskCount: 0,
    result: null, showAdd: false, taskTitle: "", taskXp: 10,
    today: "", filter: "all", sortBy: "date", loading: false, goalId: null,
  },

  onLoad(e) {
    const today = new Date()
    const ds = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`
    const goalId = e.id || null
    this.setData({ today: ds, goalId })
    this.loadGoalDetail(goalId)
  },

  async loadGoalDetail(id) {
    if (!id) return
    this.setData({ loading: true })
    try {
      const res = await cloudApi.goalDetail(id)
      if (res && res.data) {
        const goalData = res.data
        // 加载该目标对应的今日任务
        let taskList = []
        try {
          const taskRes = await cloudApi.tasks({ date: this.data.today })
          taskList = (taskRes.data || []).filter(t => t.goal_id === id)
        } catch (e) { /* 无任务 */ }

        const completed = taskList.filter(t => t.completed).length
        this.setData({
          goal: {
            id: goalData._id, title: goalData.title, description: goalData.description || "",
            target_days: goalData.target_value || 30, status: goalData.status || "active",
            progress: goalData.progress || 0, emoji: goalData.emoji || "🎯",
          },
          tasks: taskList.map(t => ({ ...t, task_date: this.data.today })),
          completedTaskCount: completed,
        })
        this.applyFilter()
      }
    } catch (err) {
      console.error("[目标详情] 加载失败:", err)
      wx.showToast({ title: "加载失败", icon: "none" })
    }
    this.setData({ loading: false })
  },

  onShow() {},

  statusText(s) {
    const map = { active: "进行中", todo: "待开始", done: "已完成", abandoned: "已放弃" }
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

  async checkinTask(e) {
    const taskId = e.currentTarget.dataset.id
    try {
      const res = await cloudApi.taskCheckin({ task_id: taskId })
      const tasks = this.data.tasks.map(t => t.id === taskId ? { ...t, completed: true } : t)
      const completed = tasks.filter(t => t.completed).length
      this.setData({
        tasks, completedTaskCount: completed,
        result: { xp_added: res.xp_earned || 15, streak_bonus: 0, total_xp: res.xp_earned || 15 },
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
      await cloudApi.createTask({ title, xp_reward: this.data.taskXp || 10, goal_id: this.data.goalId })
      // 重新加载任务列表
      const taskRes = await cloudApi.tasks({ date: this.data.today })
      const taskList = (taskRes.data || []).filter(t => t.goal_id === this.data.goalId)
      const completed = taskList.filter(t => t.completed).length
      this.setData({ tasks: taskList.map(t => ({ ...t, task_date: this.data.today })), showAdd: false, completedTaskCount: completed })
      this.applyFilter()
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
})
