const { createHash, randomUUID } = require('crypto')
const context = require('./plannerContext')
const { binding, matches } = require('./plannerReviews')
const rules = require('./plannerReviewRules')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => { throw Error(message) }
const identifier = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value)
const LABELS = { manager: '森林管家', planner: 'AI规划师', rules: '规则检查', review: 'AI审核师' }
function createService({ cloud, drafts, reviews, generate, graphFactory, now = Date.now }) {
  const db = cloud.database(), key = (owner, id) => 'forest_' + hash([owner, id])
  async function read(table, owner, id) {
    const docId = key(owner, id)
    let row
    try { row = (await table.doc(docId).get()).data || null }
    catch (error) {
      if (String(error.errMsg || error.message || '').includes('document with _id ' + docId + ' does not exist')) return null
      throw error
    }
    if (row && (row._openid !== owner || row.kind !== 'forest_state' || row.logical_id !== id)) fail('协作记录归属异常')
    return row && row.payload
  }
  async function put(table, owner, id, payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 400000) fail('协作记录超出本阶段大小限制')
    const existing = await read(table, owner, id)
    if (existing) {
      const saved = await table.doc(key(owner, id)).update({ data: { payload: db.command.set(payload) } })
      if (!saved.stats || saved.stats.updated !== 1) fail('协作状态未能保存')
    } else await table.add({ data: { _id: key(owner, id), _openid: owner, kind: 'forest_state', logical_id: id, payload } })
  }
  const runKey = id => 'run/' + id
  const targetOf = row => row.handoff || (row.state.draft_id ? {
    draft_id: row.state.draft_id, revision: row.state.revision, fingerprint: row.state.fingerprint,
    requirements_revision: row.state.requirements_revision, rules_version: row.state.rules_version
  } : null)
  async function getHandoff(tx, owner, ref) {
    const reject = message => { throw Object.assign(new Error(message), { stewardRejected: true }) }
    if (!ref || !identifier(ref.run_id) || !ref.binding) reject('请重新打开管家协作稿')
    const table = tx.collection('ai_plans')
    const head = await read(table, owner, 'head')
    const row = await read(table, owner, runKey(ref.run_id))
    if (!head || head.run_id !== ref.run_id || !row || row.status !== 'awaiting_confirmation') reject('协作状态已变化，请在管家刷新')
    const current = await drafts.getInTransaction(owner, tx)
    const target = targetOf(row)
    if (!target || !current.draft || !matches(target, ref.binding) || !matches(target, binding(current.draft))) reject('草案版本已变化，请在管家核对当前稿')
    return { table, row, draft: current.draft }
  }
  function saveDraft(owner, data) {
    return drafts.save(owner, data, null, async (tx, ref, saved) => {
      const { table, row, draft } = await getHandoff(tx, owner, ref)
      if (saved.conversation_id !== draft.conversation_id || saved.source_plan_id !== draft.source_plan_id) fail('来源计划已变化，请重新开始协作')
      row.handoff = binding(saved)
      row.updated_at = now()
      await put(table, owner, runKey(row.id), row)
    })
  }
  async function claimPublication(tx, owner, ref, publication, normalize) {
    const { table, row, draft } = await getHandoff(tx, owner, ref)
    const reject = message => { throw Object.assign(new Error(message), { stewardRejected: true }) }
    if (draft.source_plan_id !== publication.source_plan_id) reject('发布来源与当前协作稿不一致')
    let snapshot
    try { snapshot = normalize(draft.snapshot) } catch (error) { reject(error.message) }
    if (JSON.stringify(snapshot) !== JSON.stringify(publication.draft)) reject('确认内容与云端稿不一致，请保存新版再发布')
    const report = rules.check(draft)
    if (report.error_count) reject(report.findings.find(finding => finding.severity === 'error').message)
    const checked = await reviews.getInTransaction(owner, { mode: 'rules', binding: ref.binding }, tx)
    if (!checked || checked.status !== 'done') reject('请先完成这一版的规则检查')
    await drafts.touchForPublication(owner, tx)
    row.status = 'publication_pending'
    row.publication = { record_id: publication._id, title: snapshot.goal.title }
    row.updated_at = now()
    await put(table, owner, runKey(row.id), row)
  }
  async function hasActiveHandoff(table, owner, draft) {
    const head = await read(table, owner, 'head')
    const row = head && await read(table, owner, runKey(head.run_id))
    const target = row && targetOf(row)
    return !!target && matches(target, binding(draft)) &&
      ['ready', 'running', 'awaiting_confirmation', 'publication_pending', 'published'].includes(row.status)
  }
  async function checkStandaloneSave(tx, owner, input) {
    const current = await drafts.getInTransaction(owner, tx)
    if (!current.draft) return
    const sameSource = !!input.source_plan_id && input.source_plan_id === current.draft.source_plan_id
    if ((sameSource || current.draft.conversation_id === input.conversation_id) &&
        await hasActiveHandoff(tx.collection('ai_plans'), owner, current.draft)) fail('请从森林管家打开此草案后保存')
  }
  async function requiresHandoff(tx, owner, sourceId, snapshot, revision, normalize) {
    const current = await drafts.getInTransaction(owner, tx)
    if (!current.draft) return false
    const draft = current.draft
    let sameSnapshot = false
    try { sameSnapshot = JSON.stringify(normalize(draft.snapshot)) === JSON.stringify(snapshot) } catch (_) {}
    const sameSource = !!sourceId && sourceId === draft.source_plan_id
    const sameRevision = !sourceId && !draft.source_plan_id && revision === draft.revision
    if (!sameSnapshot && !sameSource && !sameRevision) return false
    if (await hasActiveHandoff(tx.collection('ai_plans'), owner, draft)) return true
    await drafts.touchForPublication(owner, tx)
    return false
  }
  async function finishPublication(tx, owner, ref, recordId, receipt) {
    const table = tx.collection('ai_plans')
    const row = await read(table, owner, runKey(ref.run_id))
    if (!row || row.status !== 'publication_pending' || row.publication?.record_id !== recordId) fail('发布与协作记录不一致')
    row.status = 'published'
    row.publication.receipt = receipt
    row.updated_at = now()
    await put(table, owner, runKey(row.id), row)
  }
  async function active(tx, owner, id, token) {
    const row = await read(tx.collection('ai_plans'), owner, runKey(id))
    if (!row || row.status !== 'running' || row.token !== token || row.lease_until <= now()) fail('协作已暂停、取消或由新请求接手')
    return row
  }
  async function view(owner, row, activeRun = true) {
    if (!row) return null
    const target = targetOf(row)
    const hasPublication = ['publication_pending', 'published'].includes(row.status)
    const current = hasPublication ? {} : await drafts.get(owner)
    const isCurrent = !!target && !!current.draft && matches(target, binding(current.draft))
    const reports = isCurrent ? await Promise.all(['rules', 'ai'].map(mode => reviews.get(owner, { mode, binding: target }))) : []
    let pendingPublication
    if (row.status === 'publication_pending') {
      const record = (await db.collection('ai_plans').doc(row.publication.record_id).get()).data
      if (!record || record._openid !== owner || record.kind !== 'plan_publication' || record.steward?.run_id !== row.id) fail('原确认记录暂不可用，请刷新')
      if (record.status === 'publication_done') {
        const finished = await read(db.collection('ai_plans'), owner, runKey(row.id))
        if (finished?.status === 'published') return view(owner, finished, activeRun)
      }
      if (record.status !== 'publication_pending') fail('请刷新核对最新发布回执')
      pendingPublication = { publication_id: record.request_id, source_plan_id: record.source_plan_id,
        cloud_draft_revision: record.steward.binding.revision, steward: record.steward, ...record.draft }
    }
    const note = row.status === 'published' ? '发布回执已确认，可以查看正式目标。'
      : row.status === 'publication_pending' ? '已保留原确认稿，可以继续核对发布。'
      : isCurrent && row.handoff && !reports[0]?.review ? '当前草案已保存，请检查这一版。' : row.state.note || ''
    return { id: row.id, mode: row.mode, demand: row.demand, status: row.status, next: row.next || '', note,
      error: row.error || '', can_recover: row.status === 'failed' || row.status === 'running' && row.lease_until <= now(),
      is_current: isCurrent, draft_revision: target ? target.revision : null,
      draft_title: hasPublication ? row.publication.title : isCurrent ? current.draft.snapshot.goal.title : '',
      ...(activeRun && isCurrent && row.status === 'awaiting_confirmation' ? { handoff: { run_id: row.id, binding: target } } : {}),
      ...(pendingPublication ? { pending_publication: pendingPublication } : {}),
      ...(row.status === 'published' ? { publication_receipt: row.publication.receipt } : {}),
      steps: Object.entries(LABELS).map(([name, label]) => ({ name, label, status: row.steps[name] ? row.steps[name].status :
        name === 'planner' && row.mode === 'draft' || name === 'review' && row.state.rule_errors > 0 ? 'skipped' : 'waiting',
        ...(row.steps[name] ? { started_at: row.steps[name].started_at, finished_at: row.steps[name].finished_at || null } : {}) })),
      rules: reports[0] ? reports[0].review : null, review: reports[1] ? reports[1].review : null, updated_at: row.updated_at }
  }
  async function get(owner, data = {}) {
    if (!owner) fail('请先登录')
    if (data.run_id && !identifier(data.run_id)) fail('协作标识不正确')
    const table = db.collection('ai_plans'), head = await read(table, owner, 'head')
    const row = await read(table, owner, runKey(data.run_id || (head && head.run_id) || 'none'))
    return { run: await view(owner, row, !!head && head.run_id === row?.id), engine: 'langgraph-1.6.1', execution: 'foreground-resumable' }
  }
  async function start(owner, data) {
    if (!owner) fail('请先登录')
    if (!identifier(data.request_id) || !['new', 'draft'].includes(data.mode) || !Number.isSafeInteger(data.expected_revision) || data.expected_revision < 0) fail('协作请求或草案版本不正确')
    const demand = data.mode === 'new' && typeof data.demand === 'string' ? data.demand.trim() : ''
    if (data.mode === 'new' && (!demand || demand.length > 1200 || !context.derive([{ role: 'user', content: demand }]).values.what)) fail('请明确想完成的目标；也可先到规划师聊清楚')
    const id = 'run_' + hash([owner, data.request_id]), requestHash = hash([data.mode, demand, data.expected_revision])
    const row = await db.runTransaction(async tx => {
      const table = tx.collection('ai_plans'), old = await read(table, owner, runKey(id))
      if (old) { if (old.request_hash !== requestHash) fail('同一个协作请求不能替换内容'); return old }
      const head = await read(table, owner, 'head'), previous = head && await read(table, owner, runKey(head.run_id))
      if (previous && ['ready', 'running', 'publication_pending'].includes(previous.status)) fail('已有协作进行中，请先继续或核对发布')
      const current = await drafts.getInTransaction(owner, tx)
      if (current.revision !== data.expected_revision) fail('草案版本已变化，请刷新后开始')
      if (data.mode === 'draft' && !current.draft) fail('还没有云端草案，请先去规划师保存')
      if (data.mode === 'draft') await drafts.touchForPublication(owner, tx)
      const ref = data.mode === 'draft' ? binding(current.draft) : {}
      const state = { mode: data.mode, demand, base_revision: current.revision, route: '', draft_id: ref.draft_id || '',
        revision: ref.revision || 0, fingerprint: ref.fingerprint || '', requirements_revision: ref.requirements_revision || 0,
        rules_version: rules.VERSION, rule_errors: 0, note: '' }
      const row = { id, request_hash: requestHash, mode: data.mode, demand, status: 'ready', next: 'manager', state, steps: {}, updated_at: now() }
      await put(table, owner, runKey(id), row); await put(table, owner, 'head', { run_id: id })
      return row
    })
    return { run: await view(owner, row) }
  }
  async function cancel(owner, data) {
    if (!owner || !identifier(data.run_id)) fail('协作身份或标识不正确')
    const row = await db.runTransaction(async tx => {
      const table = tx.collection('ai_plans'), row = await read(table, owner, runKey(data.run_id))
      if (!row) fail('协作不存在')
      if (['publication_pending', 'published'].includes(row.status)) return row
      row.status = 'cancelled'; row.token = ''; row.updated_at = now()
      for (const step of Object.values(row.steps)) if (step.status === 'running') step.status = 'interrupted'
      await put(table, owner, runKey(row.id), row); return row
    })
    return { run: await view(owner, row) }
  }
  async function step(owner, data) {
    if (!owner || !identifier(data.run_id) || !identifier(data.request_id)) fail('协作身份或请求标识不正确')
    const token = randomUUID()
    const claimed = await db.runTransaction(async tx => {
      const table = tx.collection('ai_plans'), row = await read(table, owner, runKey(data.run_id))
      if (!row) fail('协作不存在')
      const head = await read(table, owner, 'head')
      if (!head || head.run_id !== row.id) fail('已有更新的协作，请刷新工作区')
      if ((row.step_requests || []).includes(data.request_id)) return { cached: row }
      if (['cancelled', 'awaiting_confirmation', 'publication_pending', 'published'].includes(row.status) || row.status === 'running' && row.lease_until > now() || row.status === 'failed' && data.recover !== true) return { cached: row }
      if ((row.step_requests || []).length >= 20) fail('本次协作恢复次数过多，请保留状态后核查')
      row.step_requests = [...(row.step_requests || []), data.request_id]
      row.status = 'running'; row.token = token; row.lease_until = now() + 60000; row.error = ''; row.updated_at = now()
      await put(table, owner, runKey(row.id), row); return { row }
    })
    if (claimed.cached) return { run: await view(owner, claimed.cached), cached: true }
    const row = claimed.row, id = row.id
    const transact = fn => db.runTransaction(async tx => { await active(tx, owner, id, token); return fn(tx.collection('ai_plans'), tx) })
    const checkpointKey = suffix => 'graph/' + id + '/' + suffix
    const port = {
      async read(checkpointId) {
        const table = db.collection('ai_plans'), head = checkpointId ? null : await read(table, owner, checkpointKey('head'))
        const selected = checkpointId || (head && head.id)
        if (!selected) return null
        const saved = await read(table, owner, checkpointKey('checkpoint/' + selected))
        if (!saved) fail('检查点缺失，请保留协作状态后核查')
        return { id: selected, saved, writes: await read(table, owner, checkpointKey('writes/' + selected)) || [] }
      },
      put: (checkpointId, saved) => transact(async table => {
        await put(table, owner, checkpointKey('checkpoint/' + checkpointId), saved)
        const head = await read(table, owner, checkpointKey('head'))
        if (!head || checkpointId > head.id) await put(table, owner, checkpointKey('head'), { id: checkpointId })
      }),
      writes: (checkpointId, entries) => transact(async table => {
        const writes = await read(table, owner, checkpointKey('writes/' + checkpointId)) || []
        for (const entry of entries) {
          const index = writes.findIndex(w => w.task === entry.task && w.index === entry.index)
          if (index < 0) writes.push(entry); else if (entry.index < 0) writes[index] = entry
        }
        if (writes.length > 100) fail('检查点中间写入过多')
        await put(table, owner, checkpointKey('writes/' + checkpointId), writes)
      })
    }
    const assertDraft = async state => {
      const current = await drafts.get(owner)
      const expected = { draft_id: state.draft_id, revision: state.revision, fingerprint: state.fingerprint,
        requirements_revision: state.requirements_revision, rules_version: state.rules_version }
      if (!current.draft || !matches(expected, binding(current.draft))) fail('草案已变化，请查看最新稿后重新开始协作')
      return expected
    }
    const roles = {
      async node(name, state, work) {
        const receipt = await transact(async (table, tx) => {
          const current = await active(tx, owner, id, token)
          if (current.steps[name] && current.steps[name].status === 'done') return current.steps[name].result
          current.steps[name] = { status: 'running', started_at: (current.steps[name] || {}).started_at || now() }
          await put(table, owner, runKey(id), current); return null
        })
        if (receipt) return receipt
        const result = await work()
        await transact(async (table, tx) => {
          const current = await active(tx, owner, id, token)
          current.steps[name] = { ...current.steps[name], status: 'done', finished_at: now(), result }
          current.state = { ...state, ...result }; current.updated_at = now()
          await put(table, owner, runKey(id), current)
        })
        return result
      },
      async manage(state) {
        if (state.mode === 'draft') { await assertDraft(state); return { route: 'rules', note: '已读取第' + state.revision + '版草案，交给审核师检查。' } }
        return { route: 'planner', note: '已读取你的新需求，交给规划师生成草案。' }
      },
      async plan(state) {
        const draft = await generate(owner, { run_id: id, demand: state.demand, expected_revision: state.base_revision },
          tx => active(tx, owner, id, token))
        const ref = binding(draft)
        return { draft_id: ref.draft_id, revision: ref.revision, fingerprint: ref.fingerprint,
          requirements_revision: ref.requirements_revision, rules_version: ref.rules_version, note: '规划师已保存草案，接下来检查具体安排。' }
      },
      async review(state, mode) {
        const target = await assertDraft(state)
        const result = await reviews.review(owner, { mode, binding: target, request_id: 'forest_' + hash([id, mode]).slice(0, 40) })
        if (result.review.status !== 'done') fail(result.review.error || '审核结果尚未确认，请先刷新核对，不重复调用模型')
        if (!result.review.is_current) fail('审核期间草案已变化，请查看最新稿')
        return { rule_errors: result.review.rules.error_count,
          note: mode === 'rules' ? (result.review.rules.error_count ? '请先核对字段和日期，再决定是否继续；可返回规划师修改。' : '规则检查已完成，接下来由审核师补充语义建议。') : '规划与审核已完成，请查看草案和建议，再由你决定是否发布。' }
      }
    }
    try {
      const graph = graphFactory(port, id, roles), config = { configurable: { thread_id: id }, recursionLimit: 10, durability: 'sync' }
      const before = await graph.getState(config)
      await graph.invoke(Object.keys(before.values).length ? null : row.state, config)
      const after = await graph.getState(config)
      const waiting = after.tasks.some(task => task.interrupts && task.interrupts.length)
      const finished = await transact(async (table, tx) => {
        const current = await active(tx, owner, id, token)
        current.state = after.values; current.next = after.next[0] || ''; current.status = waiting ? 'awaiting_confirmation' : 'ready'
        current.token = ''; current.updated_at = now(); await put(table, owner, runKey(id), current); return current
      })
      return { run: await view(owner, finished) }
    } catch (error) {
      const message = String(error.message || '协作步骤未完成，请刷新核对').slice(0, 500)
      await db.runTransaction(async tx => {
        const table = tx.collection('ai_plans'), current = await read(table, owner, runKey(id))
        if (!current || current.token !== token || current.status !== 'running') return
        current.status = 'failed'; current.error = message; current.token = ''; current.updated_at = now()
        for (const step of Object.values(current.steps)) if (step.status === 'running') step.status = 'failed'
        await put(table, owner, runKey(id), current)
      })
      return get(owner, { run_id: id })
    }
  }
  return { get, start, step, cancel, saveDraft, claimPublication, finishPublication, requiresHandoff, checkStandaloneSave }
}
module.exports = { createService }
