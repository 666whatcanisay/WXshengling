// Run after stage 2 deployment in WeChat Developer Tools Console. Reads only.
;(async () => {
  try {
    const call = async (action, data) => {
      const { result } = await wx.cloud.callFunction({ name: 'app-node24', data: { action, data } })
      if (!result || result.code !== 0) throw new Error(result && result.message || '未取得成功回执')
      return result.data
    }
    const current = await call('getPlannerDraft', {})
    const reports = await Promise.all(['rules', 'ai'].map(async mode => {
      const data = await call('getPlannerReview', { mode }), r = data.review
      return { mode, rulesVersion: data.rules_version, hasResult: !!r, status: r ? r.status : '',
        draftRevision: r ? r.binding.revision : null, isCurrent: r ? r.is_current : null,
        ruleProblems: r ? r.rules.error_count : null, ruleWarnings: r ? r.rules.warning_count : null,
        semanticSuggestions: r && r.semantic ? r.semantic.findings.length : null }
    }))
    console.log('规划审核只读检查', JSON.stringify({ ok: true, hasDraft: !!current.draft, revision: current.revision, reports }))
  } catch (error) { console.log('规划审核只读检查', JSON.stringify({ ok: false, message: error.message || error.errMsg || '检查失败' })) }
})()
