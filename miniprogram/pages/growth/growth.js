const cloudApi = require("../../utils/cloudApi");

Page({
  data: {
    logs: [], filteredLogs: [], loading: true,
    filter: "all",
    stats: { totalXp: 0, levelUps: 0, petStages: 0, achievements: 0 },
  },

  onShow() {
    this.loadLogs();
  },

  async loadLogs() {
    this.setData({ loading: true });
    try {
      const res = await cloudApi.growthLogs();
      const logs = (res.data || res || []).map((item) => ({
        ...item,
        // 统一 log_type 字段
        log_type: item.source || item.log_type || 'xp',
        content: item.reason || item.content || '',
        xp_amount: item.xp_change || item.xp_amount || 0,
        created_at: item.created_at ? new Date(item.created_at).toISOString() : '',
      }));

      // 计算统计数据
      const stats = {
        totalXp: logs.reduce((sum, l) => sum + (l.xp_amount || 0), 0),
        levelUps: logs.filter(l => l.log_type === 'level_up' || (l.reason && l.reason.indexOf('升级') >= 0)).length,
        petStages: logs.filter(l => l.log_type === 'pet_stage' || (l.reason && l.reason.indexOf('进化') >= 0)).length,
        achievements: logs.filter(l => l.log_type === 'achievement' || (l.reason && l.reason.indexOf('成就') >= 0)).length,
      };

      this.setData({ logs, stats, loading: false });
      this.applyFilter();
    } catch (err) {
      console.error('[Growth] 加载日志失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，下拉刷新重试', icon: 'none' });
    }
  },

  applyFilter() {
    let filtered = [...this.data.logs];
    if (this.data.filter !== 'all') {
      filtered = filtered.filter(l => l.log_type === this.data.filter);
    }
    this.setData({ filteredLogs: filtered });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, () => this.applyFilter());
  },

  onPullDownRefresh() {
    this.loadLogs().then(() => wx.stopPullDownRefresh());
  },
});
