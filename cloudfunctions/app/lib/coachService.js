const { createHash } = require('crypto')
const dates = require('./taskRules'), rules = require('./coachFacts')
const proof = require('./recordProof')
const lease = require('./modelRunLease')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value)
const fail = message => { throw Error(message) }
function createService({ cloud, loadModel, callModel, now = Date.now }) {
  const db = cloud.database(), table = () => db.collection('ai_plans'), feedbackId = (owner, goal, date) => 'coach_feedback_' + hash([owner, goal, date])
  async function read(collection, id) {
    try { return (await collection.doc(id).get()).data || null }
    catch (e) { if (String(e.errMsg || e.message || '').includes('document with _id ' + id + ' does not exist')) return null; throw e }
  }
  function input(owner, data) {
    if (!owner) fail('请先登录')
    if (!identifier(data.goal_id) || !dates.validDate(data.date) || data.date > dates.businessDate(now())) fail('请选择有效目标与非未来日期')
  }
  async function goal(owner, id, collection = db.collection('goals')) {
    const row = await read(collection, id)
    if (!row || row._openid !== owner || row.status === 'deleted') fail('目标不存在或无法访问')
    return row
  }
  function feedbackView(row, date) {
    return row ? { date, revision: row.revision, request_id: row.request_id, values: row.values } : { date, revision: 0, request_id: '', values: rules.feedback() }
  }
  async function currentFeedback(owner, goalId, date, collection = table()) {
    const row = await read(collection, feedbackId(owner, goalId, date))
    if (row && (row._openid !== owner || row.kind !== 'coach_feedback' || row.goal_id !== goalId || row.date !== date)) fail('反馈归属异常')
    return row
  }
  async function collect(owner, data) {
    input(owner, data)
    const started = now(), g = await goal(owner, data.goal_id), today = dates.businessDate(now()), start = dates.addDays(data.date, -6)
    const readProof = [proof.capture('goals', g._id, g)]
    const days = Array.from({ length: 7 }, (_, i) => dates.addDays(start, i)), tasks = []
    let complete = true, scanned = 0
    outer: for (const date of days) {
      let cursor = ''
      while (true) {
        const limit = Math.min(100, 501 - scanned)
        const query = { _openid: owner, goal_id: data.goal_id, date, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }
        const response = await db.collection('tasks').where(query).orderBy('_id', 'asc').limit(limit).get()
        if (!Array.isArray(response.data)) fail('任务读取格式不正确')
        const rows = response.data
        for (const t of rows) {
          readProof.push(proof.capture('tasks', t._id, t))
          if (t._openid !== owner || t.goal_id !== data.goal_id || t.date !== date || typeof t._id !== 'string' || !t._id || cursor && t._id <= cursor) fail('任务分页或归属异常，未生成统计')
          cursor = t._id; scanned++
          if (scanned > 500) { complete = false; break outer }
          if (t.status === 'deleted') continue
          const minutes = dates.positiveInteger(t.estimated_minutes), timestamp = t.completed_at instanceof Date ? +t.completed_at : t.completed_at
          tasks.push({ id: t._id, date, title: String(t.title || '未命名任务').slice(0, 80),
            completed: typeof t.completed === 'boolean' ? t.completed : null,
            estimated_minutes: minutes && minutes <= 1440 ? minutes : null,
            completed_at: typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now() ? timestamp : null })
        }
        if (rows.length < limit) break
      }
    }
    const feedbacks = await Promise.all(days.map(async date => {
      const row = await currentFeedback(owner, data.goal_id, date)
      readProof.push(proof.capture('ai_plans', feedbackId(owner, data.goal_id, date), row))
      return feedbackView(row, date)
    }))
    const summary = { id: g._id, title: String(g.title || '未命名目标').slice(0, 200), start_date: dates.validDate(g.start_date) ? g.start_date : '',
      end_date: dates.validDate(g.end_date) ? g.end_date : '', status: String(g.status || 'active') }
    const snapshot = { goal: summary, tasks, feedbacks, facts: rules.summarize(summary, data.date, today, tasks, feedbacks, complete) }
    const fingerprint = hash([rules.VERSION, snapshot])
    return { snapshot, fingerprint, source: { read_started_at: started, read_finished_at: now(), atomic_snapshot: false },
      feedback: feedbacks[6], read_proof: readProof }
  }
  const reportId = (owner, fingerprint) => 'coach_report_' + hash([owner, fingerprint])
  async function readReport(owner, fingerprint, collection = table()) {
    const row = await read(collection, reportId(owner, fingerprint))
    if (row && (row._openid !== owner || row.kind !== 'coach_report' || row.fingerprint !== fingerprint)) fail('复盘归属异常')
    return row
  }
  function reportView(row) {
    if (!row) return null
    const expired = lease.expired(row, now())
    const status = expired ? 'failed' : row.status
    return { id: row._id, status, fingerprint: row.fingerprint, version: rules.VERSION, result: row.analysis || null,
      error: expired ? '上次复盘中断，未收到有效结果。' : row.error || '', model: row.model || null, attempt: row.attempt, retry_available: status === 'failed' && row.attempt < 3,
      retry_hint: /模型.*(?:引用|格式|JSON|有效复盘)/.test(row.error || '') ? '模型返回的内容未通过格式或引用校验，未采纳为复盘；云端反馈仍保留。修复后可主动重试，不会自动扣费重试。' : '本次未生成有效复盘，云端反馈仍保留；请核对错误信息后决定是否重试。',
      captured_at: row.captured_at, updated_at: row.updated_at }
  }
  async function get(owner, data, options = {}) {
    const evidence = await collect(owner, data)
    const report = await readReport(owner, evidence.fingerprint)
    return { facts: evidence.snapshot.facts, goal: evidence.snapshot.goal, feedback: evidence.feedback, fingerprint: evidence.fingerprint,
      source: evidence.source, day_tasks: evidence.snapshot.tasks.filter(t => t.date === data.date),
      report: reportView(report), ...(options.includeReadProof ? { read_proof: [...evidence.read_proof, proof.capture('ai_plans', reportId(owner, evidence.fingerprint), report)] } : {}) }
  }
  async function listGoals(owner) {
    if (!owner) fail('请先登录')
    const goals = []; let cursor = '', scanned = 0, complete = true
    while (true) {
      const limit = Math.min(100, 501 - scanned)
      const response = await db.collection('goals').where({ _openid: owner, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(limit).get()
      if (!Array.isArray(response.data)) fail('目标读取格式不正确')
      for (const g of response.data) {
        if (g._openid !== owner || typeof g._id !== 'string' || !g._id || cursor && g._id <= cursor) fail('目标分页或归属异常')
        cursor = g._id
        if (++scanned > 500) { complete = false; break }
        if (g.status !== 'deleted') goals.push({ _id: g._id, title: String(g.title || '未命名目标').slice(0, 200), status: g.status || 'active' })
      }
      if (!complete || response.data.length < limit) break
    }
    return { goals, complete }
  }
  async function saveFeedback(owner, data) {
    input(owner, data)
    if (!identifier(data.request_id) || !Number.isSafeInteger(data.expected_revision) || data.expected_revision < 0) fail('反馈请求或版本不正确')
    const values = rules.feedback(data.values), requestHash = hash([data.goal_id, data.date, data.expected_revision, values])
    return db.runTransaction(async tx => {
      await goal(owner, data.goal_id, tx.collection('goals'))
      const collection = tx.collection('ai_plans'), row = await currentFeedback(owner, data.goal_id, data.date, collection)
      const receipt = row && row.receipts.find(r => r.id === data.request_id)
      if (receipt) {
        if (receipt.hash !== requestHash) fail('同一反馈请求不能更改内容')
        return { feedback: feedbackView(row, data.date), applied_revision: receipt.revision, current_revision: row.revision }
      }
      if ((row ? row.revision : 0) !== data.expected_revision) fail('云端反馈已有新版本，请先保留本机稿并核对')
      const revision = data.expected_revision + 1
      const next = { _openid: owner, kind: 'coach_feedback', goal_id: data.goal_id, date: data.date, values, revision,
        request_id: data.request_id, receipts: [...(row ? row.receipts : []), { id: data.request_id, hash: requestHash, revision }].slice(-8), updated_at: now() }
      if (row) {
        const saved = await collection.doc(row._id).update({ data: { ...next, values: db.command.set(values) } })
        if (!saved.stats || saved.stats.updated !== 1) fail('反馈未能保存')
      } else await collection.add({ data: { _id: feedbackId(owner, data.goal_id, data.date), ...next } })
      return { feedback: feedbackView(next, data.date), applied_revision: revision, current_revision: revision }
    })
  }
  async function review(owner, data) {
    if (!identifier(data.request_id) || !/^[a-f0-9]{64}$/.test(data.fingerprint || '')) fail('复盘请求或证据指纹不正确')
    const evidence = await collect(owner, data)
    if (evidence.fingerprint !== data.fingerprint) fail('任务或反馈已有变化，请刷新记录后再复盘')
    if (!evidence.snapshot.facts.complete || !evidence.snapshot.facts.has_evidence) fail('记录未读全或暂时没有任务/反馈，先补充记录，不调用模型')
    const claimed = await db.runTransaction(async tx => {
      await goal(owner, data.goal_id, tx.collection('goals'))
      const collection = tx.collection('ai_plans')
      for (const f of evidence.snapshot.feedbacks) {
        const latest = await currentFeedback(owner, data.goal_id, f.date, collection)
        if ((latest ? latest.revision : 0) !== f.revision) fail('反馈已有变化，请刷新后再复盘')
      }
      const previous = await readReport(owner, data.fingerprint, collection)
      const at = now()
      const requests = previous ? previous.request_ids || [previous.request_id] : []
      if (previous && (requests.includes(data.request_id) || previous.status !== 'failed' && !lease.expired(previous, at))) return { cached: reportView(previous) }
      if (previous && previous.attempt >= 3) fail('相同证据已达到3次失败尝试，请先检查模型配置或更新记录')
      const row = { _openid: owner, kind: 'coach_report', goal_id: data.goal_id, date: data.date, fingerprint: data.fingerprint,
        snapshot: evidence.snapshot, source: evidence.source, status: 'running', request_ids: [...requests, data.request_id], lease_until: at + lease.LEASE_MS,
        // Keep semantic output separate from legacy plan_generation.result; old publication reads that field.
        request_id: data.request_id, attempt: (previous ? previous.attempt : 0) + 1, analysis: null, error: '', model: null, captured_at: at, updated_at: at }
      if (Buffer.byteLength(JSON.stringify(row)) > 400000) fail('复盘证据过大，未调用模型')
      if (previous) {
        const saved = await collection.doc(previous._id).update({ data: { ...row, snapshot: db.command.set(row.snapshot), source: db.command.set(row.source) } })
        if (!saved.stats || saved.stats.updated !== 1) fail('复盘请求未能保存')
      } else await collection.add({ data: { _id: reportId(owner, data.fingerprint), ...row } })
      return { row }
    })
    if (claimed.cached) return { report: claimed.cached, cached: true }
    let result = null, error = '', model = null
    try {
      const config = await loadModel(owner); model = { provider: config.provider, name: config.model }
      result = rules.parseModel(await callModel(config, rules.messages(evidence.snapshot)), evidence.snapshot)
    } catch (e) { error = String(e.message || '复盘未完成').slice(0, 500) }
    const report = await db.runTransaction(async tx => {
      const collection = tx.collection('ai_plans'), row = await readReport(owner, data.fingerprint, collection)
      if (!row || row.status !== 'running' || row.request_id !== data.request_id) fail('复盘状态已变化，请刷新核对')
      const at = now()
      if (lease.expired(row, at)) return reportView(row)
      const patch = { status: error ? 'failed' : 'done', error, analysis: result, model, lease_until: 0, updated_at: at }
      const saved = await collection.doc(row._id).update({ data: { ...patch, ...(result ? { analysis: db.command.set(result) } : {}), ...(model ? { model: db.command.set(model) } : {}) } })
      if (!saved.stats || saved.stats.updated !== 1) fail('复盘结果未确认，请刷新查询原请求')
      return reportView({ ...row, ...patch })
    })
    return { report }
  }
  return { get, saveFeedback, review, collect, listGoals }
}
module.exports = { createService }
