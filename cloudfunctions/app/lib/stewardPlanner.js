const { createHash } = require('crypto')
const context = require('./plannerContext')
const dates = require('./taskRules')
const { binding, matches } = require('./plannerReviews')
function createGenerator({ cloud, drafts, doGenerate }) {
  const db = cloud.database()
  return async function generate(owner, data, guard) {
    const planId = 'sg_' + createHash('sha256').update(JSON.stringify([owner, data.run_id])).digest('hex')
    const claim = await db.runTransaction(async tx => {
      await guard(tx)
      const table = tx.collection('ai_plans')
      let previous
      try { previous = (await table.doc(planId).get()).data }
      catch (error) {
        if (!String(error.errMsg || error.message || '').includes('document with _id ' + planId + ' does not exist')) throw error
      }
      if (previous) {
        if (previous._openid !== owner || previous.kind !== 'plan_generation' || previous.steward_run_id !== data.run_id) throw Error('规划请求归属不正确')
        if (previous.status === 'pending') return { fresh: true }
        if (previous.status !== 'done' || !previous.result) throw Error(previous.error || '规划结果尚未确认，请保留协作并核查；不自动重复调用模型')
        return { previous }
      }
      const current = await drafts.getInTransaction(owner, tx)
      if (current.revision !== data.expected_revision) throw Error('草案已变化，请查看最新稿后重新开始协作')
      const messages = [{ id: 'steward_demand', role: 'user', content: data.demand }]
      const record = { _openid: owner, kind: 'plan_generation', steward_run_id: data.run_id,
        messages, planState: context.derive(messages).values, provider: '', user_edits: {}, status: 'pending', createdAt: Date.now(),
        draft_meta: { expected_revision: data.expected_revision, conversation_id: data.run_id, start_date: dates.businessDate() } }
      await table.add({ data: { _id: planId, ...record } })
      return { fresh: true }
    })
    let draft
    if (claim.fresh) {
      const response = await doGenerate(owner, { plan_id: planId }, { runId: data.run_id, timeoutMs: 18000, guard })
      if (response.code !== 0) throw Error(response.message || '规划师未完成本步骤')
      if (response.data.draft_error || !response.data.draft) throw Error(response.data.draft_error || '规划稿未能保存到云端')
      draft = response.data.draft
    } else draft = await drafts.saveGenerated(owner, planId, claim.previous, claim.previous.result, guard)
    const current = await drafts.get(owner)
    if (!draft || !current.draft || !matches(binding(draft), binding(current.draft))) throw Error('规划完成后草案已有新版本，请读取最新稿')
    return draft
  }
}
module.exports = { createGenerator }
