// Production store with installed SDK/offline transaction wire, and actual AI Page.
// No network, real identities, cloud writes or paid model calls.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const assert = require('node:assert/strict'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const rules = require('../miniprogram/utils/plannerContext'), schedule = require('../miniprogram/utils/planSchedule')
const { createStore } = require('../cloudfunctions/app/lib/plannerDrafts')
const root = path.resolve(__dirname, '..'), front = path.join(root, 'miniprogram/pages/ai/ai.js'), back = path.join(root, 'cloudfunctions/app/index.js')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const rejected = async (run, pattern) => { await assert.rejects(run, pattern); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
const message = (content, id = 'u1') => ({ id, role: 'user', content })
const workingKey = 'planner_working_copy_v2:' + JSON.stringify(['owner', 'owner-account'])
function input(revision = 0, request = 'save1', conversation = 'conversation1') {
  return { expected_revision: revision, request_id: request, conversation_id: conversation,
    messages: [message('先了解一下你', 'greet'), { id: 'a1', role: 'assistant', content: '你是高级选手，每天60分钟' }, message('我想游泳，10天，每天20分钟，我是新手')],
    snapshot: { goal: { title: '10天游泳', target_days: 10, start_date: schedule.today(), stages: [] },
      tasks: [{ draft_task_id: 'stable1', title: '练习呼吸', date: schedule.today(), estimated_minutes: 20, xp_reward: 10, stage: 1 }] } }
}
function page(api, storage = new Map()) {
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'owner-account' } } }, options = { failStorage: false }, timers = []
  const wx = { getStorageSync: k => storage.get(k), setStorageSync(k, v) { if (options.failStorage) throw new Error('storage full'); storage.set(k, structuredClone(v)) },
    removeStorageSync: k => storage.delete(k), showToast() {}, showModal(o) { if (o.success) o.success({ confirm: true }) }, showLoading() {}, hideLoading() {}, navigateTo() {} }
  let p
  const localRequire = createRequire(front)
  vm.runInNewContext(fs.readFileSync(front, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : localRequire(n), wx, getApp: () => app, Page: d => { p = d },
    console: { log() {}, warn() {}, error() {} }, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length }, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  p.data = structuredClone(p.data)
  p.setData = function(patch) { for (const [k, value] of Object.entries(patch)) { const parts = k.split('.'); let obj = this.data; for (const part of parts.slice(0, -1)) obj = obj[part]; obj[parts.at(-1)] = value } }
  p.syncPlannerDraftOwner(); p.syncPartnerOwner()
  return { p, app, storage, options, timers }
}
async function main() {
  eq(fs.readFileSync(path.join(root, 'cloudfunctions/app/lib/plannerContext.js'), 'utf8'), fs.readFileSync(path.join(root, 'miniprogram/utils/plannerContext.js'), 'utf8'))
  const parsed = rules.derive(input().messages)
  eq(parsed.values.what, '游泳'); eq(parsed.values.dailyTime, '20分钟'); eq(parsed.values.level, '新手')
  eq(parsed.sources.what.kind, 'user_message'); eq(parsed.sources.what.message_id, 'u1')
  eq(rules.goal('先了解一下你'), ''); eq(rules.goal('你能做什么'), '')
  eq(rules.goal('先了解一下你，不过我想学游泳'), '学游泳')
  eq(rules.goal('我想每天喝水'), '每天喝水')
  eq(rules.derive([{ role: 'assistant', content: '你想跑步，30天，每天60分钟' }]).values, rules.empty())
  const changed = rules.derive([message('我现在想跑步', 'u2')], parsed)
  eq(changed.values.what, '跑步'); eq(changed.values.dailyTime, ''); eq(changed.values.deadline, '')
  eq(rules.derive([message('换个目标')], parsed).values, rules.empty())
  eq(rules.extract('每2天一次').deadline === undefined, true)
  eq(rules.assumptions({ values: rules.empty() }, { target_days: 30 }).every(a => a.confirmed === false), true)

  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [], api_keys: [{ _id: 'key', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-key', model: 'deepseek-chat' }] })
  const store = createStore(env.cloud)
  try {
    eq(await store.get('owner'), { draft: null, revision: 0 })
    const first = await store.save('owner', input())
    eq(first.revision, 1); eq(first.source, 'user_draft'); eq(first.snapshot.tasks[0].draft_task_id, 'stable1')
    eq(first.context.values.what, '游泳'); eq((await store.get('owner')).draft.id, first.id)
    eq(await store.get('other'), { draft: null, revision: 0 })
    await rejected(() => store.get(''), /登录/)
    eq((await store.save('owner', input())).id, first.id)
    eq(env.rows.ai_plans.filter(r => r.kind === 'planner_draft_version').length, 1)
    const bad = input(); bad.snapshot.tasks[0].title = '偷偷改写'
    await rejected(() => store.save('owner', bad), /同一保存请求/)
    await rejected(() => store.save('owner', input(0, 'stale')), /新版本/)
    const contenders = await Promise.allSettled([store.save('owner', input(1, 'parallel1')), store.save('owner', input(1, 'parallel2'))])
    eq(contenders.filter(x => x.status === 'fulfilled').length, 1); eq((await store.get('owner')).revision, 2)
    eq(env.stats.conflicts > 0, true)
    const edit = input(2, 'edit'); edit.user_edits = { deadline: '7天', what: '游泳入门' }; edit.snapshot.tasks[0].title = ''
    const edited = await store.save('owner', edit)
    eq(edited.context.sources.what.kind, 'user_edit'); eq(edited.context.values.deadline, '7天')
    eq(edited.snapshot.tasks[0].title, '') // Incomplete work is saveable; publication validation remains separate.
    const next = input(3, 'next'); next.messages = [message('每天30分钟', 'u-new')]
    const fourth = await store.save('owner', next)
    eq(fourth.context.values.what, '游泳入门'); eq(fourth.context.values.dailyTime, '30分钟')
    eq((await store.save('owner', input())).current_revision, 4)
    const tamper = input(4, 'tamper'); tamper.messages[2].content = '我想跑步'
    await rejected(() => store.save('owner', tamper), /不能悄悄改写/)
    const duplicate = input(4, 'dupe'); duplicate.snapshot.tasks.push(duplicate.snapshot.tasks[0])
    await rejected(() => store.save('owner', duplicate), /重复/)
    const clear = { request_id: 'clear1', expected_revision: 4 }
    eq((await store.clear('owner', clear)).revision, 5)
    eq((await store.get('owner')).draft, null)
    await rejected(() => store.save('owner', input(4, 'late')), /新版本/)
    eq((await store.clear('owner', clear)).revision, 5)
    await store.save('owner', input(5, 'new', 'new-conversation'))
    eq((await store.clear('owner', clear)).preserved_newer_draft, true)
    await store.clear('reset-first', { request_id: 'reset', expected_revision: 0 })
    await rejected(() => store.save('reset-first', input()), /新版本/)
    eq((await store.save('other', input())).revision, 1)
    const falseSource = input(6, 'false-source'); falseSource.source_plan_id = first.id
    await rejected(() => store.save('owner', falseSource), /来源尚未成功/)

    // Real handlers, stub only HTTPS transport, verify auto-save and invalid JSON failure.
    let modelText = '', modelRequests = 0, responseGate
    const https = { request(o, callback) {
      const req = new EventEmitter(); req.write = () => { modelRequests++ }; req.destroy = () => {}
      req.end = async () => {
        if (responseGate) await responseGate.promise
        const res = new EventEmitter(); res.statusCode = 200; callback(res)
        res.emit('data', JSON.stringify({ choices: [{ message: { content: modelText } }] })); res.emit('end')
      }; return req
    } }
    const backRequire = createRequire(back), ctx = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : backRequire(n), exports: {}, URL, Buffer,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout })
    vm.runInContext(fs.readFileSync(back, 'utf8'), ctx)
    const run = (action, data) => ctx.exports.main({ action, data })
    const started = await run('aiStartGenerate', { messages: input().messages, draft_meta: { expected_revision: 6, conversation_id: 'new-conversation' }, provider: 'deepseek' })
    eq(started.code, 0)
    modelText = 'invalid JSON'
    eq((await run('aiDoGenerate', { plan_id: started.data.plan_id })).code, -1)
    eq(env.rows.ai_plans.find(r => r._id === started.data.plan_id).status, 'failed')
    eq((await store.get('owner')).revision, 6)
    const startPayload = { request_id: 'idempotent-generation', messages: input().messages,
      draft_meta: { expected_revision: 6, conversation_id: 'new-conversation' }, provider: 'deepseek' }
    const [started2, sameStart] = await Promise.all([run('aiStartGenerate', startPayload), run('aiStartGenerate', startPayload)])
    eq(started2.code, 0); eq(sameStart.data.plan_id, started2.data.plan_id)
    eq(env.rows.ai_plans.filter(row => row._id === started2.data.plan_id).length, 1)
    eq((await run('aiStartGenerate', { ...startPayload, provider: 'qwen' })).code, -1)
    eq((await run('aiStartGenerate', { ...startPayload, request_id: 'invalid id' })).code, -1)
    eq((await run('aiPollPlan', { request_id: 'missing-generation' })).data, { status: 'missing' })
    eq((await run('aiPollPlan', { request_id: startPayload.request_id })).data.plan_id, started2.data.plan_id)
    eq((await run('aiPollPlan', { plan_id: started2.data.plan_id, request_id: startPayload.request_id })).code, -1)
    env.rows.users.push({ _id: 'other-user', _openid: 'other' })
    env.cloud.getWXContext = () => ({ OPENID: 'other' })
    eq((await run('aiPollPlan', { request_id: startPayload.request_id })).data, { status: 'missing' })
    eq((await run('aiPollPlan', { plan_id: started2.data.plan_id })).code, -1)
    env.cloud.getWXContext = () => ({ OPENID: 'owner' })
    modelText = JSON.stringify({ goal: { title: '游泳入门', period_days: 10 }, tasks: [{ title: '呼吸练习', estimated_minutes: 20, xp_reward: 10, stage: 1 }] })
    responseGate = defer()
    const callsAtStart = modelRequests
    const secondPlan = { plan_id: started2.data.plan_id }
    const firstAttempt = run('aiDoGenerate', secondPlan)
    while (modelRequests === callsAtStart) await new Promise(resolve => setImmediate(resolve))
    eq((await run('aiDoGenerate', secondPlan)).data.status, 'running')
    eq((await run('aiPollPlan', secondPlan)).data.status, 'running')
    eq(modelRequests, callsAtStart + 1)
    responseGate.resolve()
    const generated = await firstAttempt
    assert(generated.data && generated.data.draft, JSON.stringify(generated))
    eq(generated.code, 0); eq(generated.data.source, 'model'); eq(generated.data.draft.source, 'model')
    eq((await store.get('owner')).revision, 7); eq(generated.data.draft.snapshot.tasks[0].draft_task_id.startsWith('task_'), true)
    eq((await run('aiDoGenerate', secondPlan)).data.draft.id, generated.data.draft.id)
    eq((await run('aiPollPlan', secondPlan)).data.result.draft.id, generated.data.draft.id)
    eq((await run('aiStartGenerate', startPayload)).data, { plan_id: secondPlan.plan_id, status: 'done' })
    eq(modelRequests, callsAtStart + 1)
    const beforeRequests = modelRequests
    eq((await run('aiDoGenerate', { plan_id: generated.data.draft.id })).code, -1)
    eq(modelRequests, beforeRequests)
    eq((await run('aiStartGenerate', { messages: [message('先了解一下你')], draft_meta: { expected_revision: 7, conversation_id: 'fresh' } })).code, -1)

    const api = { getPlannerDraft: () => store.get('owner'), savePlannerDraft: d => store.save('owner', d), clearPlannerDraft: d => store.clear('owner', d) }
    // An explicit cloud refresh must not discard edits made while it is pending.
    const refreshing = page(api); await refreshing.p.restorePlannerDraft()
    const refreshGate = defer()
    api.getPlannerDraft = () => refreshGate.promise
    const refreshWork = refreshing.p.restorePlannerDraft(true)
    refreshing.p.editPlanTaskTitle({ detail: { value: '读取期间继续编辑' }, currentTarget: { dataset: { index: 0 } } })
    refreshGate.resolve(await store.get('owner')); await refreshWork
    eq(refreshing.p.data.editableTasks[0].title, '读取期间继续编辑')
    eq(refreshing.p.data.draftCloudState, 'dirty')
    eq(refreshing.storage.get(workingKey).snapshot.tasks[0].title, '读取期间继续编辑')
    api.getPlannerDraft = () => store.get('owner')
    const failedRefresh = page(api); await failedRefresh.p.restorePlannerDraft()
    const failedGate = defer(); api.getPlannerDraft = () => failedGate.promise
    const failedWork = failedRefresh.p.restorePlannerDraft(true)
    failedRefresh.p.editPlanTaskTitle({ detail: { value: '读取失败也保留新编辑' }, currentTarget: { dataset: { index: 0 } } })
    failedGate.resolve(Promise.reject(Error('offline'))); await failedWork
    eq(failedRefresh.p.data.editableTasks[0].title, '读取失败也保留新编辑')
    eq(failedRefresh.p.data.draftCloudState, 'dirty')
    api.getPlannerDraft = () => store.get('owner')
    const client = page(api); await client.p.openPlannerWorkspace()
    eq(client.p.data.plannerState.generatedGoal.title, '游泳入门'); eq(client.p.data.draftCloudState, 'saved')
    client.p.editPlanTaskTitle({ detail: { value: '修改呼吸练习' }, currentTarget: { dataset: { index: 0 } } })
    eq(client.p.data.draftCloudState, 'dirty'); eq(client.storage.has(workingKey), true)
    await client.p.savePlannerDraft(); eq(client.p.data.cloudDraftRevision, 8)
    eq(client.storage.has(workingKey), false)
    const reentered = page(api); await reentered.p.loadReviewDraft()
    eq(reentered.p.data.reviewDraft.tasks[0].title, '修改呼吸练习'); eq(reentered.p.data.reviewDraft.versionLabel, '云端版本 8')
    eq(reentered.p.data.reviewDraft.tasks[0].key, generated.data.draft.snapshot.tasks[0].draft_task_id)

    // Lost save response + subsequent local edits survives process restart and retries.
    let lose = true
    const lossApi = { ...api, async savePlannerDraft(d) { const saved = await store.save('owner', d); if (lose) throw new Error('response lost'); return saved } }
    const loss = page(lossApi); await loss.p.restorePlannerDraft()
    loss.p.editPlanTaskTitle({ detail: { value: '第一次修改' }, currentTarget: { dataset: { index: 0 } } })
    await loss.p.savePlannerDraft(); eq(loss.p.data.draftCloudState, 'error')
    loss.p.editPlanTaskTitle({ detail: { value: '响应丢失之后的修改' }, currentTarget: { dataset: { index: 0 } } })
    const restart = page(api, loss.storage); await restart.p.restorePlannerDraft()
    eq(restart.p.data.editableTasks[0].title, '响应丢失之后的修改'); eq(restart.p.data.draftCloudState, 'dirty')
    eq(restart.p._pendingDraftSave, null)
    await restart.p.savePlannerDraft(); eq(restart.p.data.draftCloudState, 'saved')

    // Concurrent device edit: keep local version and explicitly back up before replacement.
    restart.p.editPlanTaskTitle({ detail: { value: '设备一修改' }, currentTarget: { dataset: { index: 0 } } })
    const device2 = page(api); await device2.p.restorePlannerDraft()
    device2.p.editPlanTaskTitle({ detail: { value: '设备二修改' }, currentTarget: { dataset: { index: 0 } } })
    await device2.p.savePlannerDraft()
    await restart.p.savePlannerDraft(); eq(restart.p.data.draftCloudState, 'error')
    eq(restart.p.data.editableTasks[0].title, '设备一修改')
    await restart.p.recoverCloudPlannerDraft(); await new Promise(r => setImmediate(r))
    eq(restart.p.data.editableTasks[0].title, '设备二修改'); eq(restart.p.data.draftBackupAvailable, true)
    restart.p.recoverPlannerLocalBackup(); eq(restart.p.data.editableTasks[0].title, '设备一修改')
    await restart.p.savePlannerDraft(); eq(restart.p.data.draftCloudState, 'error') // Backup cannot overwrite newer cloud.

    const offline = page({ ...api, getPlannerDraft: async () => { throw new Error('offline') } }, restart.storage)
    eq(await offline.p.restorePlannerDraft(), true); eq(offline.p.data.editableTasks[0].title, '设备一修改')
    eq(offline.p._plannerBaseKnown, false); eq(offline.p.data.draftCloudState, 'error')
    const legacyKey = 'planner_working_copy_v1:owner'
    const legacy = { ...restart.storage.get(workingKey), version: 1, owner: 'owner' }
    delete legacy.scope
    restart.storage.set(legacyKey, legacy)
    restart.storage.set(legacyKey + ':backup', legacy)
    const sameWechat = page({ getPlannerDraft: async () => ({ draft: null, revision: 0 }) }, restart.storage)
    sameWechat.app.globalData.userInfo = { id: 'recreated-account' }
    eq(await sameWechat.p.restorePlannerDraft(), false)
    eq(sameWechat.p.data.draftBackupAvailable, false)
    sameWechat.p.recoverPlannerLocalBackup()
    eq(sameWechat.p.data.editableTasks, [])
    eq(restart.storage.get(legacyKey), legacy)
    eq(restart.storage.get(legacyKey + ':backup'), legacy)
    sameWechat.app.globalData.userInfo = { id: 'owner-account' }
    eq(await sameWechat.p.restorePlannerDraft(), true)
    eq(sameWechat.p.data.draftBackupAvailable, true)
    sameWechat.p.recoverPlannerLocalBackup()
    eq(sameWechat.p.data.editableTasks[0].title, '设备一修改')
    const gate = defer(), racing = page({ ...api, getPlannerDraft: () => gate.promise })
    const reading = racing.p.restorePlannerDraft(); racing.app.globalData.userInfo = { id: 'recreated-account' }; racing.p.syncPlannerDraftOwner()
    gate.resolve(await store.get('owner')); await reading
    eq(racing.p.data.plannerState.generatedGoal, null); eq(racing.p.data.cloudDraftId, '')

    const pending = defer(), slow = page({ ...api, savePlannerDraft: async d => { await pending.promise; return store.save('owner', d) } })
    await slow.p.restorePlannerDraft()
    slow.p.editPlanTaskTitle({ detail: { value: '保存中第一版' }, currentTarget: { dataset: { index: 0 } } })
    const saving = slow.p.savePlannerDraft(); await new Promise(r => setImmediate(r))
    slow.p.editPlanTaskTitle({ detail: { value: '保存中继续编辑' }, currentTarget: { dataset: { index: 0 } } })
    pending.resolve(); await saving
    eq(slow.p.data.draftCloudState, 'dirty'); eq(slow.p.data.editableTasks[0].title, '保存中继续编辑')
    await slow.p.savePlannerDraft(); eq(slow.p.data.draftCloudState, 'saved')
    const storageFailure = page(api); await storageFailure.p.restorePlannerDraft()
    storageFailure.p.editPlanTaskTitle({ detail: { value: '存储失败' }, currentTarget: { dataset: { index: 0 } } }); storageFailure.options.failStorage = true
    const rev = (await store.get('owner')).revision
    await storageFailure.p.savePlannerDraft(); eq((await store.get('owner')).revision, rev)
    eq(storageFailure.p.data.draftCloudError.includes('备份失败'), true)
    eq((await store.get('other')).draft.context.values.what, '游泳')
    const delayedAck = page(lossApi); await delayedAck.p.restorePlannerDraft()
    delayedAck.p.editPlanTaskTitle({ detail: { value: '旧请求结果未确认' }, currentTarget: { dataset: { index: 0 } } })
    await delayedAck.p.savePlannerDraft()
    const newerDevice = page(api); await newerDevice.p.restorePlannerDraft()
    newerDevice.p.editPlanTaskTitle({ detail: { value: '别的设备最新稿' }, currentTarget: { dataset: { index: 0 } } })
    await newerDevice.p.savePlannerDraft()
    const ackRestart = page(api, delayedAck.storage); await ackRestart.p.restorePlannerDraft()
    await ackRestart.p.savePlannerDraft(); eq(ackRestart.p.data.draftCloudState, 'conflict')
    eq(ackRestart.p.data.editableTasks[0].title, '旧请求结果未确认')
    await ackRestart.p.savePlannerDraft()
    eq((await store.get('owner')).draft.snapshot.tasks[0].title, '别的设备最新稿')

    // Restart/reset isolation, slow model response, honest fallback and timeout.
    const modelGate = defer(), starts = []
    const modelApi = { ...api, myApiKeys: async () => [{ provider: 'deepseek', model: 'deepseek-chat', has_key: true, updated_at: 1 }],
      aiStartGenerate: async d => { starts.push(d); return { plan_id: 'fake-generation' } }, aiDoGenerate: () => modelGate.promise }
    const late = page(modelApi)
    late.p.collectPlannerUserMessage('我想游泳', 'late-user')
    late.p.setData({ planMessages: [message('我想游泳', 'late-user')] })
    const generating = late.p.generatePlanTasks(); await new Promise(r => setImmediate(r))
    eq(starts.length, 1); eq(starts[0].draft_meta.expected_revision, (await store.get('owner')).revision)
    eq(late.p.data.plannerState.loading, true)
    late.p.initPlanChat()
    modelGate.resolve({ goal: { title: '过时结果' }, tasks: [{ title: '过时任务' }], source: 'model' }); await generating
    eq(late.p.data.plannerState.generatedGoal, null); eq(late.p.data.showPlanModal, false)
    const failed = page({ ...modelApi, aiDoGenerate: async () => { throw new Error('模型出错') } })
    failed.p.collectPlannerUserMessage('我想跑步', 'fail-user')
    failed.p.setData({ planMessages: [message('我想跑步', 'fail-user')] })
    await failed.p.generatePlanTasks()
    eq(failed.p.data.draftSource, 'local_template'); eq(failed.p.data.draftCloudState, 'dirty')
    eq(failed.p.data.plannerState.sourcePlanId, ''); eq(failed.p.data.cloudDraftId, '')
    const timeoutGate = defer(), timed = page({ ...modelApi, aiDoGenerate: () => timeoutGate.promise })
    timed.p.collectPlannerUserMessage('我想游泳', 'timeout-user')
    const waiting = timed.p.generatePlanTasks(); await new Promise(r => setImmediate(r))
    timed.timers.find(t => t.ms === 30000).fn()
    eq(timed.p.data.plannerState.generatedGoal, null)
    let readStatus = 'running', resumeStarts = 0, resumeCalls = 0, keyReads = 0, hasConfig = true
    const resumed = page({ ...modelApi,
      myApiKeys: async () => {
        keyReads++
        return hasConfig ? [{ provider: 'deepseek', model: 'deepseek-chat', has_key: true }] : []
      },
      aiStartGenerate: async () => { resumeStarts++; return { plan_id: 'same-generation' } },
      aiDoGenerate: async () => { resumeCalls++; throw new Error('response lost') },
      aiPollPlan: async d => {
        eq(d.plan_id, 'same-generation')
        return { status: readStatus, result: { goal: { title: '原计划' }, tasks: [{ title: '原任务' }], source: 'model' } }
      },
    })
    resumed.p.collectPlannerUserMessage('我想游泳', 'resume-user')
    await resumed.p.generatePlanTasks()
    eq(resumed.p.data.plannerState.generatedGoal, null)
    eq(resumed.p.data.planStatus.includes('尚未确认'), true)
    readStatus = 'done'
    hasConfig = false
    await resumed.p.generatePlanTasks()
    eq(resumeStarts, 1); eq(resumeCalls, 1)
    eq(keyReads, 1)
    eq(resumed.p.data.plannerState.generatedGoal.title, '原计划')
    const startAttempts = [], dispatched = []
    const lostStartApi = { ...modelApi,
      aiPollPlan: async data => (await run('aiPollPlan', data)).data,
      aiStartGenerate: async payload => {
        const receipt = await run('aiStartGenerate', payload)
        eq(receipt.code, 0)
        startAttempts.push({ requestId: payload.request_id, planId: receipt.data.plan_id })
        if (startAttempts.length === 1) throw new Error('first creation response lost')
        return receipt.data
      },
      aiDoGenerate: async data => {
        dispatched.push(data.plan_id)
        return { goal: { title: '恢复同一任务' }, tasks: [{ title: '原任务' }], source: 'model' }
      },
    }
    const lostStart = page(lostStartApi)
    lostStart.app.globalData.userInfo = { id: 'original' }
    lostStart.p.syncPlannerDraftOwner()
    lostStart.p.collectPlannerUserMessage('我想游泳', 'lost-start-user')
    lostStart.p.setData({ planMessages: [message('我想游泳', 'lost-start-user')] })
    await lostStart.p.generatePlanTasks()
    eq(lostStart.p.data.plannerState.generatedGoal, null)
    eq(lostStart.p.data.planStatus.includes('创建结果尚未确认'), true)
    eq(dispatched, [])
    const restarted = page(lostStartApi, lostStart.storage)
    restarted.app.globalData.userInfo = { id: 'original' }
    await restarted.p.openPlannerWorkspace()
    eq(restarted.p.data.generationRecoveryAvailable, true)
    eq(dispatched, [])
    const otherAccount = page(lostStartApi, lostStart.storage)
    otherAccount.app.globalData.userInfo = { id: 'different-account' }
    await otherAccount.p.openPlannerWorkspace()
    eq(otherAccount.p.data.generationRecoveryAvailable, false)
    restarted.p.setData({ planInput: '未发送的输入' })
    await restarted.p.resumePlannerGeneration()
    eq(restarted.p.data.planInput, '未发送的输入')
    eq(dispatched, [])
    restarted.p.setData({ planInput: '' })
    const readBase = lostStartApi.getPlannerDraft
    const draftBeforeRecovery = restarted.p.data.plannerState.generatedGoal
    lostStartApi.getPlannerDraft = async () => {
      const current = await readBase()
      return { ...current, revision: current.revision + 1 }
    }
    await restarted.p.resumePlannerGeneration()
    eq(dispatched, [])
    eq(restarted.p.data.plannerState.generatedGoal, draftBeforeRecovery)
    eq(restarted.p.data.generationRecoveryAvailable, true)
    lostStartApi.getPlannerDraft = readBase
    await restarted.p.resumePlannerGeneration()
    eq(startAttempts.length, 1)
    eq(dispatched, [startAttempts[0].planId])
    eq(restarted.p.data.plannerState.generatedGoal.title, '恢复同一任务')
    eq(restarted.p.data.generationRecoveryAvailable, false)
    let unprotectedStarts = 0
    const fullStorage = page({ ...modelApi, aiStartGenerate: async () => { unprotectedStarts++ } })
    fullStorage.options.failStorage = true
    fullStorage.p.collectPlannerUserMessage('我想游泳', 'no-storage-user')
    await fullStorage.p.generatePlanTasks()
    eq(unprotectedStarts, 0)
    eq(fullStorage.p.data.planStatus.includes('本机无法保存'), true)
    const pendingStarts = [], providers = []
    let keys = [{ provider: 'deepseek', model: 'deepseek-chat', has_key: true }]
    const notYetCreated = page({ ...modelApi,
      myApiKeys: async () => keys,
      aiStartGenerate: async data => {
        pendingStarts.push(data.request_id)
        if (pendingStarts.length === 1) throw new Error('creation not received')
        return { plan_id: 'replayed-start' }
      },
      aiPollPlan: async () => ({ status: 'missing' }),
      aiDoGenerate: async data => {
        providers.push(data.provider)
        return { goal: { title: '仍用原配置' }, tasks: [{ title: '原任务' }] }
      },
    })
    notYetCreated.p.collectPlannerUserMessage('我想游泳', 'missing-start-user')
    await notYetCreated.p.generatePlanTasks()
    keys = [{ provider: 'qwen', model: 'qwen-plus', has_key: true }]
    await notYetCreated.p.generatePlanTasks()
    eq(pendingStarts.length, 1); eq(providers, [])
    eq(notYetCreated.p.data.planStatus.includes('恢复原服务商'), true)
    keys.push({ provider: 'deepseek', model: 'deepseek-chat', has_key: true })
    await notYetCreated.p.generatePlanTasks()
    eq(pendingStarts, [pendingStarts[0], pendingStarts[0]])
    eq(providers, ['deepseek'])
    eq(timed.p.data.planStatus.includes('云端可能仍在处理'), true)
    timeoutGate.resolve({ goal: { title: '晚到结果' }, tasks: [{ title: '晚到任务' }] }); await waiting
    eq(timed.p.data.plannerState.generatedGoal, null)
    const changing = page(api)
    changing.p.collectPlannerUserMessage('我想游泳，10天，每天20分钟', 'before-change')
    changing.p.collectPlannerUserMessage('换个目标，我想跑步', 'after-change')
    changing.p._handleChangeGoal()
    eq(changing.p.data.plannerState.goalContext.what, '跑步'); eq(changing.p.data.plannerState.goalContext.dailyTime, '')
    const published = page(api); await published.p.restorePlannerDraft()
    const publishedRevision = published.p.data.cloudDraftRevision
    await published.p.retirePublishedPlannerDraft({ cloud_draft_revision: publishedRevision, publication_id: 'publication-example' })
    eq((await store.get('owner')).draft, null); eq(published.p.data.draftCloudState, 'empty')
    await store.save('owner', input(publishedRevision + 1, 'after-publication', 'after-publication-conversation'))
    await published.p.retirePublishedPlannerDraft({ cloud_draft_revision: publishedRevision, publication_id: 'publication-example' })
    eq(published.p.data.draftCloudState, 'error'); eq((await store.get('owner')).draft.request_id, 'after-publication')
  } finally { env.close() }
  // Rollback after version insert must leave neither head nor orphan version.
  let failHead = true
  const broken = offlineCloudbase({ ai_plans: [] }, { beforeRequest(command, args) {
    if (failHead && command === 'database.insertDocument' && JSON.stringify(args.data).includes('planner_workspace')) return { code: 'INJECTED_FAILURE', message: 'head write failed' }
  } })
  try {
    const s = createStore(broken.cloud)
    await rejected(() => s.save('owner', input()), /head write failed/)
    eq(broken.rows.ai_plans.length, 0)
    failHead = false; eq((await s.save('owner', input())).revision, 1)
  } finally { broken.close() }
  console.log(JSON.stringify({ passed: checks, failed: 0, scope: 'Production context/store/handlers/Page, installed SDK offline transaction transport, HTTPS stub. No real cloud/model/phone verification.' }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
