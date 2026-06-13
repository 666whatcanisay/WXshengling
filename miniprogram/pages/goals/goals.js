// 状态文本映射
const STATUS_MAP = { todo: "待开始", doing: "进行中", done: "已完成", abandoned: "已放弃" };

// 云 API
const cloudApi = require('../../utils/cloudApi');

// Emoji 选择池
const EMOJI_OPTIONS = ['🎆', '🏮', '📎', '🐕', '💭', '🎹', '📑', '🆚', '🎟', '🆇', '🎍', '🏸'];

Page({
  data: {
    goals: [],
    showForm: false,
    formTitle: "",
    formDesc: "",
    formDays: 30,
    formEmoji: '🎆',
    loading: true,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.loadGoals();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadGoals().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 加载目标列表（从云 API）
  async loadGoals() {
    this.setData({ loading: true });
    try {
      const res = await cloudApi.goals();
      const goals = (res.data || []).map(g => ({
        ...g,
        id: g._id || g.id,
        statusLabel: STATUS_MAP[g.status] || g.status,
        todayTasks: g.todayTasks || [],
        completed_days: g.completed_days || 0,
        target_days: g.target_days || 30,
      }));
      this.setData({ goals, loading: false });
    } catch (err) {
      console.error('加载目标失败:', err);
      wx.showToast({ title: '加载失败，请下拉刷新重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // ===== 目标 CRUD =====

  showCreateForm() {
    const randomEmoji = EMOJI_OPTIONS[Math.floor(Math.random() * EMOJI_OPTIONS.length)];
    this.setData({ showForm: true, formTitle: "", formDesc: "", formDays: 30, formEmoji: randomEmoji });
  },

  cancelForm() {
    this.setData({ showForm: false, formTitle: "", formDesc: "", formDays: 30 });
  },

  onTitle(e) { this.setData({ formTitle: e.detail.value }); },
  onDesc(e) { this.setData({ formDesc: e.detail.value }); },
  selectDays(e) { this.setData({ formDays: e.currentTarget.dataset.days }); },

  selectEmoji(e) {
    this.setData({ formEmoji: e.currentTarget.dataset.emoji });
  },

  async submitGoal() {
    const title = this.data.formTitle.trim();
    if (!title) return wx.showToast({ title: "请输入目标名称", icon: "none" });

    const data = {
      title,
      description: this.data.formDesc.trim() || '努力实现这个目标！',
      emoji: this.data.formEmoji || '🎆',
      target_value: this.data.formDays,
    };

    try {
      await cloudApi.createGoal(data);
      wx.showToast({ title: `《${title}》已创建 🎶`, icon: 'success' });
      this.setData({ showForm: false, formTitle: "", formDesc: "" });
      this.loadGoals();
    } catch (err) {
      console.error('创建目标失败:', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  // 今日任务打卡（本地状态切换）
  toggleTodayTask(e) {
    const goalId = e.currentTarget.dataset.goalid;
    const taskId = e.currentTarget.dataset.taskid;
    const goals = this.data.goals.map(g => {
      const gId = g._id || g.id;
      if (String(gId) !== String(goalId)) return g;
      return {
        ...g,
        todayTasks: (g.todayTasks || []).map(t =>
          t.id === taskId ? { ...t, done: !t.done } : t
        ),
      };
    });

    const updatedGoals = goals.map(g => {
      const gId = g._id || g.id;
      if (String(gId) !== String(goalId)) return g;
      const doneCount = (g.todayTasks || []).filter(t => t.done).length;
      const totalCount = g.todayTasks.length || 1;
      return { ...g, progress: Math.round((doneCount / totalCount) * 100) };
    });

    this.setData({ goals: updatedGoals });
    wx.showToast({ title: '任务状态已更新 ✅', icon: 'success' });
  },

  // 跳转目标详情
  goDetail(e) {
    wx.navigateTo({ url: "/pages/goal-detail/goal-detail?id=" + e.currentTarget.dataset.id });
  },
});
