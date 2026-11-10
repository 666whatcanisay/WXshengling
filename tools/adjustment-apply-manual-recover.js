// Completes only the already-created, authorized stage 5B test batch.
// No createGoal, model call, checkin, apply, deletion or automatic retry.
;(async () => {
  const env = 'cloud1-d5gz9j6zh654f4b36'
  const goalId = '10f29c566aede179000384776d3f22e2', title = '[联调] 确认应用-mw526pzz'
  let journal, createdTasks = 0
  const invoke = async (name, data) => {
    const { result: r } = await wx.cloud.callFunction({ name, config: { env }, data })
    if (!r || r.success === false || (r.code !== undefined ? r.code !== 0 : r.success !== true)) throw Error(r && r.message || '请求未确认，请停止后回传，不要重跑')
    return r.data === undefined ? r : r.data
  }
  const call = (action, data) => invoke('app-node24', { action, data })
  try {
    const native = await invoke('login-node24', {}), app = getApp().globalData || {}
    const cached = app.currentOpenid || app.userInfo && (app.userInfo.openid || app.userInfo._openid)
    if (!native.openid || native.openid !== cached) throw Error('登录身份未核对，未补建任务')
    const storageKey = 'adjustment_application_setup_v1:' + native.openid
    journal = wx.getStorageSync(storageKey)
    if (!journal || journal.version !== 1 || journal.title !== title || journal.goal_id && journal.goal_id !== goalId) throw Error('本机记录不属于这批目标，未补建任务')
    if (journal.recovery_started) throw Error('已有恢复尝试，请回传上次结果，不重复补建')
    const goal = await call('getGoalDetail', { id: goalId })
    if (goal._id !== goalId || goal._openid !== native.openid || goal.title !== title || goal.status !== 'active') throw Error('云端目标不匹配，未补建任务')
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const add = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
    const start = add(today, 1), first = goal.start_date > start ? goal.start_date : start
    const expected = [0, 1].map(i => ({ title: i ? '[联调] 整理笔记20分钟' : '[联调] 阅读20分钟',
      date: add(first, i), estimated_minutes: 20, xp_reward: 10, stage: 1, goal_id: goalId }))
    if (expected[1].date > goal.end_date || expected[1].date > add(today, 7)) throw Error('这批目标已没有两天可用未来日期，未补建任务')
    const pages = await Promise.all(Array.from({ length: 7 }, (_, i) => call('listTasks', { goal_id: goalId, date: add(start, i) })))
    if (!pages.every(Array.isArray)) throw Error('现有任务读取异常，未补建任务')
    const tasks = pages.flat()
    if (tasks.length > 2 || tasks.some(t => !expected.some(e => t.goal_id === goalId && t.title === e.title && t.date === e.date && t.estimated_minutes === 20 && t.xp_reward === 10 && t.completed === false)) || new Set(tasks.map(t => t.date)).size !== tasks.length) throw Error('目标中已有非预期任务，未补建')
    journal.goal_id = goalId; journal.task_ids = tasks.map(t => t.id)
    journal.recovery_started = Date.now(); journal.stage = 'recovery_checked'
    const persist = () => wx.setStorageSync(storageKey, journal)
    persist() // A storage failure here must stop all task creation.
    for (const task of expected) {
      if (tasks.some(t => t.date === task.date)) continue
      journal.stage = 'before_recover_task_' + createdTasks; persist()
      const result = await call('createTask', task)
      if (!result.id) throw Error('新任务ID未确认，请停止核对')
      createdTasks++; journal.task_ids.push(result.id); journal.stage = 'recovered_' + createdTasks; persist()
    }
    const w = await call('getAdjustmentWorkspace', { goal_id: goalId, date: today })
    if (!w.applicationSupported || !w.snapshot.eligible || !w.snapshot.complete || w.snapshot.tasks.length !== 2 || !w.snapshot.tasks.every(t => journal.task_ids.includes(t.id))) throw Error('补齐后范围仍未通过，请停止回传')
    journal.stage = 'ready'; journal.test_dates = expected.map(t => t.date); persist()
    // Refresh only this already-selected test goal; do not move another workspace.
    const stack = getCurrentPages(), p = stack[stack.length - 1]
    if (p && p.route === 'pages/forest-steward/forest-steward' && p.data.currentGoal && p.data.currentGoal.id === goalId && !p.data.adjustmentBusy && typeof p.loadAdjustment === 'function') await p.loadAdjustment()
    console.log('应用测试恢复', JSON.stringify({ ok: true, title, goalId, taskIds: journal.task_ids,
      createdGoals: 0, createdTasks, futureTasks: w.snapshot.tasks.length, period: [w.snapshot.start, w.snapshot.end], modelCalls: false }))
  } catch (e) {
    console.log('应用测试恢复', JSON.stringify({ ok: false, message: e.message || e.errMsg || '请求未确认',
      stage: journal && journal.stage, goalId, createdGoals: 0, createdTasks, note: '停止后回传，不重复执行准备或恢复脚本' }))
  }
})()
