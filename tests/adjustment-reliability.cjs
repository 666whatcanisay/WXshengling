const assert = require('node:assert/strict')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService } = require('../cloudfunctions/app/lib/adjustmentService')
const { createService: createCoach } = require('../cloudfunctions/app/lib/coachService')
const { createAdjustmentGraph } = require('../cloudfunctions/app/lib/stewardGraph.cjs')
const rules = require('../cloudfunctions/app/lib/adjustmentRules')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events'), { createRequire } = require('node:module')
const now = Date.parse('2026-11-06T12:00:00+08:00'), input = { goal_id: 'g1', date: '2026-11-06' }
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const reject = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++ }
const task = (id, date, extra = {}) => ({ _id: id, _openid: 'owner', goal_id: 'g1', title: id, date, completed: false, estimated_minutes: 20, xp_reward: 10, ...extra })
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: () => resolve() } }
async function main() {
  const seed = { goals: [{ _id: 'g1', _openid: 'owner', title: '阅读', status: 'active', start_date: '2026-11-01', end_date: '2026-11-30' }], ai_plans: [], tasks: [
    task('future1', '2026-11-07'), task('future2', '2026-11-08'), task('today', '2026-11-06'), task('past', '2026-11-05'),
    task('done', '2026-11-07', { completed: true }), task('foreign', '2026-11-07', { _openid: 'other' }), task('deleted', '2026-11-07', { status: 'deleted' })] }
  const env = offlineCloudbase(seed); let calls = 0, failure = '', gate = null, planOutput = null
  const service = createService({ cloud: env.cloud, coach: createCoach({ cloud: env.cloud, now: () => now }), now: () => now,
    graphFactory: createAdjustmentGraph, loadModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    callModel: async (config, messages) => {
      calls++; if (gate) await gate.promise; if (failure) throw Error(failure)
      if (messages[0].content.includes('调整规划师')) return JSON.stringify(planOutput || { changes: [{ task_id: 'future1', title: '读5页', date: '2026-11-07', estimated_minutes: 10, reason: '根据本轮减少负担的明确要求' }] })
      return JSON.stringify({ summary: '调整降低单次安排，实际效果仍需反馈。', findings: [{ task_id: 'future1', message: '可以先试一次再记录感受。' }] })
    } })
  const runStep = (run, n) => service.step('owner', { run_id: run.id, request_id: 'step-' + n })
  async function finish(run, prefix) {
    for (let i = 0; i < 7 && run.status === 'ready'; i++) run = (await runStep(run, prefix + i)).run
    return run
  }
  try {
    const originalTasks = structuredClone(env.rows.tasks), workspace = await service.get('owner', input)
    eq(workspace.snapshot.tasks.map(t => t.id), ['future1', 'future2']); eq(workspace.snapshot.start, '2026-11-07'); eq(workspace.snapshot.end, '2026-11-13')
    eq(workspace.run, null); eq(calls, 0)
    await reject(() => service.get('other', input), /目标不存在/)
    await reject(() => service.get('', input), /登录/)
    const request = { ...input, request_id: 'start1', fingerprint: workspace.fingerprint, instructions: '每次先做10分钟，每天最多20分钟', daily_minutes: 20 }
    const initial = (await service.start('owner', request)).run
    eq(initial.status, 'ready'); eq((await service.start('owner', request)).run.id, initial.id); eq(calls, 0)
    await reject(() => service.start('owner', { ...request, instructions: '偷偷替换' }), /同一请求/)
    await reject(() => service.start('owner', { ...request, request_id: 'other-active' }), /已有调整/)
    await reject(() => service.step('other', { run_id: initial.id, request_id: 'spoof' }), /不存在/)
    let run = await finish(initial, 'first')
    eq(run.status, 'awaiting_review'); eq(run.revision, 1); eq(run.is_current, true); eq(run.diff[0].before.title, 'future1'); eq(run.diff[0].after.title, '读5页')
    eq(run.rules.error_count, 0); eq(run.review.revision, 1); eq(calls, 2); eq(env.rows.tasks, originalTasks)
    eq((await service.step('owner', { run_id: run.id, request_id: 'terminal' })).cached, true); eq(calls, 2)
    eq(env.rows.ai_plans.every(row => row.kind === 'adjustment_state' && !row.result), true)
    const edits = run.changes.map(c => ({ ...c, estimated_minutes: 5 }))
    const saved = await service.save('owner', { run_id: run.id, expected_revision: 1, changes: edits, instructions: '保持每天20分钟以内', daily_minutes: 20 })
    eq(saved.run.revision, 2); eq(saved.run.review, null); eq(saved.run.rules, null); eq(saved.run.status, 'ready')
    await reject(() => service.save('owner', { run_id: run.id, expected_revision: 1, changes: edits, instructions: '旧版本不能覆盖' }), /版本/)
    run = await finish(saved.run, 'edited'); eq(run.status, 'awaiting_review'); eq(run.review.revision, 2); eq(calls, 3); eq(env.rows.tasks, originalTasks)
    const newer = (await service.start('owner', { ...request, request_id: 'newer-head' })).run
    await reject(() => service.save('owner', { run_id: run.id, expected_revision: 2, changes: edits, instructions: '旧运行不能覆盖新草案' }), /更新的调整/)
    await reject(() => runStep(run, 'superseded'), /更新的调整/)
    eq((await service.start('owner', request)).run.is_current, false)
    await service.cancel('owner', { run_id: newer.id })
    await service.cancel('owner', { run_id: run.id })
    eq((await service.get('owner', input)).run.status, 'cancelled'); eq(calls, 3)
    const fresh = (await service.start('owner', { ...request, request_id: 'cancel-race' })).run
    const managed = (await runStep(fresh, 'manager')).run
    gate = deferred(); const pending = runStep(managed, 'model')
    while (calls < 4) await new Promise(r => setImmediate(r))
    const duplicate = await runStep(managed, 'model')
    eq(duplicate.run.status, 'running'); eq(calls, 4)
    await service.cancel('owner', { run_id: managed.id }); gate.resolve(); await pending; gate = null
    eq((await service.get('owner', input)).run.status, 'cancelled'); eq((await service.get('owner', input)).run.changes, null)
    const stale = (await service.start('owner', { ...request, request_id: 'stale' })).run
    env.mutate('tasks', 'future1', { completed: true })
    eq((await service.get('owner', input)).run.is_current, false)
    await reject(() => runStep(stale, 'stale'), /已变化/)
    eq(calls, 4)
    await service.cancel('owner', { run_id: stale.id })
    const freshWorkspace = await service.get('owner', input)
    failure = 'model unavailable'
    const failedStart = (await service.start('owner', { ...request, request_id: 'failure', fingerprint: freshWorkspace.fingerprint })).run
    run = await finish(failedStart, 'failed'); eq(run.status, 'failed'); eq(calls, 5)
    await runStep(run, 'no-auto-retry'); eq(calls, 5)
    const snap = workspace.snapshot
    eq(rules.fingerprint({ b: 1, a: { z: 2, y: 3 } }), rules.fingerprint({ a: { y: 3, z: 2 }, b: 1 }))
    for (const c of [{ ...edits[0], task_id: 'today' }, { ...edits[0], date: '2026-11-06' }, { ...edits[0], completed: true }, { ...edits[0], xp_reward: 999 }, { ...edits[0], estimated_minutes: 0 }]) {
      assert.throws(() => rules.changes([c], snap), /越权|日期|未知/); checks++
    }
    eq(rules.check(snap, [{ ...edits[0], date: '2026-11-08', estimated_minutes: 20 }], { daily_minutes: 20 }).error_count, 1)
    env.mutate('tasks', 'future2', { completed: true })
    const empty = await service.get('owner', input)
    eq(empty.snapshot.tasks.length, 0)
    await reject(() => service.start('owner', { ...request, request_id: 'empty', fingerprint: empty.fingerprint }), /没有可调整/)
    for (const value of [true, {}, ' ', '1e2', 0, 1441]) { assert.throws(() => rules.requirements({ instructions: '降低负担', daily_minutes: value }), /格式|分钟/); checks++ }
    assert.throws(() => rules.semantic(JSON.stringify({ summary: '测试', findings: [{ task_id: 'forged', message: '越权引用' }] }), edits), /引用/); checks++
    await service.cancel('owner', { run_id: failedStart.id })
    env.mutate('tasks', 'future2', { completed: false }); failure = ''; planOutput = { changes: [] }
    const noChangeWorkspace = await service.get('owner', input)
    const noChange = await finish((await service.start('owner', { ...request, request_id: 'nochange', fingerprint: noChangeWorkspace.fingerprint })).run, 'nochange')
    eq(noChange.status, 'awaiting_review'); eq(noChange.review, null); eq(noChange.changes, []); eq(calls, 6)
  } finally { env.close() }
  const cap = offlineCloudbase({ ...seed, tasks: Array.from({ length: 21 }, (_, i) => task('cap' + i, '2026-11-07')) })
  try {
    const c = createService({ cloud: cap.cloud, coach: createCoach({ cloud: cap.cloud, now: () => now }), now: () => now })
    const w = await c.get('owner', input); eq(w.snapshot.complete, false)
    await reject(() => c.start('owner', { ...input, request_id: 'cap', fingerprint: w.fingerprint, instructions: '减少任务时长' }), /超过20/)
    cap.mutate('goals', 'g1', { status: 'done' })
    const ended = await c.get('owner', input); eq(ended.snapshot.eligible, false)
    await reject(() => c.start('owner', { ...input, request_id: 'ended', fingerprint: ended.fingerprint, instructions: '缩短任务' }), /目标已结束/)
    cap.mutate('goals', 'g1', { status: 'active', end_date: input.date })
    const expired = await c.get('owner', input); eq(expired.snapshot.eligible, false)
    await reject(() => c.start('owner', { ...input, request_id: 'expired', fingerprint: expired.fingerprint, instructions: '缩短任务' }), /周期已结束/)
  } finally { cap.close() }
  await coachSuggestion(seed)
  await router()
  console.log('adjustment-reliability: ' + checks + ' assertions passed (actual LangGraph/SDK offline; no real cloud/model)')
}
async function coachSuggestion(seed) {
  const env = offlineCloudbase(seed)
  let plannedInput
  const model = async () => ({ provider: 'deepseek', model: 'deepseek-chat' })
  const coach = createCoach({ cloud: env.cloud, now: () => now, loadModel: model, callModel: async () => JSON.stringify({
    summary: '基于登记结果复盘', observations: [], uncertainties: [],
    suggestions: [{ message: '缩短阅读', action: '先读十分钟', evidence_ids: ['past'] }]
  }) })
  const service = createService({ cloud: env.cloud, coach, now: () => now, graphFactory: createAdjustmentGraph, loadModel: model,
    callModel: async (_, messages) => {
      plannedInput = JSON.parse(messages[1].content)
      return JSON.stringify({ changes: [] })
    } })
  try {
    const before = await coach.get('owner', input)
    const { report } = await coach.review('owner', { ...input, fingerprint: before.fingerprint, request_id: 'review-selection' })
    const ref = { report_id: report.id, fingerprint: report.fingerprint, index: 0 }
    const w = await service.get('owner', input)
    const request = { ...input, fingerprint: w.fingerprint, request_id: 'selected', instructions: '优先保留原时间' }
    await reject(() => service.start('owner', { ...request, coach_suggestion: { ...ref, index: 1 } }), /教练建议已变化/)
    const { run } = await service.start('owner', { ...request, coach_suggestion: { ...ref, action: '伪造内容' } })
    eq(run.requirements.coach_suggestion.action, '先读十分钟')
    eq(run.requirements.instructions, '优先保留原时间')
    eq(run.requirements.coach_suggestion.evidence[0].id, 'past')
    await service.step('owner', { run_id: run.id, request_id: 'chosen-manager' })
    await service.step('owner', { run_id: run.id, request_id: 'chosen-plan' })
    eq(plannedInput.requirements.coach_suggestion.reference, ref)
    env.mutate('tasks', 'past', { completed: true })
    const refreshed = await service.get('owner', input)
    await reject(() => service.start('owner', { ...request, fingerprint: refreshed.fingerprint, coach_suggestion: ref }), /教练建议已变化/)
  } finally { env.close() }
}
async function router() {
  const dates = require('../cloudfunctions/app/lib/taskRules'), today = dates.businessDate(), tomorrow = dates.addDays(today, 1)
  const original = { _id: 'g1', _openid: 'owner', title: '测试', status: 'active', start_date: today, end_date: dates.addDays(today, 30) }
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], goals: [original], ai_plans: [], tasks: [task('native-task', tomorrow)], api_keys: [{ _id: 'config', _openid: 'owner', provider: 'deepseek', api_key: 'private-synthetic-key', model: 'deepseek-chat' }] })
  let calls = 0, sent
  const https = { request(options, callback) {
    const req = new EventEmitter(); req.destroy = () => {}; req.write = body => { sent = JSON.parse(body); calls++ }
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200; callback(res); res.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify(sent.messages[0].content.includes('调整规划师') ? { changes: [{ task_id: 'native-task', title: '短任务', date: tomorrow, estimated_minutes: 10, reason: '明确本轮要求' }] } : { summary: '按真实任务检查本轮改动', findings: [] }) } }] })); res.emit('end') }; return req
  } }
  try {
    const file = path.resolve(__dirname, '../cloudfunctions/app/index.js'), req = createRequire(file)
    const ctx = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : req(n), exports: {}, URL, Buffer, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout })
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx)
    const run = (action, data) => ctx.exports.main({ action, data })
    const w = await run('getAdjustmentWorkspace', { goal_id: 'g1', date: today }); eq(w.code, 0); eq(calls, 0)
    let r = await run('startAdjustment', { goal_id: 'g1', date: today, request_id: 'native', fingerprint: w.data.fingerprint, instructions: '每天先做10分钟', daily_minutes: 10, openid: 'other', apiKey: 'spoof', provider: 'qwen' })
    eq(r.code, 0)
    for (let i = 0; i < 6 && r.data.run.status === 'ready'; i++) r = await run('stepAdjustment', { run_id: r.data.run.id, request_id: 'native-step-' + i })
    eq(r.data.run.status, 'awaiting_review'); eq(calls, 2); eq(sent.model, 'deepseek-chat'); eq(sent.response_format, { type: 'json_object' })
    eq(JSON.stringify(r).includes('private-synthetic-key'), false); eq(JSON.stringify(env.rows.ai_plans).includes('private-synthetic-key'), false)
    const record = env.rows.ai_plans.find(x => x.logical.startsWith('run/'))
    eq((await run('aiDoGenerate', { plan_id: record._id })).code, -1)
    eq((await run('aiPollPlan', { plan_id: record._id })).code, -1)
    eq((await run('publishAiPlan', { publication_id: 'adjust-not-plan', source_plan_id: record._id,
      goal: { title: '非法来源', target_days: 1, start_date: tomorrow }, tasks: [{ title: '非法', date: tomorrow, estimated_minutes: 10, xp_reward: 10, stage: 1 }] })).code, -1)
    eq((await run('applyAdjustment', { run_id: r.data.run.id })).code, -1)
    eq(env.rows.goals, [original]); eq(env.rows.tasks[0].title, 'native-task'); eq(env.rows.tasks[0].xp_reward, 10)
    const confirmation = { run_id:r.data.run.id, expected_revision:r.data.run.revision, confirmation:r.data.run.confirmation }
    eq((await run('getAdjustmentWorkspace', {goal_id:'g1',date:today})).data.applicationSupported,true)
    eq((await run('checkAdjustment',confirmation)).data.run.can_apply,true)
    const applied=await run('applyAdjustment', {...confirmation,openid:'other',changes:[],xp_reward:900})
    eq(applied.code,0);eq(applied.data.application.count,1);eq(env.rows.tasks[0].estimated_minutes,10);eq(env.rows.tasks[0].xp_reward,10)
    eq((await run('getAdjustmentApplication',confirmation)).data.application.id,applied.data.application.id);eq(calls,2)
  } finally { env.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
