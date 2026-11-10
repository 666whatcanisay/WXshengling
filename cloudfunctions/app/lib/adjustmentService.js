const { randomUUID } = require('crypto')
const rules = require('./adjustmentRules'), dates = require('./taskRules')
const proof = require('./recordProof')
const id = v => typeof v === 'string' && /^[\w:.-]{1,128}$/.test(v)
function createService({ cloud, coach, loadModel, callModel, graphFactory, now = Date.now }) {
  const db = cloud.database(), table = () => db.collection('ai_plans')
  const key = (owner, logical) => 'adj_' + rules.fingerprint([owner, logical])
  async function doc(collection, docId) {
    try { return (await collection.doc(docId).get()).data || null }
    catch (e) { if (String(e.message || e.errMsg || '').includes('document with _id ' + docId + ' does not exist')) return null; throw e }
  }
  async function read(collection, owner, logical) {
    const row = await doc(collection, key(owner, logical))
    if (row && (row._openid !== owner || row.kind !== 'adjustment_state' || row.logical !== logical)) throw Error('调整记录归属不正确')
    return row && row.payload
  }
  async function put(collection, owner, logical, payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 400000) throw Error('调整记录过大，请精简')
    const previous = await read(collection, owner, logical)
    if (previous) {
      const result = await collection.doc(key(owner, logical)).update({ data: { payload: db.command.set(payload) } })
      if (!result.stats || result.stats.updated !== 1) throw Error('调整记录保存未确认')
    } else await collection.add({ data: { _id: key(owner, logical), _openid: owner, kind: 'adjustment_state', logical, payload } })
  }
  function validate(owner, data) {
    if (!owner) throw Error('请先登录')
    if (!id(data.goal_id) || !dates.validDate(data.date) || data.date > dates.businessDate(now())) throw Error('目标或复盘截至日期不正确')
  }
  async function collect(owner, data) {
    validate(owner, data)
    const evidence = await coach.get(owner, data, { includeReadProof: true }), today = dates.businessDate(now())
    const readProof = [...evidence.read_proof]
    const start = dates.addDays(today, 1), end = dates.addDays(today, 7)
    const blocked = ['done', 'abandoned', 'deleted'].includes(evidence.goal.status) ? '该目标已结束，请选择进行中的目标' :
      evidence.goal.end_date && evidence.goal.end_date < start ? '目标周期已结束，本轮不自动延长周期' : ''
    const responses = await Promise.all(Array.from({ length: 7 }, (_, i) => db.collection('tasks')
      .where({ _openid: owner, goal_id: data.goal_id, date: dates.addDays(start, i), completed: false }).orderBy('_id', 'asc').limit(21).get()))
    const tasks = []; let scanned = 0
    for (let i = 0; i < responses.length; i++) {
      const rows = responses[i].data
      if (!Array.isArray(rows)) throw Error('未来任务读取格式不正确')
      for (const t of rows) {
        readProof.push(proof.capture('tasks', t._id, t))
        scanned++
        if (t._openid !== owner || t.goal_id !== data.goal_id || t.date !== dates.addDays(start, i) || t.completed !== false || !id(t._id)) throw Error('未来任务归属或日期异常')
        if (t.status === 'deleted') continue
        tasks.push({ id: t._id, title: String(t.title || ''), date: t.date,
          estimated_minutes: Number.isInteger(t.estimated_minutes) ? t.estimated_minutes : null,
          xp_reward: t.xp_reward === undefined ? null : t.xp_reward, stage: t.stage === undefined ? null : t.stage,
          updated_at: t.updated_at instanceof Date ? +t.updated_at : typeof t.updated_at === 'number' ? t.updated_at : null })
      }
    }
    tasks.sort((a, b) => a.date === b.date ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : a.date < b.date ? -1 : 1)
    const snapshot = { version: rules.VERSION, goal: evidence.goal, business_date: today, start, end, tasks, eligible: !blocked, blocked_reason: blocked,
      complete: scanned <= 20, coach_fingerprint: evidence.fingerprint, facts: evidence.facts,
      feedback: evidence.feedback, report: evidence.report && evidence.report.status === 'done' ? { id: evidence.report.id, analysis: evidence.report.result } : null }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 100000) throw Error('来源记录过大，未开始调整')
    return { snapshot, fingerprint: rules.fingerprint(snapshot), read_proof: readProof }
  }
  const runKey = run => 'run/' + run
  const headKey = data => 'head/' + data.goal_id + '/' + data.date
  const confirmation = row => rules.fingerprint([rules.VERSION, row.id, row.source_fingerprint, row.revision, row.requirements, row.changes])
  const application = require('./adjustmentApplication').createApplication({ db, doc, read, put, owned, collect, runKey, headKey, confirmation, now })
  async function view(owner, row, evidence) {
    if (!row) return null
    evidence ||= await collect(owner, row)
    const head = await read(table(), owner, headKey(row))
    const current = evidence.fingerprint === row.source_fingerprint && !!head && head.id === row.id
    const sourceTooLarge = new Set(evidence.read_proof.map(r => r.collection + '/' + r.id)).size > 100
    return { id: row.id, goal_id: row.goal_id, date: row.date, version: rules.VERSION, status: row.status, next: row.next,
      revision: row.revision, is_current: current, requirements: row.requirements, changes: row.changes,
      confirmation: confirmation(row), application: row.application || null,
      can_apply: current && !sourceTooLarge && row.status === 'awaiting_review' && !!(row.changes && row.changes.length && row.ruleReport && row.ruleReport.version === rules.VERSION && !row.ruleReport.error_count),
      application_blocked_reason: sourceTooLarge ? '本轮来源记录超过100条事务校验范围，暂不支持应用；草案仍可查看。' : '',
      diff: (row.changes || []).map(c => ({ task_id: c.task_id, before: row.snapshot.tasks.find(t => t.id === c.task_id), after: c })),
      rules: row.ruleReport || null, review: row.semantic || null, error: row.error || '', steps: row.steps,
      can_recover: row.status === 'running' && row.lease_until <= now(), updated_at: row.updated_at,
      note: row.application ? '已按确认版本应用；历史对照和回执保留，后续任务变化不会重复应用。' : '生成、编辑、检查不会修改正式任务；只有你明确确认后才应用。' }
  }
  async function get(owner, data) {
    const evidence = await collect(owner, data), head = await read(table(), owner, headKey(data))
    const row = head && await read(table(), owner, runKey(head.id))
    const { read_proof, ...publicEvidence } = evidence
    return { ...publicEvidence, run: await view(owner, row, evidence), engine: 'langgraph-1.6.1', execution: 'foreground-resumable', applicationSupported: true }
  }
  async function start(owner, data) {
    const evidence = await collect(owner, data), requirement = rules.requirements(data)
    if (data.coach_suggestion !== undefined) {
      const ref = data.coach_suggestion, report = evidence.snapshot.report
      const suggestion = ref && Number.isInteger(ref.index) && ref.index >= 0 && report?.analysis?.suggestions?.[ref.index]
      if (!suggestion || ref.report_id !== report.id || ref.fingerprint !== evidence.snapshot.coach_fingerprint) {
        throw Error('这条教练建议已变化，请刷新复盘后重新选择')
      }
      requirement.coach_suggestion = { reference: { report_id: report.id, fingerprint: ref.fingerprint, index: ref.index },
        message: suggestion.message, action: suggestion.action, evidence: suggestion.evidence }
    }
    if (!evidence.snapshot.eligible) throw Error(evidence.snapshot.blocked_reason)
    if (!id(data.request_id) || data.fingerprint !== evidence.fingerprint) throw Error('来源已变化或请求标识不正确，请刷新')
    if (!evidence.snapshot.complete || !evidence.snapshot.tasks.length) throw Error('没有可调整任务或读取超过20项，请缩小任务规模；未调用模型')
    const runId = key(owner, data.request_id), requestHash = rules.fingerprint([data.goal_id, data.date, data.fingerprint, requirement])
    const row = await db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), old = await read(c, owner, runKey(runId))
      if (old) { if (old.request_hash !== requestHash) throw Error('同一请求不能更改调整内容'); return old }
      const head = await read(c, owner, headKey(data)), previous = head && await read(c, owner, runKey(head.id))
      if (previous && ['ready', 'running'].includes(previous.status)) throw Error('已有调整协作，请先继续或取消')
      const row = { id: runId, goal_id: data.goal_id, date: data.date, request_hash: requestHash, source_fingerprint: evidence.fingerprint,
        snapshot: evidence.snapshot, requirements: requirement, status: 'ready', next: 'manager', mode: 'new',
        revision: 0, graph_revision: 0, steps: {}, changes: null, ruleReport: null, semantic: null, versions: [], updated_at: now() }
      await put(c, owner, runKey(runId), row); await put(c, owner, headKey(data), { id: runId }); return row
    })
    return { run: await view(owner, row, evidence) }
  }
  async function owned(owner, runId, c = table()) {
    if (!owner || !id(runId)) throw Error('调整身份或标识不正确')
    const row = await read(c, owner, runKey(runId))
    if (!row) throw Error('调整不存在或无法访问')
    return row
  }
  async function cancel(owner, data) {
    const row = await db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), row = await owned(owner, data.run_id, c)
      if (row.application) return row
      row.status = 'cancelled'; row.token = ''; row.updated_at = now(); await put(c, owner, runKey(row.id), row); return row
    })
    return { run: await view(owner, row) }
  }
  async function save(owner, data) {
    const old = await owned(owner, data.run_id), evidence = await collect(owner, old)
    if (evidence.fingerprint !== old.source_fingerprint) throw Error('任务或反馈已变化，请刷新后重新开始')
    const edits = rules.changes(data.changes, old.snapshot), requirement = rules.requirements(data)
    if (old.requirements.coach_suggestion) requirement.coach_suggestion = old.requirements.coach_suggestion
    const row = await db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), row = await owned(owner, data.run_id, c)
      const head = await read(c, owner, headKey(row))
      if (!head || head.id !== row.id) throw Error('已有更新的调整，请刷新查看，未覆盖新稿')
      if (row.revision !== data.expected_revision || !row.changes || !['awaiting_review', 'failed', 'edited'].includes(row.status)) throw Error('调整版本或状态已变化，请刷新，未覆盖原稿')
      if (row.revision >= 10) throw Error('本次修改版本过多，请保留草案后重新开始')
      row.versions.push({ revision: row.revision, changes: row.changes, requirements: row.requirements, rules: row.ruleReport, review: row.semantic })
      Object.assign(row, { revision: row.revision + 1, graph_revision: row.graph_revision + 1, changes: edits, requirements: requirement,
        mode: 'edited', status: 'ready', next: 'manager', steps: {}, ruleReport: null, semantic: null, error: '', token: '', updated_at: now() })
      await put(c, owner, runKey(row.id), row); return row
    })
    return { run: await view(owner, row, evidence) }
  }
  async function step(owner, data) {
    if (!id(data.request_id)) throw Error('推进请求标识不正确')
    const old = await owned(owner, data.run_id), evidence = await collect(owner, old)
    if (evidence.fingerprint !== old.source_fingerprint) throw Error('任务、反馈或日期已变化，请查看最新记录后重新开始')
    const token = randomUUID()
    const claimed = await db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), row = await owned(owner, data.run_id, c)
      const head = await read(c, owner, headKey(row))
      if (!head || head.id !== row.id) throw Error('已有更新的调整，请刷新查看')
      if ((row.requests || []).includes(data.request_id) || ['cancelled', 'awaiting_review', 'failed', 'applied'].includes(row.status) || row.status === 'running' && row.lease_until > now()) return { cached: row }
      if ((row.requests || []).length >= 20) throw Error('恢复次数过多，请保留状态后核查')
      row.requests = [...(row.requests || []), data.request_id]
      Object.assign(row, { status: 'running', token, lease_until: now() + 60000, updated_at: now() })
      await put(c, owner, runKey(row.id), row); return { row }
    })
    if (claimed.cached) return { run: await view(owner, claimed.cached, evidence), cached: true }
    const row = claimed.row, thread = row.id + ':' + row.graph_revision
    const transact = fn => db.runTransaction(async tx => {
      const c = tx.collection('ai_plans'), current = await owned(owner, row.id, c)
      if (current.status !== 'running' || current.token !== token || current.lease_until <= now()) throw Error('调整已暂停、取消或由新请求接手')
      return fn(c, current)
    })
    const checkpointKey = suffix => 'graph/' + thread + '/' + suffix
    const port = {
      async read(selected) {
        const c = table(), h = selected ? null : await read(c, owner, checkpointKey('head')), k = selected || h && h.id
        if (!k) return null
        const saved = await read(c, owner, checkpointKey(k))
        if (!saved) throw Error('调整检查点缺失，请保留记录核查')
        return { id: k, saved, writes: await read(c, owner, checkpointKey('writes/' + k)) || [] }
      },
      put: (k, saved) => transact(async c => { await put(c, owner, checkpointKey(k), saved); const h = await read(c, owner, checkpointKey('head')); if (!h || k > h.id) await put(c, owner, checkpointKey('head'), { id: k }) }),
      writes: (k, entries) => transact(async c => {
        const values = await read(c, owner, checkpointKey('writes/' + k)) || []
        for (const e of entries) { const i = values.findIndex(v => v.task === e.task && v.index === e.index); if (i < 0) values.push(e); else if (e.index < 0) values[i] = e }
        if (values.length > 100) throw Error('调整检查点写入过多')
        await put(c, owner, checkpointKey('writes/' + k), values)
      })
    }
    const roles = {
      async node(name, work) {
        const receipt = await transact(async (c, r) => {
          const step = r.steps[name]
          if (step && step.status === 'done') return step.update
          if (step) throw Error('该步骤结果未确认或已失败，不自动重复调用模型；请保留记录后重新开始')
          r.steps[name] = { status: 'running' }; await put(c, owner, runKey(r.id), r); return null
        })
        if (receipt) return receipt
        const update = await work()
        await transact(async (c, r) => { r.steps[name] = { status: 'done', update }; await put(c, owner, runKey(r.id), r) })
        return update
      },
      async plan() {
        const config = await loadModel(owner), edits = rules.changes(rules.parse(await callModel(config, rules.plannerMessages(row.snapshot, row.requirements))).changes, row.snapshot)
        await transact(async (c, r) => { r.changes = edits; r.revision = 1; await put(c, owner, runKey(r.id), r) })
        return { revision: 1, has_changes: edits.length > 0 }
      },
      async review(mode) {
        const current = await owned(owner, row.id), checked = rules.check(current.snapshot, current.changes, current.requirements)
        if (mode === 'rules') {
          await transact(async (c, r) => { r.ruleReport = checked; await put(c, owner, runKey(r.id), r) })
          return { rule_errors: checked.error_count }
        }
        const config = await loadModel(owner), semantic = rules.semantic(await callModel(config, rules.reviewerMessages(current.snapshot, current.changes, current.requirements, checked)), current.changes)
        await transact(async (c, r) => { r.semantic = { ...semantic, revision: r.revision, model: { provider: config.provider, name: config.model } }; await put(c, owner, runKey(r.id), r) })
        return {}
      }
    }
    try {
      const graph = graphFactory(port, thread, roles), config = { configurable: { thread_id: thread }, durability: 'sync', recursionLimit: 10 }
      const before = await graph.getState(config)
      await graph.invoke(Object.keys(before.values).length ? null : { mode: row.mode, revision: row.revision, rule_errors: 0, has_changes: !!(row.changes && row.changes.length) }, config)
      const after = await graph.getState(config), waiting = after.tasks.some(t => t.interrupts && t.interrupts.length)
      const finished = await transact(async (c, r) => { Object.assign(r, { status: waiting ? 'awaiting_review' : 'ready', next: after.next[0] || '', token: '', updated_at: now() }); await put(c, owner, runKey(r.id), r); return r })
      return { run: await view(owner, finished) }
    } catch (e) {
      await db.runTransaction(async tx => {
        const c = tx.collection('ai_plans'), r = await owned(owner, row.id, c)
        if (r.status !== 'running' || r.token !== token) return
        Object.assign(r, { status: 'failed', token: '', error: String(e.message || '本步未完成').slice(0, 500), updated_at: now() }); await put(c, owner, runKey(r.id), r)
      })
      return { run: await view(owner, await owned(owner, row.id)) }
    }
  }
  async function check(owner, data) {
    const row = await application.check(owner, data)
    return { run: await view(owner, row) }
  }
  return { get, start, step, save, cancel, collect, check, apply: application.apply, applicationStatus: application.status }
}
module.exports = { createService }
