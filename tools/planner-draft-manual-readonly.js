// Deploy stage 1 first, then run in WeChat Developer Tools Console. No writes/models.
;(async () => {
  try {
    const { result } = await wx.cloud.callFunction({ name: 'app-node24', data: { action: 'getPlannerDraft', data: {} } })
    if (!result || result.code !== 0) throw new Error(result && result.message || '未取得成功回执')
    const data = result.data, draft = data && data.draft
    console.log('规划草案只读检查', JSON.stringify({ ok: true, revision: data.revision, hasDraft: !!draft,
      draftRevision: draft ? draft.revision : null, source: draft ? draft.source : '',
      taskCount: draft ? draft.snapshot.tasks.length : 0,
      stableTaskIds: draft ? draft.snapshot.tasks.every(t => !!t.draft_task_id) : null,
      sourceKinds: draft ? [...new Set(Object.values(draft.context.sources || {}).map(s => s.kind))] : [] }))
  } catch (error) { console.log('规划草案只读检查', JSON.stringify({ ok: false, message: error.message || error.errMsg || '检查失败' })) }
})()
