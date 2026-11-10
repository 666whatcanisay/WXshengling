const { createHash } = require('crypto')
const rules = require('./plannerReviewRules')
const lease = require('./modelRunLease')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => { throw new Error(message) }
const identifier = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value)
function binding(draft) {
  return { draft_id: draft.id, revision: draft.revision, fingerprint: draft.fingerprint,
    requirements_revision: draft.context.revision, rules_version: rules.VERSION }
}
function matches(left, right) {
  return ['draft_id', 'revision', 'fingerprint', 'requirements_revision', 'rules_version'].every(key => left[key] === right[key])
}
function createService({ cloud, drafts, loadModel, callModel, now = Date.now }) {
  const db = cloud.database()
  const recordId = (owner, target, mode) => 'planner_review_' + hash([owner, target.draft_id, target.revision,
    target.fingerprint, target.requirements_revision, target.rules_version, mode])
  async function read(table, id) {
    try { return (await table.doc(id).get()).data || null }
    catch (error) {
      if (String(error && (error.errMsg || error.message) || '').includes('document with _id ' + id + ' does not exist')) return null
      throw error
    }
  }
  function view(row, current) {
    if (!row) return null
    const currentBinding = current.draft && binding(current.draft)
    const expired = lease.expired(row, now())
    const status = expired ? 'failed' : row.status
    return { id: row._id, mode: row.mode, binding: row.binding, status, attempt: row.attempt,
      is_current: !!currentBinding && matches(row.binding, currentBinding), rules: row.rules || null,
      semantic: row.semantic || null, model: row.model || null,
      error: expired ? '上次审核中断，未收到有效结果。' : row.error || '', updated_at: row.updated_at,
      retry_available: status === 'failed' && row.attempt < 3 }
  }
  function validate(data, requireTarget) {
    if (!['rules', 'ai'].includes(data.mode)) fail('请选择规则检查或AI审核')
    if (requireTarget && (!identifier(data.request_id) || !data.binding || !identifier(data.binding.draft_id) ||
        !Number.isSafeInteger(data.binding.revision) || data.binding.revision < 1 || !Number.isSafeInteger(data.binding.requirements_revision) ||
        !/^[a-f0-9]{64}$/.test(data.binding.fingerprint || '') || data.binding.rules_version !== rules.VERSION)) fail('草案审核标识或规则版本不正确，请刷新')
  }
  function assertOwner(row, openid) {
    if (row && (row._openid !== openid || row.kind !== 'planner_review')) fail('审核记录归属异常')
  }
  async function get(openid, data = {}) {
    if (!openid) fail('请先登录')
    validate(data, false)
    const current = await drafts.get(openid)
    const target = data.binding || (current.draft && binding(current.draft))
    if (!target) return { review: null, rules_version: rules.VERSION }
    // No caller-provided record ID or owner is used to retrieve private records.
    const row = await read(db.collection('ai_plans'), recordId(openid, target, data.mode))
    assertOwner(row, openid)
    return { review: view(row, current), rules_version: rules.VERSION }
  }
  async function review(openid, data = {}) {
    if (!openid) fail('请先登录')
    validate(data, true)
    const target = Object.fromEntries(['draft_id', 'revision', 'fingerprint', 'requirements_revision', 'rules_version'].map(key => [key, data.binding[key]]))
    const id = recordId(openid, target, data.mode)
    const claimed = await db.runTransaction(async tx => {
      const current = await drafts.getInTransaction(openid, tx)
      if (!current.draft || !matches(target, binding(current.draft))) fail('草案已有变化，请保存并读取最新稿后重新检查')
      const table = tx.collection('ai_plans'), row = await read(table, id)
      assertOwner(row, openid)
      const at = now()
      const requests = row ? row.request_ids || [row.request_id] : []
      if (row && (requests.includes(data.request_id) || row.status !== 'failed' && !lease.expired(row, at))) return { cached: view(row, current) }
      if (row && row.attempt >= 3) fail('这版草案已达到3次失败尝试，请先检查配置或稍后调整草案')
      const calculated = rules.check(current.draft)
      const next = { _openid: openid, kind: 'planner_review', mode: data.mode, binding: target,
        status: data.mode === 'rules' ? 'done' : 'running', request_id: data.request_id,
        request_ids: [...requests, data.request_id], lease_until: data.mode === 'ai' ? at + lease.LEASE_MS : 0,
        attempt: (row ? row.attempt : 0) + 1, rules: calculated, semantic: null, model: null, error: '', updated_at: at }
      if (row) {
        const saved = await table.doc(id).update({ data: { ...next, binding: db.command.set(target), rules: db.command.set(calculated) } })
        if (!saved.stats || saved.stats.updated !== 1) fail('审核请求未能保存')
      } else await table.add({ data: { _id: id, ...next } })
      return { row: { _id: id, ...next }, draft: current.draft }
    })
    if (claimed.cached) return { review: claimed.cached, cached: true }
    if (data.mode === 'rules') return { review: view(claimed.row, { draft: claimed.draft }) }
    let semantic = null, model = null, error = ''
    try {
      const config = await loadModel(openid)
      model = { provider: config.provider, name: config.model }
      const raw = await callModel(config, rules.messages(claimed.draft, claimed.row.rules))
      semantic = rules.parseModel(raw, claimed.draft)
    } catch (e) { error = String(e && e.message || 'AI审核失败，请检查配置或稍后手动重试').slice(0, 500) }
    return db.runTransaction(async tx => {
      const table = tx.collection('ai_plans'), row = await read(table, id)
      assertOwner(row, openid)
      if (!row || row.status !== 'running' || row.request_id !== data.request_id) fail('审核状态已变化，请刷新结果')
      const current = await drafts.getInTransaction(openid, tx)
      const at = now()
      if (lease.expired(row, at)) return { review: view(row, current) }
      const patch = { status: error ? 'failed' : 'done', semantic, model, error, lease_until: 0, updated_at: at }
      const saved = await table.doc(id).update({ data: { ...patch,
        ...(semantic ? { semantic: db.command.set(semantic) } : {}), ...(model ? { model: db.command.set(model) } : {}) } })
      if (!saved.stats || saved.stats.updated !== 1) fail('审核结果未能保存，请刷新查询原请求')
      return { review: view({ ...row, ...patch }, current) }
    })
  }
  async function getInTransaction(openid, data, tx) {
    const row = await read(tx.collection('ai_plans'), recordId(openid, data.binding, data.mode))
    assertOwner(row, openid)
    return row && matches(row.binding, data.binding) ? row : null
  }
  return { get, review, getInTransaction }
}
module.exports = { createService, binding, matches }
