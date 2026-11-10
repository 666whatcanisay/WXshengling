const { createHash } = require('crypto')
const contextRules = require('./plannerContext')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => { throw new Error(message) }
const id = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value)
function text(value, max) {
  if (typeof value !== 'string' || value.length > max) fail('草案文字格式或长度不正确')
  return value
}
function numberInput(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= max) return value
  fail('草案数字字段格式不正确')
}
function normalize(data) {
  if (!id(data.request_id) || !id(data.conversation_id) || !Number.isSafeInteger(data.expected_revision) || data.expected_revision < 0) fail('草案请求标识或版本不正确')
  if (data.source_plan_id && !id(data.source_plan_id)) fail('来源计划标识不正确')
  const input = data.snapshot || {}, goal = input.goal || {}
  if (!Array.isArray(input.tasks) || input.tasks.length > 20) fail('草案最多保存20项任务')
  if (!Array.isArray(goal.stages || []) || (goal.stages || []).length > 20) fail('草案阶段格式不正确')
  const taskIds = new Set()
  const snapshot = { goal: { title: text(goal.title || '', 200), target_days: numberInput(goal.target_days === undefined ? '' : goal.target_days, 12),
    start_date: text(goal.start_date || '', 10), stages: (goal.stages || []).map(s => ({ name: text(s.name || '', 80), duration: text(s.duration || '', 80), milestone: text(s.milestone || '', 200) })) },
    tasks: input.tasks.map(task => {
      if (!id(task.draft_task_id) || taskIds.has(task.draft_task_id)) fail('草案任务标识缺失或重复')
      taskIds.add(task.draft_task_id)
      return { draft_task_id: task.draft_task_id, title: text(task.title || '', 200), date: text(task.date || '', 10),
        stage: numberInput(task.stage === undefined ? 1 : task.stage, 80), estimated_minutes: numberInput(task.estimated_minutes === undefined ? '' : task.estimated_minutes, 16),
        xp_reward: numberInput(task.xp_reward === undefined ? '' : task.xp_reward, 16) }
    }) }
  if (!Array.isArray(data.messages) || data.messages.length > 80) fail('草案会话格式不正确')
  const messages = data.messages.map((m, index) => {
    if (!m || !['user', 'assistant'].includes(m.role)) fail('草案会话角色不正确')
    const content = text(m.fullContent || m.content || '', 4000)
    return { id: id(m.id) ? m.id : 'msg_' + hash([index, m.role, content]).slice(0, 40), role: m.role, content }
  })
  const edits = {}
  for (const [field, value] of Object.entries(data.user_edits || {})) {
    if (!contextRules.FIELDS.includes(field)) fail('未知的用户要求字段')
    edits[field] = text(value, 500)
  }
  const normalized = { snapshot, messages, conversation_id: data.conversation_id, source_plan_id: data.source_plan_id || '',
    requested_source: data.source === 'local_template' ? 'local_template' : 'user_draft', user_edits: edits }
  if (data.steward !== undefined) {
    const ref = data.steward
    if (!ref || !id(ref.run_id) || !ref.binding || typeof ref.binding !== 'object') fail('协作草案引用不正确')
    normalized.steward = { run_id: ref.run_id, binding: ref.binding }
    const limit = input.daily_max_minutes
    if (limit !== undefined && limit !== null) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1440) fail('每日上限需为1至1440分钟整数')
      snapshot.daily_max_minutes = limit
    }
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > 65536) fail('草案内容过长，请精简会话和任务')
  return normalized
}
function view(row) {
  if (!row) return null
  return { id: row._id, revision: row.revision, conversation_id: row.conversation_id, fingerprint: row.fingerprint,
    request_id: row.request_id,
    source: row.source, source_plan_id: row.source_plan_id, snapshot: row.snapshot, messages: row.messages,
    context: row.context, assumptions: row.assumptions, saved_at: row.created_at,
    ...(row.steward_run_id ? { steward_run_id: row.steward_run_id } : {}) }
}
function createStore(cloud, checkStandaloneSave) {
  const db = cloud.database(), collection = () => db.collection('ai_plans')
  const headId = owner => 'planner_head_' + hash(owner)
  async function read(table, key) {
    try { return (await table.doc(key).get()).data || null }
    catch (error) {
      // wx-server-sdk throws for an absent doc outside transactions. Never hide transport/permission errors.
      if (String(error && (error.errMsg || error.message) || '').includes('document with _id ' + key + ' does not exist')) return null
      throw error
    }
  }
  async function updateHead(table, key, data) {
    const result = await table.doc(key).update({ data })
    if (!result.stats || result.stats.updated !== 1) fail('云端工作区未能更新，本次草案未保存')
  }
  async function touchForPublication(openid, tx) {
    const table = tx.collection('ai_plans'), key = headId(openid)
    const head = await read(table, key)
    if (!head || head._openid !== openid || head.kind !== 'planner_workspace') fail('工作区归属异常')
    // A write on the head makes concurrent saves conflict with acceptance.
    await updateHead(table, key, { updated_at: Math.max(Date.now(), (head.updated_at || 0) + 1) })
  }
  async function get(openid, table = collection()) {
    if (!openid) fail('请先登录')
    const head = await read(table, headId(openid))
    if (!head) return { draft: null, revision: 0 }
    if (head._openid !== openid || head.kind !== 'planner_workspace') fail('工作区归属异常')
    if (!head.latest_draft_id) return { draft: null, revision: head.revision }
    const row = await read(table, head.latest_draft_id)
    if (!row || row._openid !== openid || row.kind !== 'planner_draft_version') fail('云端草案缺失，请保留本机稿后联系开发者')
    return { draft: view(row), revision: head.revision }
  }
  async function save(openid, data, guard, advanceSteward) {
    if (!openid) fail('请先登录')
    const input = normalize(data), requestHash = hash(input), recordId = 'planner_draft_' + hash([openid, data.request_id])
    if (input.steward && !advanceSteward) fail('请从森林管家打开此草案')
    return db.runTransaction(async tx => {
      if (guard) await guard(tx)
      const table = tx.collection('ai_plans')
      const head = await read(table, headId(openid))
      const prior = await read(table, recordId)
      if (prior) {
        if (prior._openid !== openid || prior.kind !== 'planner_draft_version' || prior.request_fingerprint !== requestHash) fail('同一保存请求不能提交不同草案')
        return { ...view(prior), current_revision: head ? head.revision : prior.revision }
      }
      if (head && (head._openid !== openid || head.kind !== 'planner_workspace')) fail('工作区归属异常')
      if ((head ? head.revision : 0) !== data.expected_revision) fail('云端草案已有新版本，请先恢复云端稿再修改；本机内容已保留')
      if (!input.steward && !guard && checkStandaloneSave) await checkStandaloneSave(tx, openid, input)
      let source = input.requested_source
      let sourceRun
      if (input.source_plan_id) {
        const origin = await read(table, input.source_plan_id)
        if (!origin || origin._openid !== openid || origin.status !== 'done' || (origin.kind && origin.kind !== 'plan_generation') || !origin.result) fail('模型来源尚未成功，请保留本机稿重试')
        source = origin.result.source === 'local_template' ? 'local_template' : 'model'
        sourceRun = origin.steward_run_id
        if (sourceRun && !guard && input.steward?.run_id !== sourceRun) fail('请从森林管家打开此草案后保存')
      }
      const sameConversation = head && head.conversation_id === input.conversation_id
      const known = new Map((sameConversation ? head.messages || [] : []).map(m => [m.id, m]))
      const newMessages = []
      for (const message of input.messages) {
        const old = known.get(message.id)
        if (old && (old.role !== message.role || old.content !== message.content)) fail('已有会话消息不能悄悄改写，请重新开始')
        if (!old) { newMessages.push(message); known.set(message.id, message) }
      }
      const context = contextRules.derive(newMessages, sameConversation ? head.context : null)
      for (const [field, value] of Object.entries(input.user_edits)) {
        if (context.values[field] !== value) context.revision++
        context.values[field] = value
        context.sources[field] = { kind: 'user_edit', value, quote: value, request_id: data.request_id }
      }
      const revision = data.expected_revision + 1
      const row = { _id: recordId, _openid: openid, kind: 'planner_draft_version', revision,
        request_id: data.request_id,
        request_fingerprint: requestHash, conversation_id: input.conversation_id, snapshot: input.snapshot,
        messages: [...known.values()].slice(-40), source_plan_id: input.source_plan_id, source, context,
        assumptions: contextRules.assumptions(context, input.snapshot.goal),
        fingerprint: hash([input.snapshot, context]), created_at: Date.now() }
      if (sourceRun) row.steward_run_id = sourceRun
      if (input.steward) {
        row.steward_run_id = input.steward.run_id
        await advanceSteward(tx, input.steward, view(row))
      }
      await table.add({ data: row })
      const next = { _openid: openid, kind: 'planner_workspace', revision, conversation_id: input.conversation_id,
        latest_draft_id: recordId, context, messages: row.messages, updated_at: Date.now() }
      if (head) await updateHead(table, headId(openid), { ...next, context: db.command.set(context) })
      else await table.add({ data: { _id: headId(openid), ...next } })
      return view(row)
    })
  }
  async function clear(openid, data) {
    if (!openid || !id(data.request_id) || !Number.isSafeInteger(data.expected_revision)) fail('清理工作区参数不正确')
    return db.runTransaction(async tx => {
      const table = tx.collection('ai_plans'), head = await read(table, headId(openid))
      if (!head) {
        if (data.expected_revision !== 0) fail('云端草案版本不一致')
        await table.add({ data: { _id: headId(openid), _openid: openid, kind: 'planner_workspace', revision: 1, latest_draft_id: '',
          messages: [], context: { values: contextRules.empty(), sources: {}, revision: 0 }, conversation_id: '', clear_request_id: data.request_id, updated_at: Date.now() } })
        return { revision: 1 }
      }
      if (head._openid !== openid || head.kind !== 'planner_workspace') fail('工作区归属异常')
      if (head.clear_request_id === data.request_id) return { revision: head.revision, preserved_newer_draft: !!head.latest_draft_id }
      if (head.revision !== data.expected_revision) fail('云端已有新稿，请先恢复后再开始新对话')
      const revision = head.revision + 1
      await updateHead(table, headId(openid), { revision, latest_draft_id: '', messages: [], context: db.command.set({ values: contextRules.empty(), sources: {}, revision: 0 }),
        conversation_id: '', clear_request_id: data.request_id, updated_at: Date.now() })
      return { revision }
    })
  }
  async function saveGenerated(openid, planId, plan, result, guard) {
    const meta = plan.draft_meta
    if (!meta) return null // Compatible with existing clients.
    const rules = require('./taskRules')
    const context = contextRules.derive(plan.messages || [])
    const period = (plan.planState && plan.planState.deadline || context.values.deadline).match(/^(\d+)(天|周|个月)$/)
    const days = period ? Number(period[1]) * ({ 天: 1, 周: 7, '个月': 30 }[period[2]]) : rules.positiveInteger(result.goal.period_days) || 30
    const start = plan.steward_run_id && rules.validDate(meta.start_date) ? meta.start_date : rules.businessDate()
    return save(openid, { request_id: 'gen_' + hash(planId).slice(0, 40), expected_revision: meta.expected_revision,
      conversation_id: meta.conversation_id, source_plan_id: planId, messages: plan.messages || [], user_edits: plan.user_edits || {},
      snapshot: { goal: { title: result.goal.title, target_days: days, start_date: start, stages: result.goal.stages || [] },
        tasks: result.tasks.map((task, index) => ({ ...task, draft_task_id: 'task_' + hash([planId, index]).slice(0, 32),
          date: task.date || rules.addDays(start, Math.min(rules.positiveInteger(task.day_index) || index + 1, days) - 1) })) } }, guard)
  }
  return { get, save, clear, saveGenerated, touchForPublication, getInTransaction: (openid, tx) => get(openid, tx.collection('ai_plans')) }
}
module.exports = { createStore, normalize }
