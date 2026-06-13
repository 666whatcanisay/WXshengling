const cloudApi = require("../../utils/cloudApi");

function getDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getWeekDates() {
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(getDateStr(d));
  }
  return dates;
}

Page({
  data: {
    pet: null, totalCheckins: 0, totalTasks: 0, completedTasks: 0,
    completionRate: 0, streakDays: 0, userLevel: 1, totalXp: 0,
    pets: [], goals: [], weekDates: [], weekCheckins: [], loading: true,
  },

  onShow() {
    this.loadStats();
  },

  async loadStats() {
    this.setData({ loading: true });
    try {
      const [dashboard, petRes, goalRes] = await Promise.all([
        cloudApi.dashboard().catch(() => null),
        cloudApi.pets().catch(() => ({ data: [] })),
        cloudApi.goals().catch(() => ({ data: [] })),
      ]);

      const user = (dashboard && dashboard.user) || {};
      const todayGrowth = (dashboard && dashboard.todayGrowth) || {};
      const pets = (petRes && petRes.data) || petRes || [];
      const goals = (goalRes && goalRes.data) || goalRes || [];
      const achievements = (dashboard && dashboard.achievements) || [];
      if (achievements.length > 0) {
        // 成就数据可用于后续扩展，如成就徽章展示
      }

      const pet = pets.length > 0 ? pets[0] : null;
      const weekDates = getWeekDates();

      // 本周打卡数据（简化：使用签到天数模拟）
      const weekCheckins = weekDates.map((date, i) => ({
        date,
        count: i <= user.streak_days ? 1 : 0,
      }));

      this.setData({
        pet: pet ? { name: pet.name, stage: pet.stage, status: pet.status } : null,
        pets: pets.map(p => ({ name: p.name, stage: p.stage, is_active: true })),
        goals: goals.map(g => ({
          id: g.id || g._id,
          title: g.title,
          status: g.status || 'doing',
        })),
        totalCheckins: user.streak_days || 0,
        totalTasks: todayGrowth.totalTasks || 0,
        completedTasks: todayGrowth.completedTasks || 0,
        completionRate: todayGrowth.completionRate || 0,
        streakDays: user.streak_days || 0,
        userLevel: user.level || 1,
        totalXp: user.total_xp || 0,
        weekDates, weekCheckins, loading: false,
      });
    } catch (err) {
      console.error('[Stats] 加载统计失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，下拉刷新重试', icon: 'none' });
    }
  },

  getWeekDay(dateStr) {
    return ["日", "一", "二", "三", "四", "五", "六"][new Date(dateStr).getDay()];
  },

  onPullDownRefresh() {
    this.loadStats().then(() => wx.stopPullDownRefresh());
  },
});
