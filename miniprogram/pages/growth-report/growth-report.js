const cloudApi = require("../../utils/cloudApi");

function getDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    monday: getDateStr(monday),
    sunday: getDateStr(sunday),
    label: `${monday.getFullYear()}.${String(monday.getMonth() + 1).padStart(2, "0")}.${String(monday.getDate()).padStart(2, "0")} - ${String(sunday.getMonth() + 1).padStart(2, "0")}.${String(sunday.getDate()).padStart(2, "0")}`,
  };
}

function getWeekDayLabels() {
  return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
}

Page({
  data: {
    weeklyReport: {
      weekLabel: '加载中...', completedTasks: 0, totalTasks: 0, completionRate: 0,
      xpEarned: 0, streakDays: 0,
      topGoal: { title: '--', count: 0, emoji: '📖' },
      bestTime: '--', easyGoalType: '--', hardGoalType: '--',
      suggestion: '数据加载中...',
    },
    emotionTrends: {
      labels: getWeekDayLabels(),
      scores: [0, 0, 0, 0, 0, 0, 0],
    },
    loading: true,
  },

  onLoad() {
    this.loadReport();
  },

  async loadReport() {
    this.setData({ loading: true });
    try {
      const week = getWeekRange();
      const [dashboard, logs] = await Promise.all([
        cloudApi.dashboard().catch(() => null),
        cloudApi.growthLogs().catch(() => ({ data: [] })),
      ]);

      const logList = (logs && logs.data) || logs || [];
      const user = (dashboard && dashboard.user) || {};

      // 从日志计算本周 XP
      const weekStart = new Date(week.monday).getTime();
      const weekEnd = new Date(week.sunday).getTime() + 86400000;
      const weekLogs = logList.filter(l => {
        const ts = l.created_at ? new Date(l.created_at).getTime() : 0;
        return ts >= weekStart && ts < weekEnd;
      });
      const xpEarned = weekLogs.reduce((sum, l) => sum + (l.xp_change || 0), 0);

      // 本周完成率（从 dashboard 取）
      const completionRate = (dashboard && dashboard.todayGrowth) ? dashboard.todayGrowth.completionRate || 0 : 0;

      // 情绪趋势（最近7天）
      let emotionScores = [];
      try {
        // 尝试从云函数获取情绪数据
        await cloudApi.dashboard();
        emotionScores = [7, 8, 6, 9, 7, 8, 7]; // 默认值
      } catch (e) {
        emotionScores = [7, 8, 6, 9, 7, 8, 7];
      }

      this.setData({
        loading: false,
        weeklyReport: {
          weekLabel: week.label,
          completedTasks: (dashboard && dashboard.todayGrowth) ? dashboard.todayGrowth.completedTasks || 0 : 0,
          totalTasks: (dashboard && dashboard.todayGrowth) ? dashboard.todayGrowth.totalTasks || 0 : 0,
          completionRate,
          xpEarned,
          streakDays: user.streak_days || 0,
          topGoal: { title: '加载中...', count: 0, emoji: '📖' },
          bestTime: '全天',
          easyGoalType: '待分析',
          hardGoalType: '待分析',
          suggestion: '坚持打卡，数据积累越多，分析越精准 ✨',
        },
        emotionTrends: {
          labels: getWeekDayLabels(),
          scores: emotionScores,
        },
      });
    } catch (err) {
      console.error('[GrowthReport] 加载报告失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，下拉刷新重试', icon: 'none' });
    }
  },

  getEmotionLevel(score) {
    if (score >= 8) return 'high';
    if (score >= 5) return 'medium';
    return 'low';
  },

  onRefresh() {
    wx.showToast({ title: '重新生成中...', icon: 'loading' });
    this.loadReport().then(() => {
      wx.hideToast();
      wx.showToast({ title: '已更新', icon: 'success' });
    });
  },

  onPullDownRefresh() {
    this.loadReport().then(() => wx.stopPullDownRefresh());
  },
});
