// After applying THIS labelled goal in the UI: replay its exact version once.
// Does not perform the first application, model calls, creation or cleanup.
;(async () => {
  const env = 'cloud1-d5gz9j6zh654f4b36'
  const goalId = '10f29c566aede179000384776d3f22e2', title = '[联调] 确认应用-mw526pzz'
  const taskIds = ['76dc6f266aede45a0003e3dd0ddbc28f', '3946422f6aede45a0008ba2e43f78402']
  let replaySent = false
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v
  const signature = v => JSON.stringify(stable(JSON.parse(JSON.stringify(v))))
  const sameIds = ids => Array.isArray(ids) && signature([...ids].sort()) === signature([...taskIds].sort())
  const requireOk = (ok, message) => { if (!ok) throw Error(message) }
  const invoke = async (name, data) => {
    const { result: r } = await wx.cloud.callFunction({ name, config: { env }, data })
    requireOk(r && r.success !== false && (r.code !== undefined ? r.code === 0 : r.success === true), r && r.message || '请求未确认，请停止回传')
    return r.data === undefined ? r : r.data
  }
  const call = (action, data) => invoke('app-node24', { action, data })
  try {
    const native = await invoke('login-node24', {}), app = getApp().globalData || {}
    requireOk(native.openid && native.openid === (app.currentOpenid || app.userInfo && (app.userInfo.openid || app.userInfo._openid)), '登录身份不匹配')
    const key = 'adjustment_application_setup_v1:' + native.openid, journal = wx.getStorageSync(key)
    requireOk(journal && journal.goal_id === goalId && journal.title === title && sameIds(journal.task_ids), '本机记录不属于这批测试')
    requireOk(!journal.application_replay_started, '已有本轮回执验证记录，请回传原结果，不重复执行')
    const goal = await call('getGoalDetail', { id: goalId })
    requireOk(goal._id === goalId && goal.title === title && goal._openid === native.openid, '云端目标不匹配')
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const w = await call('getAdjustmentWorkspace', { goal_id: goalId, date }), run = w.run
    requireOk(run && run.status === 'applied' && run.application && run.revision === 1 && sameIds(run.application.task_ids) && sameIds(run.changes.map(t => t.task_id)) && run.changes.every(t => t.estimated_minutes === 10), '请先在本批目标确认应用第1版；本脚本不会首次应用')
    const request = { run_id: run.id, expected_revision: run.revision, confirmation: run.confirmation }
    const first = await call('getAdjustmentApplication', request)
    requireOk(first.application && signature(first.application) === signature(run.application), '原回执不一致')
    requireOk(sameIds(w.snapshot.tasks.map(t => t.id)) && w.snapshot.tasks.every(t => t.estimated_minutes === 10 && t.xp_reward === 10), '正式测试任务与应用结果不匹配')
    journal.application_replay_started = Date.now(); journal.application_request = request
    wx.setStorageSync(key, journal) // Stop before replay if local persistence fails.
    replaySent = true
    const repeated = await call('applyAdjustment', request)
    requireOk(repeated.cached === true && signature(repeated.application) === signature(first.application), '同版回执或缓存标志不一致')
    const after = await call('getAdjustmentWorkspace', { goal_id: goalId, date }), afterGoal = await call('getGoalDetail', { id: goalId })
    requireOk(after.run && signature(after.run.application) === signature(first.application) && signature(after.snapshot.tasks) === signature(w.snapshot.tasks) && signature(afterGoal) === signature(goal), '同版重试后回执或任务/目标发生变化')
    journal.stage = 'application_verified'; journal.application_receipt = first.application; wx.setStorageSync(key, journal)
    console.log('应用回执检查', JSON.stringify({ ok: true, goalId, revision: run.revision, appliedTasks: first.application.count,
      sameReceipt: true, replayCached: true, tasksUnchangedByReplay: true, goalUnchangedByReplay: true, modelCalls: false,
      note: '仅重试本批已应用第1版；待Codex核对清理，未创建/打卡/发奖励' }))
  } catch (e) {
    console.log('应用回执检查', JSON.stringify({ ok: false, message: e.message || e.errMsg || '结果未确认', goalId, replaySent,
      note: '停止回传，不重复执行或生成；云端原回执保留供核对' }))
  }
})()
