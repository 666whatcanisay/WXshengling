// One explicitly initiated feedback save on the currently selected coach goal.
// Adds a visible test marker; no model requests, goal/task/reward changes or secret output.
;(async () => {
  try {
    const pages = getCurrentPages(), page = pages[pages.length - 1], d = page && page.data
    if (!page || page.route !== 'pages/ai/ai' || d.mode !== 'coach' || !d.coachGoalId) throw Error('请先进入AI教练并选择要检查的目标')
    if (d.coachEvidenceLoading || d.coachCloudSaving || d.coachCloudDirty || d.coachCloudConflict || d.coachFeedbackReadError || d.coachCloudRevision === null) throw Error('请先核对并同步现有反馈，本脚本未修改内容')
    const goalId = d.coachGoalId, date = d.coachDate, revision = d.coachCloudRevision
    const marker = '[联调检查：反馈失效-' + Date.now() + ']'
    const next = (d.coachNote || '') + '\n' + marker
    if (next.length > 500) throw Error('备注接近500字，请先保留原文；本脚本未修改内容')
    page.onCoachNote({ detail: { value: next } })
    if (page.data.coachNote !== next || !page.data.coachCloudDirty) throw Error('页面输入未接受修改，已停止，未提交云保存')
    await page.saveCoachCloudFeedback()
    if (page.data.coachGoalId !== goalId || page.data.coachDate !== date) throw Error('页面目标或日期已变化，请先核对保存状态')
    const { result: r } = await wx.cloud.callFunction({ name: 'app-node24', config: { env: 'cloud1-d5gz9j6zh654f4b36' },
      data: { action: 'getCoachWorkspace', data: { goal_id: goalId, date } } })
    if (!r || r.code !== 0) throw Error(r && r.message || '保存后的云端读取未确认，请勿重复运行')
    const w = r.data
    console.log('反馈失效检查', JSON.stringify({ ok: w.feedback.revision > revision && w.feedback.values.note === next && !w.report,
      previousRevision: revision, cloudRevision: w.feedback.revision, markerSaved: w.feedback.values.note === next,
      oldReportAbsent: !w.report, localDirty: page.data.coachCloudDirty, saveError: page.data.coachCloudError || '',
      modelCalls: false, note: '本次已请求保存一行联调标记；未修改任务或奖励' }))
  } catch (e) { console.log('反馈失效检查', JSON.stringify({ ok: false, message: e.message || e.errMsg || '检查未确认，请先核对状态，不要连续重跑' })) }
})()
