// Actual production modules/handlers + installed SDK/offline wire; no cloud/model calls.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs'), vm = require('node:vm')
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService } = require('../cloudfunctions/app/lib/coachService')
const facts = require('../cloudfunctions/app/lib/coachFacts')
const now = Date.parse('2026-11-06T12:00:00+08:00'), end = '2026-11-06'
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const rejects = async (fn, re) => { await assert.rejects(fn, re); checks++ }
const throws = (fn, re) => { assert.throws(fn, re); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const request = { goal_id: 'g1', date: end }
const output = JSON.stringify({ summary: '根据现有登记记录，先核对困难再决定调整。', observations: [{ message: '记录范围有缺口', evidence_ids: ['coverage'] }], suggestions: [{ message: '主动补充执行感受', action: '在本周反馈中注明困难', evidence_ids: ['past'] }], uncertainties: ['实际执行耗时未客观记录'] })
const task = (id, date, completed) => ({ _id: id, _openid: 'owner', goal_id: 'g1', date, title: '阅读' + id, completed, estimated_minutes: 10 })
function seed() { return { ai_plans: [], goals: [{ _id: 'g1', _openid: 'owner', title: '阅读', status: 'active', start_date: '2026-11-03', end_date: '2026-11-20' },
  { _id: 'foreign', _openid: 'other', title: '别人的目标' }, { _id: 'deleted', _openid: 'owner', status: 'deleted' }],
  tasks: [task('past1', '2026-11-05', true), task('past2', '2026-11-05', false), task('today', end, false), task('future', '2026-11-07', true),
    { ...task('foreign', end, true), _openid: 'other' }, { ...task('othergoal', end, true), goal_id: 'other-goal' }] } }
async function main() {
  eq(facts.feedback({ actual_minutes: '0' }).actual_minutes, 0)
  for (const value of [{ actual_minutes: true }, { actual_minutes: -1 }, { actual_minutes: 0.5 }, { difficulty: '非常差' }, { reason: 0 }, { note: 'x'.repeat(501) }]) throws(() => facts.feedback(value), /格式|分钟|备注/)
  const env = offlineCloudbase(seed()); let calls = 0, gate = null, failure = '', prompts, at = now
  const service = createService({ cloud: env.cloud, now: () => at, loadModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'private-synthetic-key' }),
    callModel: async (_, messages) => { calls++; prompts = messages; if (gate) await gate.promise; if (failure) throw Error(failure); return output } })
  try {
    const workspace = await service.get('owner', request)
    eq(workspace.facts.past, { total: 2, completed: 1, pending: 1, unknown: 0, rate: 50, estimated_minutes: 20, missing_estimated_minutes: 0 })
    eq(workspace.facts.today.pending, 1); eq(workspace.facts.total_read, 3); eq(workspace.facts.overlap_days, 4)
    eq(workspace.facts.self_reported_minutes, null); eq(workspace.facts.scheduled_days, 2); eq(workspace.feedback.revision, 0)
    eq(workspace.report, null); eq(workspace.source.atomic_snapshot, false)
    eq((await service.listGoals('owner')).goals.map(g => g._id), ['g1'])
    await rejects(() => service.get('other', request), /目标不存在/)
    await rejects(() => service.get('', request), /登录/)
    await rejects(() => service.get('owner', { goal_id: 'deleted', date: end }), /不存在/)
    await rejects(() => service.get('owner', { ...request, date: '2026-11-07' }), /非未来/)
    const savedRequest = { ...request, expected_revision: 0, request_id: 'save1', values: { reason: '时间不够', difficulty: '偏难', actual_minutes: 0, note: '今天加班' } }
    const saved = await service.saveFeedback('owner', savedRequest)
    eq(saved.feedback.values.actual_minutes, 0); eq(saved.applied_revision, 1)
    eq((await service.saveFeedback('owner', savedRequest)).applied_revision, 1)
    await rejects(() => service.saveFeedback('owner', { ...savedRequest, values: { note: '偷偷改同一请求' } }), /同一反馈/)
    await rejects(() => service.saveFeedback('owner', { ...savedRequest, request_id: 'stale' }), /新版本/)
    const read = await service.get('owner', request)
    eq(read.facts.feedback_days, 1); eq(read.facts.self_reported_minutes, 0); eq(read.facts.self_reported_minutes_days, 1)
    eq(read.fingerprint !== workspace.fingerprint, true)
    await rejects(() => service.review('owner', { ...request, request_id: 'stale-evidence', fingerprint: workspace.fingerprint }), /已有变化/)
    const snapshot = (await service.collect('owner', request)).snapshot
    eq(facts.parseModel(output, snapshot).suggestions[0].evidence[0].label, '已结束日期的任务统计')
    throws(() => facts.parseModel(output.replace('coverage', 'invented'), snapshot), /无效证据/)
    throws(() => facts.parseModel('not JSON', snapshot), /解析/)
    const payload = JSON.parse(output), prompt = facts.messages(snapshot), input = JSON.parse(prompt[1].content)
    eq(input.allowed_evidence_ids, facts.evidence(snapshot).map(e => e.id))
    eq(prompt[0].content.includes('给定ID'), false)
    eq(prompt[0].content.includes('evidence_ids只能逐字复制'), true)
    payload.observations[0].evidence_ids = [' coverage ', 'coverage']
    eq(facts.parseModel(JSON.stringify(payload), snapshot).observations[0].evidence.map(e => e.id), ['coverage'])
    payload.observations[0].evidence_ids = ['记录覆盖与数据缺口']
    throws(() => facts.parseModel(JSON.stringify(payload), snapshot), /无效证据/)
    payload.observations[0].evidence_ids = [{ id: 'coverage' }]
    throws(() => facts.parseModel(JSON.stringify(payload), snapshot), /引用格式/)
    payload.observations[0].evidence_ids = ['coverage']; payload.observations[0].message = '过'.repeat(401)
    throws(() => facts.parseModel(JSON.stringify(payload), snapshot), /条目格式/)
    gate = defer(); const reviewing = service.review('owner', { ...request, request_id: 'review1', fingerprint: read.fingerprint })
    while (!calls) await new Promise(r => setImmediate(r))
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => service.review('owner', { ...request, request_id: 'review1', fingerprint: read.fingerprint })))
    eq(duplicates.every(r => r.cached && r.report.status === 'running'), true); eq(calls, 1)
    gate.resolve(); gate = null
    eq((await reviewing).report.status, 'done')
    eq((await service.review('owner', { ...request, request_id: 'another', fingerprint: read.fingerprint })).cached, true)
    eq(calls, 1); eq(JSON.stringify(prompts).includes('private-synthetic-key'), false)
    eq(JSON.parse(prompts[1].content).feedbacks[0].values.note, '今天加班')
    eq(JSON.stringify(env.rows.ai_plans).includes('private-synthetic-key'), false)
    env.mutate('tasks', 'today', { completed: true })
    const changed = await service.get('owner', request)
    eq(changed.report, null); eq(changed.fingerprint !== read.fingerprint, true)
    failure = 'provider unavailable'
    const review = id => service.review('owner', { ...request, request_id: id, fingerprint: changed.fingerprint })
    eq((await review('f1')).report.status, 'failed'); eq((await review('f1')).cached, true); eq(calls, 2)
    eq((await review('f2')).report.attempt, 2); await review('f1'); eq(calls, 3)
    eq((await review('f3')).report.retry_available, false)
    await rejects(() => review('f4'), /3次/)
    eq(calls, 4)
    eq((await service.get('owner', request)).report.retry_hint.includes('反馈仍保留'), true)
    const concurrent = await Promise.allSettled(['a', 'b'].map(id => service.saveFeedback('owner', { ...savedRequest, expected_revision: 1, request_id: 'parallel-' + id, values: { note: id } })))
    eq(concurrent.filter(r => r.status === 'fulfilled').length, 1)
    eq((await service.saveFeedback('owner', savedRequest)).current_revision, 2)
    eq(env.stats.conflicts > 0, true)
    failure = ''
    const fresh = await service.get('owner', request)
    const stuck = gate = defer()
    const before = calls
    const interrupted = { ...request, request_id: 'interrupted', fingerprint: fresh.fingerprint }
    const reviewingAgain = service.review('owner', interrupted)
    while (calls === before) await new Promise(resolve => setImmediate(resolve))
    at += 60000
    const expired = (await service.get('owner', request)).report
    eq(expired.status, 'failed'); eq(expired.retry_available, true)
    eq((await service.review('owner', interrupted)).cached, true); eq(calls, before + 1)
    gate = null
    const recovered = await service.review('owner', { ...interrupted, request_id: 'recover-expired' })
    eq(recovered.report.attempt, 2); eq(recovered.report.status, 'done')
    const stale = rejects(() => reviewingAgain, /复盘状态已变化/)
    stuck.resolve()
    await stale
    eq((await service.get('owner', request)).report.status, 'done')
  } finally { env.close() }
  await paginationAndFaults()
  await router()
  console.log('coach-reliability: ' + checks + ' assertions passed (offline)')
}
async function paginationAndFaults() {
  const data = seed(); data.tasks = Array.from({ length: 205 }, (_, i) => task('t' + String(i).padStart(3, '0'), '2026-11-05', i % 2 === 0)).reverse()
  const env = offlineCloudbase(data)
  try {
    const service = createService({ cloud: env.cloud, now: () => now, loadModel: async () => { throw Error('no') }, callModel: async () => '' })
    eq((await service.get('owner', request)).facts.past.total, 205)
    env.mutate('tasks', 't000', { completed: 'true', estimated_minutes: undefined })
    const unknown = await service.get('owner', request)
    eq(unknown.facts.past.rate, null); eq(unknown.facts.past.unknown, 1); eq(unknown.facts.past.missing_estimated_minutes, 1)
    const empty = await service.get('owner', { ...request, date: '2026-10-01' })
    eq(empty.facts.past.rate, null); eq(empty.facts.has_evidence, false)
    await rejects(() => service.review('owner', { ...request, date: '2026-10-01', request_id: 'empty', fingerprint: empty.fingerprint }), /暂时没有/)
  } finally { env.close() }
  const large = seed(); large.tasks = Array.from({ length: 501 }, (_, i) => task('t' + String(i).padStart(3, '0'), '2026-11-05', true))
  const capped = offlineCloudbase(large)
  try {
    const service = createService({ cloud: capped.cloud, now: () => now })
    const workspace = await service.get('owner', request)
    eq(workspace.facts.complete, false); eq(workspace.facts.total_read, 500); eq(workspace.facts.past.rate, null)
    await rejects(() => service.review('owner', { ...request, request_id: 'capped', fingerprint: workspace.fingerprint }), /未读全/)
  } finally { capped.close() }
  const failed = offlineCloudbase(seed(), { beforeRequest(command, args) { if (command === 'database.getDocument' && args.collectionName === 'tasks') throw Error('read unavailable') } })
  try { await rejects(() => createService({ cloud: failed.cloud, now: () => now }).get('owner', request), /read unavailable/) } finally { failed.close() }
}
async function router() {
  const data = seed(); data.api_keys = [{ _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'private-synthetic-key', model: 'deepseek-chat' }]
  data.users = [{ _id: 'user', _openid: 'owner' }]
  const env = offlineCloudbase(data); let sent, headers, calls = 0
  try {
    const back = path.resolve(__dirname, '../cloudfunctions/app/index.js'), req = createRequire(back)
    const https = { request(options, callback) {
      headers = options.headers
      const request = new EventEmitter(); request.write = body => { sent = JSON.parse(body); calls++ }; request.destroy = () => {}
      request.end = () => { const response = new EventEmitter(); response.statusCode = 200; callback(response); response.emit('data', JSON.stringify({ choices: [{ message: { content: output } }] })); response.emit('end') }
      return request
    } }
    const ctx = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : req(n), exports: {}, URL, Buffer,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout })
    vm.runInContext(fs.readFileSync(back, 'utf8'), ctx)
    const run = (action, data = {}) => ctx.exports.main({ action, data })
    eq((await run('getCoachGoals')).data.goals.map(g => g._id), ['g1'])
    const workspace = await run('getCoachWorkspace', request)
    eq(workspace.code, 0)
    const result = await run('reviewCoach', { ...request, fingerprint: workspace.data.fingerprint, request_id: 'native-review',
      openid: 'other', provider: 'qwen', apiKey: 'caller-key', model: 'caller-model' })
    eq(result.code, 0); eq(result.data.report.status, 'done'); eq(calls, 1)
    eq(sent.model, 'deepseek-chat'); eq(headers.Authorization, 'Bearer private-synthetic-key')
    eq(sent.response_format, { type: 'json_object' }); eq(sent.temperature, 0.2)
    eq(JSON.stringify(result).includes('private-synthetic-key'), false)
    eq(JSON.stringify(env.rows.ai_plans).includes('private-synthetic-key'), false)
    eq((await run('aiDoGenerate', { plan_id: result.data.report.id })).code, -1)
    eq((await run('aiPollPlan', { plan_id: result.data.report.id })).code, -1)
    const date = require('../cloudfunctions/app/lib/taskRules').businessDate()
    eq((await run('publishAiPlan', { publication_id: 'coach-not-a-plan', source_plan_id: result.data.report.id,
      goal: { title: '不能把复盘当计划', target_days: 1, start_date: date }, tasks: [{ title: '测试', date, estimated_minutes: 10, xp_reward: 10, stage: 1 }] })).code, -1)
    eq((await run('getCoachWorkspace', { ...request, goal_id: 'foreign' })).code, -1); eq(calls, 1)
    await ctx.callLLM('https://api.deepseek.com', 'synthetic', 'deepseek-chat', [], 100)
    eq(sent.response_format === undefined, true); eq(sent.temperature, 0.7)
    await ctx.callLLM('https://example.com/v1', 'synthetic', 'custom-model', [], 100, { jsonObject: true })
    eq(sent.response_format === undefined, true); eq(sent.temperature, 0.7)
  } finally { env.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
