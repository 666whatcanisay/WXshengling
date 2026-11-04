// 状态文本映射
const STATUS_MAP = { todo: "待开始", doing: "进行中", done: "已完成", abandoned: "已放弃" };

// 云 API
const cloudApi = require('../../utils/cloudApi');
const schedule = require('../../utils/planSchedule');

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
    // 【安全修复】离线模式不加载云端数据
    var app = getApp()
    if (app.isOfflineMode) {
      console.warn('[Goals] 离线模式，跳过云端数据加载')
      return
    }
    this.loadGoals();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadGoals().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 加载目标列表（从云 API）+ 今日任务
  async loadGoals() {
    this.setData({ loading: true });
    try {
      // 【V8.4修复】并行加载目标和今日任务，解决目标页任务永远为空的问题
      var today = this._todayStr();
      const [goalsRes, tasksRes] = await Promise.all([
        cloudApi.goals(),
        cloudApi.tasks({ date: today }),
      ]);

      // 【V8.5修复】callCloud 已自动解包 .data，goalsRes/tasksRes 直接是数组
      var allTasks = Array.isArray(tasksRes) ? tasksRes : (tasksRes.data || []);
      console.log('[Goals] 加载到 ' + allTasks.length + ' 个今日任务, 日期=' + today);

      var rawGoals = Array.isArray(goalsRes) ? goalsRes : (goalsRes.data || []);
      var goals = rawGoals.map(function(g) {
        var gId = String(g._id || g.id || '');
        // 【V8.4防御】用String()统一类型，避免goal_id类型不匹配导致任务不显示
        var matchedTasks = (allTasks || []).filter(function(t) {
          return String(t.goal_id || '') === gId;
        }).map(function(t) {
          return { id: t.id || t._id, title: t.title, done: !!t.completed, xp_reward: t.xp_reward || 10 };
        });

        if (matchedTasks.length > 0) {
          console.log('[Goals] 目标"' + (g.title || '') + '"关联' + matchedTasks.length + '个任务');
        }

        var doneCount = matchedTasks.filter(function(t) { return t.done }).length
        var totalCount = matchedTasks.length || 1
        // 计算进度（基于今日任务完成率）
        var progress = Math.round((doneCount / totalCount) * 100)
        // 计算累计完成天数（基于今日任务全部完成则+1，否则取DB值）
        var completedDays = g.completed_days || 0

        return {
          ...g,
          id: gId,
          statusLabel: STATUS_MAP[g.status] || g.status,
          todayTasks: matchedTasks,
          completed_days: completedDays,
          target_days: g.target_days || g.target_value || 30,
          progress: progress,
        };
      });
      // 过滤掉已放弃的目标
      goals = goals.filter(function(g) { return g.status !== 'abandoned' })

      this.setData({ goals: goals, loading: false });
      console.log('[GOALS]', JSON.stringify(rawGoals));
      console.log('[TASKS]', JSON.stringify(allTasks));
      console.log('[FINAL]', JSON.stringify(goals));
    } catch (err) {
      console.error('加载目标失败:', err);
      wx.showToast({ title: '加载失败，请下拉刷新重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // 获取今天日期字符串 YYYY-MM-DD
  _todayStr: function() {
    return schedule.today();
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
    var self = this;

    const data = {
      title,
      description: this.data.formDesc.trim() || '努力实现这个目标！',
      emoji: this.data.formEmoji || '🎆',
      target_value: this.data.formDays,
      target_days: this.data.formDays,
    };

    try {
      await cloudApi.createGoal(data);
      // 【V8.3修复】创建目标不再自动创建蛋，两者独立
      // 用户可在宠物森林手动领取蛋（支持最多3只）
      wx.showToast({ title: `《${title}》已创建 🎶`, icon: 'success' });
      this.setData({ showForm: false, formTitle: "", formDesc: "" });
      setTimeout(function() { self.loadGoals(); }, 500);
    } catch (err) {
      console.error('创建目标失败:', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  // 【V8.4修复】今日任务打卡（同步到后端 + 触发成长值）
  async toggleTodayTask(e) {
    const goalId = e.currentTarget.dataset.goalid;
    const taskId = e.currentTarget.dataset.taskid;

    // 找到当前任务
    var goal = this.data.goals.find(function(g) {
      return String(g._id || g.id) === String(goalId);
    });
    if (!goal) return;
    var task = (goal.todayTasks || []).find(function(t) { return t.id === taskId; });
    if (!task) return;
    if (task.done) return wx.showToast({ title: '该任务已完成', icon: 'none' });

    try {
      // 1. 调用后端打卡
      const checkinResult = await cloudApi.taskCheckin({ task_id: taskId });
      // 2. 触发成长值入池/孵化（与首页quickCheckin保持一致）
      if (!checkinResult.already_completed && checkinResult.xp_earned > 0) {
        try { await cloudApi.hatchProgress({ source: 'complete_goal' }) } catch(e) { /* 无蛋时忽略 */ }
      }

      // 3. 更新本地状态
      const goals = this.data.goals.map(g => {
        const gId = g._id || g.id;
        if (String(gId) !== String(goalId)) return g;
        const updatedTasks = (g.todayTasks || []).map(t =>
          t.id === taskId ? { ...t, done: true } : t
        );
        const doneCount = updatedTasks.filter(t => t.done).length;
        const totalCount = updatedTasks.length || 1;
        // 今日任务全部完成 → 完成天数+1
        var newCompletedDays = checkinResult.completed_days === undefined ? (g.completed_days || 0) : checkinResult.completed_days
        return {
          ...g,
          todayTasks: updatedTasks,
          progress: Math.round((doneCount / totalCount) * 100),
          completed_days: newCompletedDays,
        };
      });
      this.setData({ goals });
      wx.showToast({ title: checkinResult.already_completed ? '任务已完成' : '打卡成功 ⭐', icon: 'success' });
    } catch (err) {
      console.error('打卡失败:', err);
      wx.showToast({ title: '打卡失败，请重试', icon: 'none' });
    }
  },

  // 跳转目标详情
  goDetail(e) {
    wx.navigateTo({ url: "/pages/goal-detail/goal-detail?id=" + e.currentTarget.dataset.id });
  },
});
