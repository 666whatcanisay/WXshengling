// Reads the current page and the same cloud workspace; no writes or model calls.
;(async () => {
  try {
    const pages = getCurrentPages(), page = pages[pages.length - 1], d = page && page.data || {}
    if (!page || !/forest-steward/.test(page.route) || !d.currentGoal) throw Error('请在森林管家选择目标后运行')
    const coach = pages.find(p => p.route === 'pages/ai/ai'), c = coach && coach.data || {}
    const date = d.coachSummaryDate || d.today
    const { result: r } = await wx.cloud.callFunction({ name: 'app-node24', config: { env: 'cloud1-d5gz9j6zh654f4b36' },
      data: { action: 'getCoachWorkspace', data: { goal_id: d.currentGoal.id, date } } })
    if (!r || r.code !== 0) throw Error(r && r.message || '云端检查失败')
    const w = r.data
    console.log('管家复盘定位', JSON.stringify({ tab: d.resultTab, goalTitle: d.currentGoal.title,
      sameGoalAsCoach: c.coachGoalId ? c.coachGoalId === d.currentGoal.id : null,
      sameDateAsCoach: c.coachDate ? c.coachDate === date : null,
      period: [w.facts.start, w.facts.end], feedbackRevision: w.feedback.revision,
      pageReport: d.coachSummary && d.coachSummary.report ? d.coachSummary.report.status : '',
      cloudReport: w.report ? w.report.status : '', pageFingerprintMatches: !!(d.coachSummary && d.coachSummary.fingerprint === w.fingerprint),
      pageError: d.coachSummaryError || '', loading: d.coachSummaryLoading }))
  } catch (e) { console.log('管家复盘定位', JSON.stringify({ ok: false, message: e.message || e.errMsg || '检查失败' })) }
})()
