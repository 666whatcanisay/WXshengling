// Run only after authorizing 1 labelled test goal + 2 future tasks in the current account.
// Direct native calls have no automatic retry. An uncertain write stops reruns for inspection.
;(async () => {
  let journal, storageKey
  const env = 'cloud1-d5gz9j6zh654f4b36'
  const invoke = async (name, data) => {
    const { result: r } = await wx.cloud.callFunction({ name, config: { env }, data })
    if (!r || r.code === -1 || r.success === false) throw Error(r && r.message || '请求未确认，停止后不要连续重跑')
    return r.data === undefined ? r : r.data
  }
  try {
    const native = await invoke('login-node24', {}), app = getApp().globalData || {}
    const cached = app.currentOpenid || app.userInfo && (app.userInfo.openid || app.userInfo._openid)
    if (!native.openid || native.openid !== cached) throw Error('当前登录身份未核对，请先正常登录')
    storageKey = 'adjustment_test_setup_v1:' + native.openid
    if (wx.getStorageSync(storageKey)) throw Error('已有本轮准备记录，请先回传日志核对，未重复新建')
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const day = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
    const tag = Date.now().toString(36)
    journal = { version: 1, tag, title: '[联调] 任务调整-' + tag, start: day(1), end: day(7), goal_id: '', task_ids: [], stage: 'before_goal' }
    const persist = () => wx.setStorageSync(storageKey, journal)
    persist() // If this fails, nothing is created.
    const goal = await invoke('app-node24', { action: 'createGoal', data: { title: journal.title, target_days: 7, start_date: journal.start, create_initial_task: false } })
    if (!goal.id) throw Error('新目标ID未确认，请停下核对')
    journal.goal_id = goal.id; journal.stage = 'goal_created'; persist()
    for (let i = 0; i < 2; i++) {
      journal.stage = 'before_task_' + i; persist()
      const task = await invoke('app-node24', { action: 'createTask', data: { goal_id: goal.id, title: i ? '[联调] 整理笔记20分钟' : '[联调] 阅读20分钟',
        date: day(i + 1), estimated_minutes: 20, xp_reward: 10, stage: 1 } })
      if (!task.id) throw Error('新任务ID未确认，请停下核对')
      journal.task_ids.push(task.id); journal.stage = 'task_' + i + '_created'; persist()
    }
    const w = await invoke('app-node24', { action: 'getAdjustmentWorkspace', data: { goal_id: journal.goal_id, date: today } })
    journal.stage = 'ready'; persist()
    console.log('调整测试准备', JSON.stringify({ ok: w.snapshot.eligible && w.snapshot.complete && w.snapshot.tasks.length === 2,
      title: journal.title, goalId: journal.goal_id, taskIds: journal.task_ids, period: [journal.start, journal.end],
      futureTasks: w.snapshot.tasks.length, modelCalls: false, note: '仅创建已标记的测试目标和2项未来任务；未打卡或发奖励，请保留输出供定向清理' }))
  } catch (e) {
    console.log('调整测试准备', JSON.stringify({ ok: false, message: e.message || e.errMsg || '结果未确认',
      stage: journal && journal.stage, title: journal && journal.title, goalId: journal && journal.goal_id, taskIds: journal && journal.task_ids,
      note: '可能已部分创建，请先回传核对，不要连续重跑' }))
  }
})()
