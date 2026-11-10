// After deployment, paste into WeChat Developer Tools Console. No writes/models.
;(async () => {
  try {
    const { result } = await wx.cloud.callFunction({ name: 'app-node24', data: { action: 'getStewardRun', data: {} } })
    if (!result || result.code !== 0) throw Error(result && result.message || '协作接口未返回成功')
    const data = result.data, run = data.run
    console.log('森林管家只读检查', JSON.stringify({ ok: true, engine: data.engine, execution: data.execution,
      hasRun: !!run, status: run ? run.status : '', next: run ? run.next : '',
      draftRevision: run ? run.draft_revision : null, isCurrent: run ? run.is_current : null,
      steps: run ? run.steps.map(step => ({ role: step.name, status: step.status })) : [],
      rulesDone: !!(run && run.rules && run.rules.status === 'done'), aiDone: !!(run && run.review && run.review.status === 'done') }))
  } catch (error) { console.log('森林管家只读检查', JSON.stringify({ ok: false, message: error.message || error.errMsg || '检查失败' })) }
})()
