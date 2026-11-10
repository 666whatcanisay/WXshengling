// After deployment: native caller read only. No run creation, model or task writes.
;(async () => {
  try {
    const call = async (action, data = {}) => {
      const { result } = await wx.cloud.callFunction({ name: 'app-node24', config: { env: 'cloud1-d5gz9j6zh654f4b36' }, data: { action, data } })
      if (!result || result.code !== 0) throw Error(result && result.message || '检查失败')
      return result.data
    }
    const pages = getCurrentPages(), p = pages[pages.length - 1], d = p && p.data || {}, goals = await call('getCoachGoals')
    const goalId = d.currentGoal && d.currentGoal.id || d.coachGoalId || goals.goals[0] && goals.goals[0]._id
    if (!goalId) return console.log('调整草案只读检查', JSON.stringify({ ok: true, hasGoal: false }))
    const date = d.coachSummaryDate || d.coachDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const w = await call('getAdjustmentWorkspace', { goal_id: goalId, date })
    console.log('调整草案只读检查', JSON.stringify({ ok: true, hasGoal: true, engine: w.engine, execution: w.execution,
      applicationSupported: w.applicationSupported === true, privateProofAbsent: !w.read_proof,
      period: [w.snapshot.start, w.snapshot.end], eligible: w.snapshot.eligible, blockedReason: w.snapshot.blocked_reason,
      complete: w.snapshot.complete, futureTasks: w.snapshot.tasks.length, hasRun: !!w.run, status: w.run && w.run.status || '',
      revision: w.run && w.run.revision, isCurrent: w.run && w.run.is_current, canApply: !!(w.run && w.run.can_apply), hasApplication: !!(w.run && w.run.application) }))
  } catch (e) { console.log('调整草案只读检查', JSON.stringify({ ok: false, message: e.message || e.errMsg || '读取失败' })) }
})()
