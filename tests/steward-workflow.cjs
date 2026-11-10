// Real graph + handlers + installed SDK using offline DB/HTTPS; no cloud/model calls.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict')
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createStore } = require('../cloudfunctions/app/lib/plannerDrafts')
const { createService } = require('../cloudfunctions/app/lib/stewardRuns')
const { createGraph } = require('../cloudfunctions/app/lib/stewardGraph.cjs')
const { spawnSync } = require('node:child_process'), os = require('node:os')
const { createHash } = require('node:crypto')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const rejects = async (fn, re) => { await assert.rejects(fn, re); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function backend(env, model) {
  const file = path.resolve(__dirname, '../cloudfunctions/app/index.js'), req = createRequire(file)
  const https = { request(options, callback) {
    const request = new EventEmitter(); let payload
    request.write = body => { payload = JSON.parse(body) }; request.destroy = () => {}
    request.end = async () => {
      const response = new EventEmitter(); response.statusCode = 200
      const content = await model(payload)
      callback(response); response.emit('data', JSON.stringify({ choices: [{ message: { content } }] })); response.emit('end')
    }; return request
  } }
  const ctx = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : req(n), exports: {}, URL, Buffer,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx)
  const run = (action, data = {}) => ctx.exports.main({ action, data })
  run.doGenerate = ctx.aiDoGenerate
  return run
}
async function main() {
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [], api_keys: [{ _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'private-synthetic-key', model: 'deepseek-chat' }] })
  let calls = 0
  const model = async payload => {
    calls++
    if (payload.messages[0].content.includes('独立计划审核师')) return JSON.stringify({ summary: '安排可进一步细化，需核对实际条件。', findings: [] })
    return JSON.stringify({ goal: { title: '10天游泳', period_days: 10 }, tasks: [{ title: '呼吸练习', estimated_minutes: 15, xp_reward: 10, stage: 1, day_index: 1 }] })
  }
  try {
    let run = backend(env, model)
    eq((await run('getStewardRun')).data.run, null)
    const request = { request_id: 'start1', mode: 'new', demand: '我想游泳，计划10天，每天20分钟，我是新手', expected_revision: 0 }
    const started = await run('startStewardRun', request)
    eq(started.code, 0); eq(started.data.run.status, 'ready')
    const id = started.data.run.id
    eq((await run('startStewardRun', request)).data.run.id, id)
    eq((await run('startStewardRun', { ...request, request_id: 'another' })).code, -1)
    eq((await run('stepStewardRun', { run_id: id, request_id: 'step1' })).data.run.next, 'planner')
    eq(calls, 0)
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forest-steward-test-')), snapshot = path.join(temp, 'rows.json')
    fs.writeFileSync(snapshot, JSON.stringify({ rows: env.rows, id }))
    const child = spawnSync(process.execPath, [__filename, '--resume', snapshot], { encoding: 'utf8', timeout: 20000 })
    assert.equal(child.status, 0, child.stderr); checks++
    eq(JSON.parse(child.stdout), { next: 'rules', calls: 1 })
    fs.unlinkSync(snapshot); fs.rmdirSync(temp)
    eq((await run('stepStewardRun', { run_id: id, request_id: 'step1' })).data.cached, true)
    eq(calls, 0)
    // New handler/module instance resumes the durable graph, not a MemorySaver.
    run = backend(env, model)
    const planned = await run('stepStewardRun', { run_id: id, request_id: 'step2' })
    assert(planned.data, JSON.stringify(planned)); assert.equal(planned.data.run.status, 'ready', planned.data.run.error); checks++; eq(planned.data.run.next, 'rules')
    eq(calls, 1); eq(planned.data.run.draft_revision, 1)
    const generation = env.rows.ai_plans.find(r => r.steward_run_id === id)
    eq((await run('aiDoGenerate', { plan_id: generation._id })).code, -1); eq(calls, 1)
    const checked = await run('stepStewardRun', { run_id: id, request_id: 'step3' })
    eq(checked.data.run.next, 'review'); eq(checked.data.run.rules.status, 'done'); eq(calls, 1)
    const reviewed = await run('stepStewardRun', { run_id: id, request_id: 'step4' })
    eq(reviewed.data.run.status, 'awaiting_confirmation'); eq(reviewed.data.run.review.status, 'done'); eq(calls, 2)
    eq(reviewed.data.run.steps.every(s => s.status === 'done'), true)
    eq(JSON.stringify(env.rows.ai_plans).includes('private-synthetic-key'), false)
    const loaded = await backend(env, model)('getStewardRun')
    eq(loaded.data.run.status, 'awaiting_confirmation'); eq(calls, 2)
    eq((await run('stepStewardRun', { run_id: id, request_id: 'extra' })).data.run.status, 'awaiting_confirmation'); eq(calls, 2)
    const store = createStore(env.cloud), current = await store.get('owner')
    const standalone = { ...current.draft.snapshot, publication_id: 'omitted', source_plan_id: generation._id }
    eq(current.draft.steward_run_id, id)
    eq((await run('publishAiPlan', standalone)).rejected, true)
    eq((await run('publishAiPlan', { ...standalone, steward: { ...loaded.data.run.handoff, run_id: 'wrong' } })).rejected, true)
    eq((await run('publishAiPlan', { ...standalone, source_plan_id: '' })).rejected, true)
    const recordId = 'pub_' + createHash('sha256').update(JSON.stringify(['owner', 'source', generation._id])).digest('hex')
    env.rows.ai_plans.push({ _id: recordId, _openid: 'owner', kind: 'plan_publication',
      status: 'publication_pending', source_plan_id: generation._id, createdAt: 123 })
    eq((await run('publishAiPlan', standalone)).rejected, true)
    const recovered = await run('publishAiPlan', { ...standalone, steward: loaded.data.run.handoff })
    eq(recovered.success, true)
    eq((await run('publishAiPlan', { ...standalone, steward: loaded.data.run.handoff })).goal_id, recovered.goal_id)
    eq((await run('publishAiPlan', standalone)).rejected, true)
    eq(env.rows.goals.length, 1)
    const independent = await run('publishAiPlan', { ...standalone, source_plan_id: '', publication_id: 'independent',
      goal: { ...standalone.goal, title: '单独规划的目标' } })
    eq(independent.success, true)
    eq(env.rows.goals.length, 2)
    const service = createService({ cloud: env.cloud, drafts: store,
      reviews: { get: async () => ({ review: null }) }, generate: async () => { throw Error('must not call') }, graphFactory: createGraph })
    eq((await service.get('other', { run_id: id })).run, null)
    await rejects(() => service.step('other', { run_id: id, request_id: 'foreign' }), /不存在/)
    const draftOnly = await service.start('owner', { request_id: 'draft-only', mode: 'draft', expected_revision: current.revision })
    eq(draftOnly.run.steps[1].status, 'skipped')
    await service.cancel('owner', { run_id: draftOnly.run.id })
    eq((await service.step('owner', { run_id: draftOnly.run.id, request_id: 'cancelled' })).run.status, 'cancelled')
    eq((await run('startStewardRun', { request_id: 'smalltalk', mode: 'new', demand: '先了解一下你', expected_revision: 1 })).code, -1)
  } finally { env.close() }
  await failureScenarios()
  await publicationHandoff()
  console.log('steward-workflow: ' + checks + ' assertions passed (offline)')
}
async function publicationHandoff() {
  let interruptCommit = false, calls = 0
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [], goals: [], tasks: [], api_keys: [
    { _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-key', model: 'deepseek-chat' }
  ] }, { beforeRequest(command, args) {
    if (interruptCommit && command === 'database.modifyDocument' && args.collectionName === 'ai_plans' &&
        args.data.includes('"published"')) {
      interruptCommit = false
      throw Error('publication interrupted after acceptance')
    }
  } })
  try {
    const model = async () => { calls++; return JSON.stringify({ summary: '语义建议', findings: [] }) }
    const api = backend(env, model)
    const date = require('../cloudfunctions/app/lib/taskRules').businessDate()
    const snapshot = { goal: { title: '阅读', target_days: 7, start_date: date, stages: [] },
      tasks: [{ draft_task_id: 'read', title: '阅读25分钟', date, estimated_minutes: 25, xp_reward: 10, stage: 1 }] }
    const save = (request_id, expected_revision, steward, value = snapshot) =>
      api('savePlannerDraft', { request_id, expected_revision, steward, conversation_id: 'chat', messages: [], snapshot: value })
    eq((await save('original', 0)).data.revision, 1)
    let run = (await api('startStewardRun', { request_id: 'handoff', mode: 'draft', expected_revision: 1 })).data.run
    for (let i = 0; i < 4 && run.status === 'ready'; i++) run = (await api('stepStewardRun', { run_id: run.id, request_id: 'handoff-' + i })).data.run
    const original = run.handoff
    eq(original.binding.revision, 1)
    eq(calls, 1)
    eq((await save('bad-limit', 1, original, { ...snapshot, daily_max_minutes: 1441 })).code, -1)
    const capped = { ...snapshot, daily_max_minutes: 20 }
    eq((await save('set-limit', 1, original, capped)).data.revision, 2)
    eq((await save('set-limit', 1, original, capped)).data.revision, 2)
    run = (await api('getStewardRun')).data.run
    eq(run.handoff.binding.revision, 2)
    eq(run.rules, null)
    eq(run.review, null)
    const check = (steward, request_id) => api('reviewPlannerDraft', { mode: 'rules', binding: steward.binding, request_id })
    const publish = (steward, value) => api('publishAiPlan', { publication_id: 'final', steward, ...value })
    const blocked = (await check(run.handoff, 'check-cap')).data.review.rules
    eq(blocked.findings.find(f => f.code === 'daily_max_minutes').task_ids, ['read'])
    eq((await publish(run.handoff, capped)).rejected, true)
    eq((await publish(undefined, capped)).rejected, true)
    eq((await save('strip-handoff', 2, undefined, { ...capped, daily_max_minutes: null })).code, -1)
    eq((await publish(undefined, { ...capped, cloud_draft_revision: 2,
      tasks: [{ ...snapshot.tasks[0], estimated_minutes: 22 }] })).rejected, true)
    eq(env.rows.goals.length, 0)
    const edited = { ...capped, tasks: [{ ...snapshot.tasks[0], title: '阅读20分钟', estimated_minutes: 20 }] }
    eq((await save('reduce', 2, run.handoff, edited)).data.revision, 3)
    run = (await api('getStewardRun')).data.run
    eq((await publish(original, snapshot)).rejected, true)
    eq((await publish(run.handoff, edited)).rejected, true)
    eq((await check(run.handoff, 'check-fixed')).data.review.rules.error_count, 0)
    eq((await publish(run.handoff, { ...edited, tasks: snapshot.tasks })).rejected, true)
    interruptCommit = true
    eq((await publish(run.handoff, edited)).code, -1)
    eq(env.rows.goals.length, 0)
    eq(env.rows.tasks.length, 0)
    const recovered = backend(env, model)
    const pending = (await recovered('getStewardRun')).data.run
    eq(pending.status, 'publication_pending')
    eq((await recovered('cancelStewardRun', { run_id: run.id })).data.run.status, 'publication_pending')
    eq(pending.pending_publication.tasks[0].estimated_minutes, 20)
    eq((await recovered('publishAiPlan', { ...pending.pending_publication, steward: undefined })).rejected, true)
    const receipt = await recovered('publishAiPlan', pending.pending_publication)
    eq(receipt.success, true)
    eq((await publish(run.handoff, edited)).goal_id, receipt.goal_id)
    eq(env.rows.goals.length, 1)
    eq(env.rows.tasks.length, 1)
    eq((await recovered('getStewardRun')).data.run.publication_receipt, receipt)
    eq(calls, 1)
  } finally { env.close() }
}
async function failureScenarios() {
  const seed = { users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [], api_keys: [{ _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-key', model: 'deepseek-chat' }] }
  // Cancellation fences late draft saves; concurrent step calls share one operation.
  const env = offlineCloudbase(seed), pending = defer()
  let calls = 0
  try {
    const run = backend(env, async () => { calls++; await pending.promise; return JSON.stringify({ goal: { title: '跑步', period_days: 7 }, tasks: [{ title: '走跑', estimated_minutes: 10, xp_reward: 10, stage: 1 }] }) })
    const first = (await run('startStewardRun', { request_id: 'cancel', mode: 'new', demand: '我想跑步，每天20分钟', expected_revision: 0 })).data.run
    await run('stepStewardRun', { run_id: first.id, request_id: 'manager' })
    const executing = run('stepStewardRun', { run_id: first.id, request_id: 'planning' })
    while (!calls) await new Promise(r => setImmediate(r))
    const duplicates = await Promise.all(Array.from({ length: 8 }, (_, i) => run('stepStewardRun', { run_id: first.id, request_id: 'race' + i })))
    eq(duplicates.every(r => r.code === 0 && r.data.run.status === 'running'), true); eq(calls, 1)
    eq((await run('cancelStewardRun', { run_id: first.id })).data.run.status, 'cancelled')
    pending.resolve(); eq((await executing).data.run.status, 'cancelled')
    eq((await createStore(env.cloud).get('owner')).draft, null)
    eq(env.rows.ai_plans.some(r => r.kind === 'planner_draft_version'), false)
  } finally { env.close() }
  // Failed model output is explicit and replay/recovery never repeats its call.
  const bad = offlineCloudbase(seed); let badCalls = 0
  try {
    const run = backend(bad, async () => { badCalls++; return 'invalid JSON' })
    const first = (await run('startStewardRun', { request_id: 'failed', mode: 'new', demand: '我想阅读', expected_revision: 0 })).data.run
    await run('stepStewardRun', { run_id: first.id, request_id: 'manager' })
    const failed = await run('stepStewardRun', { run_id: first.id, request_id: 'bad' })
    eq(failed.data.run.status, 'failed'); eq(failed.data.run.steps[1].status, 'failed'); eq(badCalls, 1)
    await run('stepStewardRun', { run_id: first.id, request_id: 'bad' })
    await run('stepStewardRun', { run_id: first.id, request_id: 'recover', recover: true })
    eq(badCalls, 1); eq((await createStore(bad.cloud).get('owner')).revision, 0)
  } finally { bad.close() }
  // Existing incomplete drafts stop at field problems without a semantic model call.
  const invalid = offlineCloudbase({ ai_plans: [] }); let semanticCalls = 0
  try {
    const drafts = createStore(invalid.cloud), today = require('../cloudfunctions/app/lib/taskRules').businessDate()
    await drafts.save('owner', { expected_revision: 0, request_id: 'save', conversation_id: 'chat', messages: [], snapshot: {
      goal: { title: '阅读', start_date: today, target_days: 7 }, tasks: [{ draft_task_id: 't1', title: '', date: today, estimated_minutes: '', xp_reward: 10, stage: 1 }] } })
    const reviews = require('../cloudfunctions/app/lib/plannerReviews').createService({ cloud: invalid.cloud, drafts,
      loadModel: async () => { semanticCalls++; throw Error('must not call') }, callModel: async () => '' })
    const service = createService({ cloud: invalid.cloud, drafts, reviews, generate: async () => { throw Error('not new') }, graphFactory: createGraph })
    const first = (await service.start('owner', { request_id: 'invalid', mode: 'draft', expected_revision: 1 })).run
    await service.step('owner', { run_id: first.id, request_id: 'manager' })
    await service.step('owner', { run_id: first.id, request_id: 'rules' })
    const wait = await service.step('owner', { run_id: first.id, request_id: 'wait' })
    eq(wait.run.status, 'awaiting_confirmation'); eq(wait.run.steps[3].status, 'skipped'); eq(semanticCalls, 0)
    // A saved edit makes the previous run stale and hides its report.
    const current = await drafts.get('owner')
    await drafts.save('owner', { expected_revision: 1, request_id: 'edit', conversation_id: 'chat', messages: [], snapshot: current.draft.snapshot })
    const stale = await service.get('owner')
    eq(stale.run.is_current, false); eq(stale.run.rules, null)
  } finally { invalid.close() }
  // A persisted role receipt survives a failed graph checkpoint without re-calling AI.
  let inject = false, injected = 0, receiptCalls = 0
  const receipt = offlineCloudbase(seed, { beforeRequest(command, args, state) {
    if (inject && !injected && ['database.insertDocument', 'database.modifyDocument'].includes(command) &&
      state.rows.ai_plans.some(r => r.logical_id && r.logical_id.startsWith('run/') && r.payload.steps.planner?.status === 'done') &&
      JSON.stringify(args.data).includes('graph/')) { injected++; throw Error('checkpoint unavailable') }
  } })
  try {
    const run = backend(receipt, async () => { receiptCalls++; inject = true; return JSON.stringify({ goal: { title: '阅读', period_days: 7 }, tasks: [{ title: '读一页', estimated_minutes: 10, xp_reward: 10, stage: 1 }] }) })
    const first = (await run('startStewardRun', { request_id: 'receipt', mode: 'new', demand: '我想阅读', expected_revision: 0 })).data.run
    await run('stepStewardRun', { run_id: first.id, request_id: 'manager' })
    const failed = await run('stepStewardRun', { run_id: first.id, request_id: 'planner' })
    eq(injected, 1); eq(failed.data.run.status, 'failed'); eq(receiptCalls, 1)
    const recovered = await run('stepStewardRun', { run_id: first.id, request_id: 'recover', recover: true })
    eq(recovered.data.run.status, 'ready'); eq(['rules', 'review'].includes(recovered.data.run.next), true); eq(receiptCalls, 1)
    eq((await createStore(receipt.cloud).get('owner')).revision, 1)
  } finally { receipt.close() }
  // Expired worker fencing: uncertain in-flight result is queried, never reissued.
  const leased = offlineCloudbase(seed), delayed = defer(); let clock = 1000, leaseCalls = 0
  try {
    const api = backend(leased, async () => { leaseCalls++; await delayed.promise; return JSON.stringify({ goal: { title: '阅读', period_days: 7 }, tasks: [{ title: '读一页', estimated_minutes: 10, xp_reward: 10, stage: 1 }] }) })
    const drafts = createStore(leased.cloud)
    const generator = require('../cloudfunctions/app/lib/stewardPlanner').createGenerator({ cloud: leased.cloud, drafts, doGenerate: api.doGenerate })
    const service = createService({ cloud: leased.cloud, drafts, reviews: { get: async () => ({ review: null }) }, generate: generator, graphFactory: createGraph, now: () => clock })
    const first = (await service.start('owner', { request_id: 'lease', mode: 'new', demand: '我想阅读', expected_revision: 0 })).run
    await service.step('owner', { run_id: first.id, request_id: 'manager' })
    const old = service.step('owner', { run_id: first.id, request_id: 'old' })
    while (!leaseCalls) await new Promise(r => setImmediate(r))
    clock += 61000
    const recovered = await service.step('owner', { run_id: first.id, request_id: 'new', recover: true })
    eq(recovered.run.status, 'failed'); eq(leaseCalls, 1)
    delayed.resolve(); await old
    eq((await drafts.get('owner')).draft, null)
    const final = await service.step('owner', { run_id: first.id, request_id: 'after-response', recover: true })
    eq(final.run.status, 'ready'); eq(final.run.next, 'rules'); eq(leaseCalls, 1)
  } finally { leased.close() }
}
async function childResume() {
  const saved = JSON.parse(fs.readFileSync(process.argv[3])), env = offlineCloudbase(saved.rows); let calls = 0
  try {
    const run = backend(env, async () => { calls++; return JSON.stringify({ goal: { title: '游泳', period_days: 10 }, tasks: [{ title: '呼吸练习', estimated_minutes: 15, xp_reward: 10, stage: 1 }] }) })
    const result = await run('stepStewardRun', { run_id: saved.id, request_id: 'child-step' })
    if (result.code !== 0 || result.data.run.status !== 'ready') throw Error(JSON.stringify(result))
    console.log(JSON.stringify({ next: result.data.run.next, calls }))
  } finally { env.close() }
}
(process.argv[2] === '--resume' ? childResume() : main()).catch(e => { console.error(e); process.exitCode = 1 })
