// Installed SDK + local wire transport; no cloud writes or paid model calls.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createStore } = require('../cloudfunctions/app/lib/plannerDrafts')
const { createService, binding } = require('../cloudfunctions/app/lib/plannerReviews')
const rules = require('../cloudfunctions/app/lib/plannerReviewRules')
const context = require('../miniprogram/utils/plannerContext')
const { createWorkspace, VERSION } = require('../miniprogram/utils/plannerReviewWorkspace')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const rejects = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++ }
const throws = (fn, pattern) => { assert.throws(fn, pattern); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function input(revision = 0, request = 'save1') {
  return { expected_revision: revision, request_id: request, conversation_id: 'conversation1',
    messages: [{ id: 'u1', role: 'user', content: '我想游泳，10天，每天20分钟，我是新手，只在周末' }],
    snapshot: { goal: { title: '游泳入门', target_days: 10, start_date: '2026-11-06', stages: [] },
      tasks: [{ draft_task_id: 't1', title: '呼吸练习', date: '2026-11-07', estimated_minutes: 15, xp_reward: 10, stage: 1 },
        { draft_task_id: 't2', title: '漂浮练习', date: '2026-11-07', estimated_minutes: 15, xp_reward: 10, stage: 1 }] } }
}
const output = (task = 't1') => JSON.stringify({ summary: '新手应在有人指导的安全环境中练习。', findings: [{ task_id: task, severity: 'warning', message: '练习条件未说明', suggestion: '确认教练及安全条件', requirement_fields: ['constraints', 'level'] }] })
async function main() {
  eq(VERSION, rules.VERSION)
  eq(context.extract('每天0.5小时').dailyTime, '0.5小时')
  eq(context.extract('每日改为1.5小时').dailyTime, '1.5小时')
  for (const [value, result] of [['0.5小时', 30], ['20分钟', 20], ['', null], ['0分钟', null], ['不超过20分钟', null], ['25小时', null]]) eq(rules.dailyBudget(value), result)
  const draft = { snapshot: input().snapshot, context: { values: { ...context.empty(), dailyTime: '20分钟', constraints: '只在周末' }, sources: {} }, assumptions: [] }
  const checked = rules.check(draft)
  eq(checked.facts.daily_loads[0].estimated_minutes, 30)
  eq(checked.facts.daily_loads[0].over_budget, true)
  eq(checked.facts.scheduled_days, 1)
  eq(checked.findings.map(f => f.code), ['daily_budget'])
  eq(checked.findings[0].task_id, 't1')
  const broken = structuredClone(draft)
  Object.assign(broken.snapshot.tasks[0], { title: '', date: '2026-11-16', estimated_minutes: 0, xp_reward: -1, stage: 0 })
  const issues = rules.check(broken).findings
  for (const code of ['task_title', 'outside_period', 'task_minutes', 'task_xp', 'task_stage', 'weekend_only']) eq(issues.some(f => f.code === code && f.task_id === 't1'), true)
  const missing = structuredClone(draft); missing.context.values.dailyTime = ''; missing.snapshot.tasks[0].estimated_minutes = ''
  eq(rules.check(missing).facts.daily_budget_minutes, null)
  eq(rules.check(missing).facts.daily_loads[0].complete, false)
  eq(rules.check(missing).facts.daily_loads[0].over_budget, null)
  eq(rules.check(missing).unknown_fields.includes('dailyTime'), true)
  const invalidDate = structuredClone(draft); invalidDate.snapshot.tasks[0].date = '2026-02-30'
  eq(rules.check(invalidDate).findings.some(f => f.code === 'task_date'), true)
  eq(rules.parseModel('```json\n' + output() + '\n```', draft).findings[0].task_title, '呼吸练习')
  eq(rules.parseModel('{"summary":"没有发现其他建议，但仍需实际核对","findings":[]}', draft).findings, [])
  throws(() => rules.parseModel('', draft), /有效/)
  throws(() => rules.parseModel('not JSON', draft), /解析/)
  throws(() => rules.parseModel(output('fake-id'), draft), /无效任务/)
  throws(() => rules.parseModel(output().replace('warning', 'error'), draft), /无效任务/)
  throws(() => rules.parseModel(output().replace('constraints', 'secret'), draft), /无效任务/)
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [], api_keys: [{ _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-private-key', model: 'deepseek-chat' }] })
  const store = createStore(env.cloud)
  let calls = 0, gate, failure = '', captured
  const service = createService({ cloud: env.cloud, drafts: store, loadModel: async owner => { eq(owner, 'owner'); return { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'synthetic-private-key' } },
    callModel: async (config, messages) => { calls++; captured = messages; if (gate) await gate.promise; if (failure) throw Error(failure); return output() } })
  const request = (d, mode = 'ai', id = 'review1') => ({ binding: binding(d), mode, request_id: id })
  try {
    const first = await store.save('owner', input())
    eq((await service.get('owner', { mode: 'ai' })).review, null)
    const before = calls
    const local = await service.review('owner', request(first, 'rules'))
    eq(local.review.status, 'done'); eq(calls, before)
    eq(local.review.rules.warning_count, 1)
    gate = defer()
    const running = service.review('owner', request(first))
    while (!calls) await new Promise(r => setImmediate(r))
    const repeated = request(first)
    repeated.binding = Object.fromEntries(Object.entries(repeated.binding).reverse())
    repeated.binding.ignored = 'caller-extra'
    const duplicates = await Promise.all(Array.from({ length: 12 }, () => service.review('owner', repeated)))
    eq(duplicates.every(r => r.cached && r.review.status === 'running'), true)
    eq(calls, 1)
    gate.resolve(); gate = null
    const result = await running
    eq(result.review.status, 'done'); eq(result.review.is_current, true)
    eq(result.review.model, { provider: 'deepseek', name: 'deepseek-chat' })
    eq(JSON.stringify(result).includes('synthetic-private-key'), false)
    eq(JSON.stringify(captured).includes('synthetic-private-key'), false)
    eq(JSON.parse(captured[1].content).requirements.dailyTime, '20分钟')
    eq(JSON.stringify(captured).includes('conversation1'), false)
    eq((await service.review('owner', request(first, 'ai', 'different-request'))).cached, true)
    eq(calls, 1)
    eq((await service.get('other', { mode: 'ai', binding: binding(first) })).review, null)
    await rejects(() => service.review('other', request(first)), /草案已有变化/)
    await rejects(() => service.review('', request(first)), /登录/)
    await rejects(() => service.review('owner', { ...request(first), mode: 'auto' }), /请选择/)
    await rejects(() => service.review('owner', { ...request(first), binding: { ...binding(first), rules_version: 'old' } }), /规则版本/)
    const second = await store.save('owner', input(1, 'save2'))
    eq((await service.get('owner', { mode: 'ai', binding: binding(first) })).review.is_current, false)
    await rejects(() => service.review('owner', request(first)), /草案已有变化/)
    gate = defer()
    const late = service.review('owner', request(second, 'ai', 'late'))
    while (calls < 2) await new Promise(r => setImmediate(r))
    const third = await store.save('owner', input(2, 'save3'))
    gate.resolve(); gate = null
    eq((await late).review.is_current, false)
    failure = 'provider unavailable'
    eq((await service.review('owner', request(third, 'ai', 'fail1'))).review.status, 'failed')
    eq((await service.review('owner', request(third, 'ai', 'fail1'))).cached, true)
    eq(calls, 3)
    eq((await service.review('owner', request(third, 'ai', 'fail2'))).review.attempt, 2)
    eq((await service.review('owner', request(third, 'ai', 'fail1'))).cached, true)
    eq(calls, 4) // Late retry of an earlier failed request never starts a paid call.
    eq((await service.review('owner', request(third, 'ai', 'fail3'))).review.retry_available, false)
    await rejects(() => service.review('owner', request(third, 'ai', 'fail4')), /3次/)
    eq(calls, 5)
    eq(env.rows.ai_plans.filter(r => r.kind === 'planner_review').length, 4)
    eq(env.rows.ai_plans.every(r => !JSON.stringify(r).includes('synthetic-private-key')), true)

    // Actual router uses native owner and saved config; caller-supplied config ignored.
    let modelText = output(), sent, headers, timer, destroyed = false, never = false
    const https = { request(options, callback) {
      headers = options.headers
      const req = new EventEmitter(); req.write = body => { sent = JSON.parse(body) }; req.destroy = () => { destroyed = true }
      req.end = () => { if (never) return; const res = new EventEmitter(); res.statusCode = 200; callback(res); res.emit('data', JSON.stringify({ choices: [{ message: { content: modelText } }] })); res.emit('end') }
      return req
    } }
    const back = path.resolve(__dirname, '../cloudfunctions/app/index.js'), localRequire = createRequire(back)
    const ctx = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : localRequire(n), exports: {}, URL, Buffer,
      console: { log() {}, warn() {}, error() {} }, setTimeout(fn, ms) { timer = { fn, ms }; return 1 }, clearTimeout() {} })
    vm.runInContext(fs.readFileSync(back, 'utf8'), ctx)
    const fourth = await store.save('owner', input(3, 'save4'))
    const run = data => ctx.exports.main({ action: 'reviewPlannerDraft', data })
    const routed = await run({ ...request(fourth), openid: 'other', provider: 'qwen', apiKey: 'caller-key', model: 'bad-model' })
    eq(routed.code, 0); eq(sent.model, 'deepseek-chat')
    eq(headers.Authorization, 'Bearer synthetic-private-key')
    eq(timer.ms, 18000)
    eq(JSON.stringify(routed).includes('synthetic-private-key'), false)
    eq(JSON.stringify(env.rows.ai_plans).includes('synthetic-private-key'), false)
    const fifth = await store.save('owner', input(4, 'save5')); never = true
    const timeout = run(request(fifth)); while (!timer || timer === null || !sent) await new Promise(r => setImmediate(r))
    // Wait until the new request installs its absolute deadline (not a socket event).
    await new Promise(r => setImmediate(r)); timer.fn()
    const timed = await timeout
    eq(timed.code, 0); eq(timed.data.review.status, 'failed'); eq(/18秒/.test(timed.data.review.error), true); eq(destroyed, true)

    failure = ''; gate = defer()
    const sixth = await store.save('owner', input(5, 'save6'))
    const contenders = Array.from({ length: 8 }, (_, i) => service.review('owner', request(sixth, 'ai', 'race' + i)))
    while (calls < 6) await new Promise(r => setImmediate(r))
    gate.resolve(); gate = null
    const raced = await Promise.all(contenders)
    eq(calls, 6); eq(raced.filter(r => !r.cached).length, 1)
    eq(raced.every(r => ['running', 'done'].includes(r.review.status)), true)
    eq(env.stats.conflicts > 0, true)

    // Actual Page: cold entry restores the cloud draft and its matching review;
    // editing invalidates it, saving then re-entering loads a clean new version.
    const front = path.resolve(__dirname, '../miniprogram/pages/ai/ai.js'), frontRequire = createRequire(front), storage = new Map()
    const api = { getPlannerDraft: () => store.get('owner'), savePlannerDraft: d => store.save('owner', d),
      getPlannerReview: d => service.get('owner', d), reviewPlannerDraft: d => service.review('owner', d) }
    let actualPage
    vm.runInNewContext(fs.readFileSync(front, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : frontRequire(n),
      wx: { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k), showToast() {} },
      getApp: () => ({ globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }), Page: p => { actualPage = p },
      console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
    actualPage.data = structuredClone(actualPage.data)
    actualPage.setData = function(patch) { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let o = this.data; for (const k of parts.slice(0, -1)) o = o[k]; o[parts.at(-1)] = value } }
    await actualPage.loadReviewDraft()
    eq(actualPage.data.reviewDraft.versionLabel, '云端版本 6')
    eq(actualPage.data.auditAI.status, 'done'); eq(actualPage.data.auditReady, true)
    eq(actualPage.data.auditAI.binding.revision, 6)
    actualPage.editPlanTaskTitle({ detail: { value: '修改后呼吸练习' }, currentTarget: { dataset: { index: 0 } } })
    await actualPage.loadReviewDraft()
    eq(actualPage.data.auditExpired, true); eq(actualPage.data.auditReady, false)
    await actualPage.savePlannerDraft(); await actualPage.loadReviewDraft()
    eq(actualPage.data.auditReady, true); eq(actualPage.data.auditAI, null)
    await actualPage.runPlannerRules(); eq(actualPage.data.auditRules.binding.revision, 7)
    eq(calls, 6)

    // Frontend workspace guards owner/version, unknown network result and read-only reload.
    let owner = 'owner', apiCalls = 0, readCalls = 0, pending, readError = false
    const saved = routed.data.review
    const w = createWorkspace({ publicationDraft: { owner: () => owner, accountScope: () => owner }, cloudApi: {
      getPlannerReview: async ({ mode }) => { readCalls++; if (readError) throw Error('read unavailable'); return { review: mode === 'ai' ? saved : null } },
      reviewPlannerDraft: async () => { apiCalls++; if (pending) return pending.promise; throw Error('response lost') }
    } })
    const p = { ...w.methods, data: { ...structuredClone(w.data), draftCloudState: 'saved', cloudDraftId: fourth.id, cloudDraftRevision: fourth.revision,
      cloudDraftFingerprint: fourth.fingerprint, publicationPending: false, plannerState: { generatedGoal: fourth.snapshot.goal } }, _requirementsRevision: fourth.context.revision,
      setData(patch) { Object.assign(this.data, patch) } }
    await p.loadSavedPlannerReviews()
    eq(p.data.auditAI.status, 'done'); eq(p.data.auditReady, true); eq(apiCalls, 0); eq(readCalls, 2)
    pending = defer(); const response = p.runPlannerAIReview()
    await p.runPlannerAIReview(); eq(apiCalls, 1)
    p.invalidatePlannerReview(); p.data.draftCloudState = 'dirty'
    pending.resolve({ review: saved }); await response
    eq(p.data.auditExpired, true); eq(p.data.auditReady, false)
    p.data.draftCloudState = 'saved'; pending = null
    await p.runPlannerAIReview(); eq(p.data.auditUncertain, true)
    await p.runPlannerAIReview(); eq(apiCalls, 2)
    await p.loadSavedPlannerReviews(); eq(p.data.auditUncertain, false)
    readError = true; p.data.cloudDraftId = fifth.id; p.data.cloudDraftRevision = fifth.revision; p.data.cloudDraftFingerprint = fifth.fingerprint
    await p.loadSavedPlannerReviews(); eq(p.data.auditAI, null); eq(p.data.auditUncertain, true)
    readError = false; p.data.cloudDraftId = fourth.id; p.data.cloudDraftRevision = fourth.revision; p.data.cloudDraftFingerprint = fourth.fingerprint
    pending = defer(); const otherOwner = p.runPlannerAIReview(); owner = 'other'; p.resetPlannerReviewOwner(); pending.resolve({ review: saved }); await otherOwner
    eq(p.data.auditAI, null); eq(p.data.auditBusy, '')
    owner = 'owner'; p.data.publicationPending = true; eq(p.plannerReviewBinding(), null)
    p.data.publicationPending = false; p.data.reviewDraft = { locked: true }; eq(p.plannerReviewBinding(), null); p.data.reviewDraft = null
    p.data.publicationPending = false; p.data.draftCloudState = 'dirty'; let restored = 0
    p.restorePlannerDraft = async () => { restored++ }; p.loadReviewDraft = () => {}
    await p.refreshReviewWorkspace(); eq(restored, 0); eq(/本机/.test(p.data.auditError), true)
  } finally { env.close() }

  // A failed DB write must not be reported as done, nor replay the model on retry.
  let breakWrite = false, breakRead = false, isolatedCalls = 0, at = Date.now()
  const faulted = offlineCloudbase({ ai_plans: [] }, { beforeRequest(command) {
    if (breakWrite && command === 'database.modifyDocument') throw Error('write unavailable')
    if (breakRead && command === 'database.getDocument') throw Error('read unavailable')
  } })
  try {
    const drafts = createStore(faulted.cloud), saved = await drafts.save('owner', input())
    const gate = defer()
    const svc = createService({ cloud: faulted.cloud, drafts, now: () => at, loadModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      callModel: async () => {
        isolatedCalls++
        if (isolatedCalls === 1) breakWrite = true
        if (isolatedCalls === 2) await gate.promise
        return output(isolatedCalls === 3 ? 't2' : 't1')
      } })
    const payload = { mode: 'ai', binding: binding(saved), request_id: 'write-fails' }
    await rejects(() => svc.review('owner', payload), /write unavailable/)
    breakWrite = false
    eq((await svc.get('owner', { mode: 'ai' })).review.status, 'running')
    eq((await svc.review('owner', payload)).cached, true); eq(isolatedCalls, 1)
    const record = faulted.rows.ai_plans.find(row => row.kind === 'planner_review')
    faulted.mutate('ai_plans', record._id, { lease_until: null })
    at += 60000
    const expired = (await svc.get('owner', { mode: 'ai' })).review
    eq(expired.status, 'failed'); eq(expired.retry_available, true)
    eq((await svc.review('owner', payload)).cached, true); eq(isolatedCalls, 1)
    const delayed = svc.review('owner', { ...payload, request_id: 'delay' })
    while (isolatedCalls < 2) await new Promise(resolve => setImmediate(resolve))
    at += 60000
    const recovered = await svc.review('owner', { ...payload, request_id: 'recovery' })
    eq(recovered.review.attempt, 3); eq(recovered.review.status, 'done')
    const stale = rejects(() => delayed, /审核状态已变化/)
    gate.resolve()
    await stale
    eq((await svc.get('owner', { mode: 'ai' })).review.semantic.findings[0].task_id, 't2')
    breakRead = true
    await rejects(() => svc.get('owner', { mode: 'ai' }), /read unavailable/)
  } finally { faulted.close() }
  console.log('planner-review-reliability: ' + checks + ' assertions passed (offline only)')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
