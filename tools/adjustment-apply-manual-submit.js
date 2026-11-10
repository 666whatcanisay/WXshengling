// Authorized test batch only: submit the originally confirmed version if needed,
// then verify one same-version replay. No models, creation, checkin or cleanup.
;(async () => {
  const env = 'cloud1-d5gz9j6zh654f4b36'
  const goalId = '10f29c566aede179000384776d3f22e2', title = '[联调] 确认应用-mw526pzz'
  const taskIds = ['76dc6f266aede45a0003e3dd0ddbc28f', '3946422f6aede45a0008ba2e43f78402']
  let replaySent = false, applicationSent = false
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
  const expectedRequest = {"run_id":"adj_d17129fe70a56b39d33b47b061d60ef3c314b94e968affccd19ba7b4075710c3","expected_revision":1,"confirmation":"2bae5bb6f8b960ab1f8a83501f9fb056d52afdd03702767318e6e9f4d7dc7130"}
  try {
    const native = await invoke('login-node24', {}), app = getApp().globalData || {}
    requireOk(native.openid && native.openid === (app.currentOpenid || app.userInfo && (app.userInfo.openid || app.userInfo._openid)), '登录身份不匹配')
    const key = 'adjustment_application_setup_v1:' + native.openid, journal = wx.getStorageSync(key)
    requireOk(journal && journal.goal_id === goalId && journal.title === title && sameIds(journal.task_ids), '本机记录不属于这批测试')
    requireOk(!journal.application_replay_started && !journal.application_submit_and_replay_started, '已有本次提交或回执验证记录，请回传原结果，不重复执行')
    let goal = await call('getGoalDetail', { id: goalId })
    requireOk(goal._id === goalId && goal.title === title && goal._openid === native.openid, '云端目标不匹配')
    const date = '2026-11-06' // The original confirmed run date, not a new draft.
    let w = await call('getAdjustmentWorkspace', { goal_id: goalId, date }), run = w.run
    requireOk(run && run.id === expectedRequest.run_id && run.revision === expectedRequest.expected_revision && run.confirmation === expectedRequest.confirmation && ['awaiting_review','applied'].includes(run.status) && sameIds(run.changes.map(t => t.task_id)) && run.changes.every(t => t.estimated_minutes === 10), '当前不是原确认的第1版，未提交')
    const request = { run_id: run.id, expected_revision: run.revision, confirmation: run.confirmation }
    let first = await call('getAdjustmentApplication', request)
    requireOk(first.application || run.can_apply && run.is_current, '当前来源或规则不允许应用，未提交')
    journal.application_submit_and_replay_started = Date.now(); journal.application_request = request
    wx.setStorageSync(key, journal) // Persist before the first write-capable request.
    if (!first.application) {
      applicationSent = true
      const submitted = await call('applyAdjustment', request)
      first = { application: submitted.application }
    }
    requireOk(first.application && first.application.run_id === request.run_id && first.application.confirmation === request.confirmation && first.application.revision === request.expected_revision && first.application.count === 2 && sameIds(first.application.task_ids), '应用回执不匹配，停止核对')
    w = await call('getAdjustmentWorkspace', { goal_id: goalId, date }); run = w.run
    goal = await call('getGoalDetail', { id: goalId })
    requireOk(run && run.status === 'applied' && signature(run.application) === signature(first.application), '应用后状态待核对')
    requireOk(sameIds(w.snapshot.tasks.map(t => t.id)) && w.snapshot.tasks.every(t => t.estimated_minutes === 10 && t.xp_reward === 10), '正式测试任务与应用结果不匹配')
    journal.application_replay_started = Date.now(); journal.application_request = request
    wx.setStorageSync(key, journal) // Stop before replay if local persistence fails.
    replaySent = true
    const repeated = await call('applyAdjustment', request)
    requireOk(repeated.cached === true && signature(repeated.application) === signature(first.application), '同版回执或缓存标志不一致')
    const after = await call('getAdjustmentWorkspace', { goal_id: goalId, date }), afterGoal = await call('getGoalDetail', { id: goalId })
    requireOk(after.run && signature(after.run.application) === signature(first.application) && signature(after.snapshot.tasks) === signature(w.snapshot.tasks) && signature(afterGoal) === signature(goal), '同版重试后回执或任务/目标发生变化')
    journal.stage = 'application_verified'; journal.application_receipt = first.application; wx.setStorageSync(key, journal)
    const stack = getCurrentPages(), page = stack[stack.length - 1]
    if (page && page.route === 'pages/forest-steward/forest-steward' && page.data.currentGoal && page.data.currentGoal.id === goalId && !page.data.adjustmentBusy) {
      if (page.data.adjustmentPendingApplication) await page.queryAdjustmentApplication(); else await page.loadAdjustment()
    }
    console.log('应用与回执检查', JSON.stringify({ ok: true, goalId, revision: run.revision, appliedTasks: first.application.count, applicationSent, pageReceiptVisible: !!(page && page.data.adjustmentApplicationReceipt),
      sameReceipt: true, replayCached: true, tasksUnchangedByReplay: true, goalUnchangedByReplay: true, modelCalls: false,
      note: '仅应用原确认的2项测试任务并验证同版回执；待Codex核对清理，未调用模型/创建/打卡/发奖励' }))
  } catch (e) {
    console.log('应用与回执检查', JSON.stringify({ ok: false, message: e.message || e.errMsg || '结果未确认', goalId, applicationSent, replaySent,
      note: '停止回传，不重复执行或生成；云端原回执保留供核对' }))
  }
})()
