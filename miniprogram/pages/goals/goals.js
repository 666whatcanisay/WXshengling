// 状态文本映射
const STATUS_MAP = { todo: "待开始", doing: "进行中", active: "进行中", done: "已完成", abandoned: "已放弃" };

// 云 API
const cloudApi = require('../../utils/cloudApi');
const schedule = require('../../utils/planSchedule');
const { accountScope } = require('../../utils/userSession');
const aiNavigation = require('../../utils/aiNavigation').createNavigation(wx, getApp);
const GOAL_CREATION_PREFIX = 'manual_goal_creation_v1:';

// Emoji 选择池
const EMOJI_OPTIONS = ['🎆', '🏮', '📎', '🐕', '💭', '🎹', '📑', '🆚', '🎟', '🆇', '🎍', '🏸'];

Page({
  data: {
    goals: [],
    completedGoalCount: 0,
    completedGoalsExpanded: false,
    expandedGoalId: '',
    showForm: false,
    formTitle: "",
    formDesc: "",
    formDays: 30,
    formEmoji: '🎆',
    loading: true,
    loadError: false,
    submittingGoal: false,
    goalCreationPending: false,
    goalCreationStart: '',
    goalCreationStorageError: '',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    const session = this.syncGoalSession()
    const pending = session ? this.readGoalCreation() : null
    const name = aiNavigation.takeNewGoalTitle()
    if (name && session && pending === null && !this.data.submittingGoal) {
      if (!this.data.showForm) this.showCreateForm()
      if (!this.data.formTitle.trim()) this.setData({ formTitle: name })
      else if (this.data.formTitle !== name) {
        const previousName = this.data.formTitle
        wx.showModal({
          title: '替换目标名称？',
          content: '候选名称「' + name + '」。原来填写的目标说明和周期会保留。',
          confirmText: '使用候选',
          cancelText: '保留原名',
          success: res => {
            if (res.confirm && this.ownsGoalSession(session) && !this.data.goalCreationPending &&
                this.data.showForm && this.data.formTitle === previousName) {
              this.setData({ formTitle: name })
            }
          },
        })
      }
    } else if (name && pending) {
      wx.showToast({ title: '请先确认上次新建目标', icon: 'none' })
    }
    if (!getApp().isOfflineMode) return this.loadGoals();
  },

  syncGoalSession() {
    const { globalData } = getApp();
    const scope = accountScope(globalData);
    const session = scope ? globalData.userInfo : null;
    if (this._goalSession === session && this._goalScope === scope) return session;
    if (this._goalSession !== undefined) {
      this._goalListRead = null;
      this._goalListDate = '';
      this._shownGoalCreationId = null;
      this._todayCheckins = null;
      this.setData({ goals: [], completedGoalCount: 0, completedGoalsExpanded: false, expandedGoalId: '',
        showForm: false, formTitle: '', formDesc: '', formDays: 30, formEmoji: '🎆',
        loading: false, loadError: false, submittingGoal: false, goalCreationPending: false, goalCreationStart: '', goalCreationStorageError: '' });
    }
    this._goalSession = session;
    this._goalScope = scope;
    return session;
  },

  ownsGoalSession(session) {
    const { globalData } = getApp();
    return !!session && this._goalSession === session && globalData.userInfo === session && this._goalScope === accountScope(globalData);
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadGoals().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 加载目标列表（从云 API）+ 今日任务
  async loadGoals() {
    const session = this.syncGoalSession();
    if (!session || getApp().isOfflineMode) return this.setData({ loading: false });
    const request = this._goalListRead = {};
    const current = () => this._goalListRead === request && this.ownsGoalSession(session);
    this.setData({ loading: true, loadError: false });
    try {
      // 【V8.4修复】并行加载目标和今日任务，解决目标页任务永远为空的问题
      var today = this._todayStr();
      const [goalsRes, tasksRes] = await Promise.all([
        cloudApi.goals(),
        cloudApi.tasks({ date: today }),
      ]);
      if (!current()) return;
      if (today !== this._todayStr()) return this.loadGoals();

      // 【V8.5修复】callCloud 已自动解包 .data，goalsRes/tasksRes 直接是数组
      const allTasks = Array.isArray(tasksRes) ? tasksRes : tasksRes?.data;
      const rawGoals = Array.isArray(goalsRes) ? goalsRes : goalsRes?.data;
      if (!Array.isArray(allTasks) || !Array.isArray(rawGoals)) throw new Error('目标或任务返回格式不正确');
      console.log('[Goals] 加载到 ' + allTasks.length + ' 个今日任务, 日期=' + today);

      var goals = rawGoals.map(function(g) {
        var gId = String(g._id || g.id || '');
        // 【V8.4防御】用String()统一类型，避免goal_id类型不匹配导致任务不显示
        var matchedTasks = (allTasks || []).filter(function(t) {
          return String(t.goal_id || '') === gId;
        }).map(function(t) {
          return { id: t.id || t._id, title: t.title, done: !!t.completed, xp_reward: t.xp_reward ?? 10 };
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
          todayDoneCount: doneCount,
          completed_days: completedDays,
          target_days: g.target_days || g.target_value || 30,
          progress: progress,
        };
      });
      // 过滤掉已放弃的目标
      goals = goals.filter(function(g) { return g.status !== 'abandoned' })

      this._goalListDate = today;
      this.setData({
        goals,
        completedGoalCount: goals.filter(goal => goal.status === 'done').length,
        loading: false,
      });
    } catch (err) {
      if (!current()) return;
      console.error('加载目标失败:', err);
      wx.showToast({ title: '加载失败，请下拉刷新重试', icon: 'none' });
      this.setData({ loading: false, loadError: true });
    }
  },

  // 获取今天日期字符串 YYYY-MM-DD
  _todayStr: function() {
    return schedule.today();
  },

  // ===== 目标 CRUD =====

  readGoalCreation() {
    try {
      const saved = wx.getStorageSync(GOAL_CREATION_PREFIX + this._goalScope) || null;
      const request = saved?.request;
      if (saved && (saved.version !== 1 || !request || typeof request.title !== 'string' || !request.title.trim() ||
          typeof request.description !== 'string' || typeof request.emoji !== 'string' ||
          !Number.isSafeInteger(request.target_days) || request.target_days < 1 ||
          !schedule.validDate(request.start_date) || typeof request.request_id !== 'string' ||
          !/^[\w:.-]{1,128}$/.test(request.request_id))) throw new Error('待确认目标无效');
      this.setData({ goalCreationPending: !!request, goalCreationStart: request?.start_date || '', goalCreationStorageError: '' });
      return request || null;
    } catch (_) {
      this.setData({ goalCreationStorageError: '本机待确认记录读取失败，请重试。' });
      return undefined;
    }
  },

  showGoalCreation(request) {
    this._shownGoalCreationId = request.request_id;
    this.setData({ showForm: true, formTitle: request.title, formDesc: request.description, formDays: request.target_days,
      formEmoji: request.emoji, goalCreationPending: true, goalCreationStart: request.start_date });
  },

  showCreateForm() {
    if (!this.syncGoalSession() || this.data.submittingGoal) return;
    const pending = this.readGoalCreation();
    if (pending) return this.showGoalCreation(pending);
    if (pending === undefined) return;
    this._shownGoalCreationId = null;
    const randomEmoji = EMOJI_OPTIONS[Math.floor(Math.random() * EMOJI_OPTIONS.length)];
    this.setData({ showForm: true, formTitle: "", formDesc: "", formDays: 30, formEmoji: randomEmoji });
  },

  cancelForm() {
    if (this.data.submittingGoal) return;
    this.setData({ showForm: false, formTitle: "", formDesc: "", formDays: 30 });
  },

  onTitle(e) { if (!this.data.goalCreationPending && !this.data.submittingGoal) this.setData({ formTitle: e.detail.value }); },
  onDesc(e) { if (!this.data.goalCreationPending && !this.data.submittingGoal) this.setData({ formDesc: e.detail.value }); },
  selectDays(e) { if (!this.data.goalCreationPending && !this.data.submittingGoal) this.setData({ formDays: e.currentTarget.dataset.days }); },

  selectEmoji(e) {
    if (!this.data.goalCreationPending && !this.data.submittingGoal) this.setData({ formEmoji: e.currentTarget.dataset.emoji });
  },

  toggleGoalTasks(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedGoalId: this.data.expandedGoalId === id ? '' : id });
  },

  toggleCompletedGoals() {
    this.setData({ completedGoalsExpanded: !this.data.completedGoalsExpanded });
  },

  async submitGoal() {
    const session = this.syncGoalSession();
    if (!session || this.data.submittingGoal) return;
    const key = GOAL_CREATION_PREFIX + this._goalScope;
    let request = this.readGoalCreation();
    if (request === undefined) return;
    if (request && request.request_id !== this._shownGoalCreationId) return this.showGoalCreation(request);
    if (!request && this._shownGoalCreationId) {
      this._shownGoalCreationId = null;
      this.setData({ showForm: false });
      return this.loadGoals();
    }
    if (!request) {
      const title = this.data.formTitle.trim();
      if (!title) return wx.showToast({ title: '请输入目标名称', icon: 'none' });
      const days = Number(this.data.formDays);
      if (!Number.isSafeInteger(days) || days < 1) return wx.showToast({ title: '请选择有效的目标天数', icon: 'none' });
      request = { title, description: this.data.formDesc.trim() || '努力实现这个目标！', emoji: this.data.formEmoji || '🎆',
        target_value: days, target_days: days, start_date: this._todayStr(),
        request_id: 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
      try { wx.setStorageSync(key, { version: 1, request }); }
      catch (_) {
        this.setData({ goalCreationStorageError: '本机未能保留目标原稿，请稍后重试。' });
        return;
      }
      this.showGoalCreation(request);
    }
    this.setData({ submittingGoal: true });
    try {
      const receipt = await cloudApi.createGoalOnce(request);
      if (!this.ownsGoalSession(session)) return;
      if (!receipt?.rejected && (!receipt?.success || !receipt.id)) throw new Error('创建结果未确认');
      if (wx.getStorageSync(key)?.request?.request_id === request.request_id) wx.removeStorageSync(key);
      this._shownGoalCreationId = null;
      this.readGoalCreation();
      if (receipt.rejected) return wx.showToast({ title: receipt.message || '目标未受理，请核对表单', icon: 'none' });
      wx.showToast({ title: `《${request.title}》已创建 🎶`, icon: 'success' });
      this.setData({ showForm: false, formTitle: "", formDesc: "" });
      this.loadGoals();
    } catch (err) {
      if (!this.ownsGoalSession(session)) return;
      const outdated = err === '未知操作: createGoalOnce';
      wx.showToast({ title: outdated ? '云端待更新，目标原稿已保留' : '创建结果待确认，请继续确认原目标', icon: 'none' });
    } finally {
      if (this.ownsGoalSession(session)) this.setData({ submittingGoal: false });
    }
  },

  // 【V8.4修复】今日任务打卡（同步到后端 + 触发成长值）
  async toggleTodayTask(e) {
    const session = this.syncGoalSession();
    if (!session) return;
    const date = this._todayStr();
    if (this._goalListDate && this._goalListDate !== date) return this.loadGoals();
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
    const inFlight = this._todayCheckins || (this._todayCheckins = new Set());
    if (inFlight.has(taskId)) return;
    inFlight.add(taskId);

    try {
      // 1. 调用后端打卡
      const checkinResult = await cloudApi.taskCheckin({ task_id: taskId, pet_growth: true });
      if (!this.ownsGoalSession(session)) return;
      if (!checkinResult?.success) throw new Error('打卡结果未确认');
      if (date !== this._todayStr()) return this.loadGoals();

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
        const newCompletedDays = Math.max(g.completed_days || 0, checkinResult.completed_days || 0);
        return {
          ...g,
          todayTasks: updatedTasks,
          todayDoneCount: doneCount,
          progress: Math.round((doneCount / totalCount) * 100),
          completed_days: newCompletedDays,
        };
      });
      this.setData({ goals });
      wx.showToast({ title: checkinResult.already_completed ? '任务已完成' : '打卡成功 ⭐', icon: 'success' });
      if (this.data.loading) this.loadGoals();
    } catch (err) {
      if (!this.ownsGoalSession(session) || date !== this._todayStr()) return;
      console.error('打卡失败:', err);
      wx.showToast({ title: '打卡失败，请重试', icon: 'none' });
    } finally {
      inFlight.delete(taskId);
    }
  },

  // 跳转目标详情
  goDetail(e) {
    if (this.ownsGoalSession(this._goalSession)) {
      wx.navigateTo({ url: "/pages/goal-detail/goal-detail?id=" + encodeURIComponent(e.currentTarget.dataset.id) });
    }
  },
});
