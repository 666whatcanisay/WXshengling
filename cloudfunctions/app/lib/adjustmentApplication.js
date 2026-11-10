const rules = require('./adjustmentRules'), dates = require('./taskRules'), proof = require('./recordProof')
function createApplication({ db, doc, read, put, owned, collect, runKey, headKey, confirmation, now }) {
  function exact(row, data) {
    if (!Number.isSafeInteger(data.expected_revision) || data.expected_revision < 1 || row.revision !== data.expected_revision || data.confirmation !== confirmation(row)) throw Error('确认版本不一致，请刷新核对；未应用')
  }
  async function current(owner, row) {
    const evidence = await collect(owner, row)
    if (evidence.fingerprint !== row.source_fingerprint || !evidence.snapshot.eligible || !evidence.snapshot.complete || row.snapshot.business_date !== dates.businessDate(now())) throw Error('任务、反馈或日期已变化，请重新生成调整；未应用')
    return evidence
  }
  async function active(owner, row, c) {
    const head = await read(c, owner, headKey(row))
    if (!head || head.id !== row.id || !['awaiting_review', 'ready', 'failed'].includes(row.status) || !row.changes) throw Error('调整已取消、被替代或仍在处理中；未应用')
  }
  async function check(owner, data) {
    const old = await owned(owner, data.run_id); exact(old, data)
    await current(owner, old)
    return db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), row = await owned(owner, data.run_id, c); exact(row, data)
      await active(owner, row, c)
      row.ruleReport = rules.check(row.snapshot, rules.changes(row.changes, row.snapshot), rules.requirements(row.requirements))
      row.steps.rules = { status: 'done', update: { rule_errors: row.ruleReport.error_count } }
      if (!row.semantic) row.steps.review = { status: 'skipped' }
      row.status = 'awaiting_review'; row.next = ''; row.updated_at = now()
      await put(c, owner, runKey(row.id), row); return row
    })
  }
  async function status(owner, data) {
    const row = await owned(owner, data.run_id); exact(row, data)
    return { application: row.application || null, status: row.status }
  }
  async function apply(owner, data) {
    const old = await owned(owner, data.run_id); exact(old, data)
    // A committed receipt is authoritative, even after another day/task edit.
    if (old.application) return { application: old.application, cached: true }
    const evidence = await current(owner, old)
    const references = [...new Map(evidence.read_proof.map(r => [r.collection + '/' + r.id, r])).values()]
    if (references.length > 100) throw Error('本轮来源记录超过100条事务校验范围，暂不能应用；未修改任务')
    return db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), row = await owned(owner, data.run_id, c); exact(row, data)
      if (row.application) return { application: row.application, cached: true }
      await active(owner, row, c)
      if (row.status !== 'awaiting_review' || !row.ruleReport || row.ruleReport.version !== rules.VERSION || row.ruleReport.error_count !== 0) throw Error('请先完成当前版本的规则检查；未应用')
      if (dates.businessDate(now()) !== row.snapshot.business_date) throw Error('已跨日，请刷新重新调整；未应用')
      // Only known document IDs are allowed in CloudBase transactions. Re-check
      // the complete bounded preflight read set against the transaction snapshot.
      // Await each request on this transaction. The native wx path returned
      // TransactionBusy when the read set was dispatched concurrently.
      for (const ref of references) {
        const latest = await doc(tx.collection(ref.collection), ref.id)
        if (proof.digest(latest) !== ref.digest) throw Error('来源在确认时发生变化，请刷新；整批未应用')
      }
      const changes = rules.changes(row.changes, row.snapshot), checked = rules.check(row.snapshot, changes, rules.requirements(row.requirements))
      if (!changes.length || checked.error_count) throw Error('没有有效变更或规则未通过；未应用')
      const at = now(), receipt = { id: 'apply_' + rules.fingerprint([owner, row.id, data.confirmation]), run_id: row.id, goal_id: row.goal_id,
        revision: row.revision, confirmation: data.confirmation, applied_at: at, task_ids: changes.map(t => t.task_id), count: changes.length }
      // All task updates and this receipt commit together. No rewards, new tasks,
      // goal counters, history or model calls are part of this operation.
      for (const change of changes) {
        const result = await tx.collection('tasks').doc(change.task_id).update({ data: { title: change.title, date: change.date,
          estimated_minutes: change.estimated_minutes, updated_at: at } })
        if (!result.stats || result.stats.updated !== 1) throw Error('任务更新未确认；整批未应用')
      }
      if (dates.businessDate(now()) !== row.snapshot.business_date) throw Error('确认期间已跨日；整批未应用')
      // A real write on the goal fences a concurrent close/delete under snapshot
      // isolation; reading the goal alone would not acquire a write conflict.
      const goalWrite = await tx.collection('goals').doc(row.goal_id).update({ data: { last_task_adjustment_at: at } })
      if (!goalWrite.stats || goalWrite.stats.updated !== 1) throw Error('目标状态未确认；整批未应用')
      row.application = receipt; row.status = 'applied'; row.next = ''; row.token = ''; row.updated_at = at
      await put(c, owner, runKey(row.id), row)
      return { application: receipt, cached: false }
    })
  }
  return { apply, check, status }
}
module.exports = { createApplication }
