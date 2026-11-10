// After deployment; reads only. Goal defaults to current coach selection, otherwise first owned goal for inspection.
;(async () => {
  try {
    const call = async (action, data = {}) => {
      const { result } = await wx.cloud.callFunction({ name: 'app-node24', data: { action, data } })
      if (!result || result.code !== 0) throw Error(result && result.message || '检查未成功')
      return result.data
    }
    const goals = await call('getCoachGoals'), pages = getCurrentPages(), page = pages[pages.length - 1], data = page && page.data || {}
    const goal = goals.goals.find(g => g._id === data.coachGoalId) || goals.goals[0]
    let workspace = null
    if (goal) {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
      workspace = await call('getCoachWorkspace', { goal_id: goal._id, date: data.coachDate || today })
    }
    console.log('AI教练只读检查', JSON.stringify({ ok: true, goalsRead: goals.goals.length, goalsComplete: goals.complete, hasGoal: !!workspace,
      period: workspace ? [workspace.facts.start, workspace.facts.end] : null, complete: workspace ? workspace.facts.complete : null,
      pastTasks: workspace ? workspace.facts.past.total : null, completed: workspace ? workspace.facts.past.completed : null,
      todayPending: workspace && workspace.facts.today ? workspace.facts.today.pending : null, feedbackRevision: workspace ? workspace.feedback.revision : null,
      reportStatus: workspace && workspace.report ? workspace.report.status : '' }))
  } catch (error) { console.log('AI教练只读检查', JSON.stringify({ ok: false, message: error.message || error.errMsg || '检查失败' })) }
})()
