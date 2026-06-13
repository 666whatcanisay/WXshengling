const cloudApi = require("../../utils/cloudApi");

function getDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

Page({
  data: {
    tasks: [], today: "", checkinResult: null, voiceText: "",
    loading: true, completedCount: 0, totalCount: 0, progressPercent: 0,
  },

  onShow() {
    const today = getDateStr(new Date());
    this.setData({ today, checkinResult: null, voiceText: "" });
    this.loadTasks();
  },

  async loadTasks() {
    this.setData({ loading: true });
    try {
      const res = await cloudApi.tasks({ date: this.data.today });
      const tasks = (res.data || res || []).map(t => ({
        id: t.id || t._id,
        title: t.title || '',
        completed: t.completed || false,
        task_date: t.date || this.data.today,
        xp_reward: t.xp_reward || 10,
        goal_id: t.goal_id || '',
      }));

      const completedCount = tasks.filter(t => t.completed).length;
      const totalCount = tasks.length;
      const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

      this.setData({ tasks, completedCount, totalCount, progressPercent, loading: false });
    } catch (err) {
      console.error('[Record] 加载任务失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，下拉刷新重试', icon: 'none' });
    }
  },

  async completeTask(e) {
    const taskId = e.currentTarget.dataset.id;
    const task = this.data.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (task.completed) return wx.showToast({ title: '该任务已完成', icon: 'none' });

    try {
      const res = await cloudApi.taskCheckin({ task_id: taskId });

      const tasks = this.data.tasks.map(t =>
        t.id === taskId ? { ...t, completed: true } : t
      );
      const completedCount = tasks.filter(t => t.completed).length;
      const totalCount = tasks.length;
      const progressPercent = Math.round((completedCount / totalCount) * 100);

      this.setData({
        tasks, completedCount, totalCount, progressPercent,
        checkinResult: {
          xp_added: res.xp_earned || task.xp_reward || 10,
          streak_bonus: 0,
          total_xp: res.xp_earned || task.xp_reward || 10,
        },
      });

      wx.showToast({ title: `打卡成功 +${res.xp_earned || task.xp_reward || 10}XP`, icon: 'success' });
    } catch (err) {
      console.error('[Record] 打卡失败:', err);
      wx.showToast({ title: '打卡失败，请重试', icon: 'error' });
    }
  },

  closeResult() {
    this.setData({ checkinResult: null });
  },

  onPullDownRefresh() {
    this.loadTasks().then(() => wx.stopPullDownRefresh());
  },
});
