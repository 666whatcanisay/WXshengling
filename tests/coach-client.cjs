const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict')
const { createRequire } = require('node:module'), { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService } = require('../cloudfunctions/app/lib/coachService')
const schedule = require('../miniprogram/utils/planSchedule')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
function page(api, storage = new Map(), name = 'ai/ai') {
  const file = path.resolve(__dirname, '../miniprogram/pages', name + '.js'), req = createRequire(file), app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, options = { storageFail: false, toasts: [] }
  let p
  const wx = { getStorageSync: k => storage.get(k), setStorageSync(k, v) { if (options.storageFail) throw Error('storage full'); storage.set(k, structuredClone(v)) }, removeStorageSync: k => storage.delete(k),
    showToast(v) { options.toasts.push(v) }, showModal() {}, navigateTo() {}, switchTab() {}, stopPullDownRefresh() {} }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : req(n), Page: d => { p = d }, wx, getApp: () => app,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  p.data = structuredClone(p.data)
  p.setData = function(patch) { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let o = this.data; for (const k of parts.slice(0, -1)) o = o[k]; o[parts.at(-1)] = value } }
  return { p, app, storage, options, wx }
}
const event = value => ({ detail: { value } })
async function choose(p) { await p.loadCoachGoals(); await p.onCoachGoalChange(event('0')) }
async function main() {
  const today = schedule.today(), yesterday = schedule.addDays(today, -1)
  const env = offlineCloudbase({ ai_plans: [], goals: [{ _id: 'g1', _openid: 'owner', title: '阅读', start_date: yesterday }, { _id: 'g2', _openid: 'owner', title: '运动' }],
    tasks: [{ _id: 't1', _openid: 'owner', goal_id: 'g1', date: yesterday, title: '阅读', completed: true }, { _id: 't2', _openid: 'owner', goal_id: 'g1', date: today, title: '阅读', completed: false }] })
  let calls = 0, saveCalls = 0
  const service = createService({ cloud: env.cloud, loadModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }), callModel: async () => {
    calls++; return JSON.stringify({ summary: '根据已有记录提出建议', observations: [], suggestions: [{ message: '补充感受', action: '记录一个困难', evidence_ids: ['coverage'] }], uncertainties: ['记录有限'] }) } })
  const api = { getCoachGoals: () => service.listGoals('owner'), getCoachWorkspace: d => service.get('owner', d),
    saveCoachFeedback: d => { saveCalls++; return service.saveFeedback('owner', d) }, reviewCoach: d => service.review('owner', d) }
  try {
    const client = page(api), p = client.p
    await p.loadCoachGoals(); eq(p.data.coachGoalId, ''); eq(calls, 0)
    await p.onCoachGoalChange(event('0'))
    eq(p.data.coachWindow.past.rate, 100); eq(p.data.coachWindow.today.pending, 1); eq(p.data.coachCloudRevision, 0)
    p.onCoachDifficulty({ currentTarget: { dataset: { difficulty: '偏难' } } }); p.onCoachActualMinutes(event('0')); p.onCoachNote(event('今天加班'))
    p.saveCoachFeedback(); eq(p.data.coachCloudDirty, true)
    eq(p.data.coachFeedbackStatus.includes('尚未同步云端'), true)
    await p.runCoachReview(); eq(calls, 0); eq(p.data.coachReportError.includes('先将本机'), true)
    await p.saveCoachCloudFeedback()
    eq(p.data.coachCloudRevision, 1); eq(p.data.coachCloudDirty, false); eq(p.data.coachActualMinutes, '0'); eq(p.data.coachDifficulty, '偏难'); eq(calls, 0)
    eq(p.data.coachFeedbackStatus, '已同步云端 · 版本 1')
    eq(client.options.toasts.at(-1).title, '反馈已保存到云端')
    const beforeRepeatedSave = saveCalls; await p.saveCoachCloudFeedback()
    eq(saveCalls, beforeRepeatedSave); eq(p.data.coachCloudMessage.includes('无需重复保存'), true)
    const cloudRestored = page(api, client.storage); await choose(cloudRestored.p)
    eq(cloudRestored.p.data.coachNote, '今天加班'); eq(cloudRestored.p.data.coachFeedbackStatus, '已同步云端 · 版本 1')
    await p.runCoachReview(); eq(calls, 1); eq(p.data.coachReport.status, 'done')
    await p.runCoachReview(); eq(calls, 1)
    p.onCoachActualMinutes(event('10')); eq(p.data.coachReportExpired, true)
    p.onCoachActualMinutes(event('0')); eq(p.data.coachReportExpired, false)

    let lose = true
    const lossApi = { ...api, async saveCoachFeedback(d) { const r = await api.saveCoachFeedback(d); if (lose) throw Error('response lost'); return r } }
    const loss = page(lossApi, client.storage); await choose(loss.p)
    loss.p.onCoachNote(event('第一次保存')); await loss.p.saveCoachCloudFeedback()
    eq(!!loss.p._coachFeedbackPending, true)
    loss.p.onCoachNote(event('响应丢失之后的新修改')); loss.p.saveCoachFeedback()
    lose = false
    const restored = page(api, loss.storage); await choose(restored.p)
    eq(restored.p.data.coachNote, '响应丢失之后的新修改'); eq(restored.p.data.coachCloudDirty, true)
    eq(restored.p._coachFeedbackPending, null); eq(restored.p._coachFeedbackBaseRevision, 2)
    await restored.p.saveCoachCloudFeedback(); eq(restored.p.data.coachCloudRevision, 3)

    const second = page(api); await choose(second.p)
    restored.p.onCoachNote(event('设备一')); await restored.p.saveCoachCloudFeedback()
    second.p.onCoachNote(event('设备二')); await second.p.saveCoachCloudFeedback()
    eq(second.p.data.coachCloudConflict, true); eq(second.p.data.coachNote, '设备二')
    await second.p.restoreCoachCloudFeedback()
    eq(second.p.data.coachNote, '设备一'); eq(second.p.data.coachCloudBackup, true)
    await second.p.restoreCoachLocalBackup()
    eq(second.p.data.coachNote, '设备二'); eq(second.p.data.coachCloudConflict, true)

    second.p.onCoachActualMinutes(event('-1'))
    await second.p.loadCoachEvidence()
    eq(!!second.p.data.coachWindow, true); eq(second.p.data.coachCloudDirty, true)
    await second.p.restoreCoachCloudFeedback(); eq(second.p.data.coachActualMinutes, '0')

    const broken = page(api); await choose(broken.p); broken.p.onCoachNote(event('保存失败保留'))
    broken.options.storageFail = true; const before = saveCalls
    await broken.p.saveCoachCloudFeedback(); eq(saveCalls, before); eq(broken.p.data.coachNote, '保存失败保留')

    const pending = defer(), raced = page({ ...api, getCoachWorkspace: () => pending.promise })
    const selecting = choose(raced.p)
    while (!raced.p.data.coachGoalId) await new Promise(r => setImmediate(r))
    raced.app.globalData.userInfo = { id: 'recreated' }; raced.p.syncPartnerOwner()
    pending.resolve(await service.get('owner', { goal_id: 'g1', date: today })); await selecting
    eq(raced.p.data.coachWindow, null); eq(raced.p.data.coachNote, '')

    const goalList = defer(), switching = page({ ...api, getCoachGoals: () => goalList.promise }, second.storage)
    const oldGoals = switching.p.loadCoachGoals()
    switching.app.globalData.userInfo = { id: 'recreated' }
    switching.p.syncPartnerOwner()
    goalList.resolve({ goals: [{ _id: 'g1', title: '旧账号目标' }], complete: true })
    await oldGoals
    eq(switching.p.data.coachGoals, [])
    eq(switching.p.data.coachGoalsLoading, false)
    const legacyKey = 'ai_coach_feedback_v1:' + JSON.stringify(['owner', 'g1', today])
    const legacy = { version: 1, note: '旧版无账号绑定' }
    second.storage.set(legacyKey, legacy)
    switching.p.setData({ coachGoalId: 'g1' })
    switching.p.restoreCoachFeedback()
    eq(switching.p.data.coachNote, '')
    eq(switching.p.data.coachCloudBackup, false)
    eq(second.storage.get(legacyKey), legacy)
    switching.app.globalData.userInfo = { id: 'account' }
    switching.p.syncPartnerOwner()
    switching.p.setData({ coachGoalId: 'g1' })
    switching.p.restoreCoachFeedback()
    eq(switching.p.data.coachNote, '设备一')
    eq(switching.p.data.coachCloudBackup, true)

    const delayed = defer(), frozen = page({ ...api, saveCoachFeedback: () => delayed.promise }); await choose(frozen.p)
    frozen.p.onCoachNote(event('等待响应')); const saving = frozen.p.saveCoachCloudFeedback()
    await frozen.p.onCoachGoalChange(event('1')); eq(frozen.p.data.coachGoalId, 'g1')
    frozen.p.leavePartnerWorkspace(); delayed.resolve({ feedback: { revision: 5, values: {} }, current_revision: 5, applied_revision: 5 }); await saving
    eq(frozen.p.data.coachCloudSaving, false)

    const steward = page({ ...api, goals: async () => [{ _id: 'g1', title: '阅读' }], tasks: async () => [] }, new Map(), 'forest-steward/forest-steward')
    await steward.p.onShow(); await steward.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
    eq(steward.p.data.coachSummary.facts.past.completed, 1); eq(calls, 1)
    steward.p.openCoach()
    const intent = require('../miniprogram/utils/aiNavigation').createNavigation({}, () => steward.app).takePartnerIntent()
    eq(intent.date, today); eq(intent.goalId, 'g1')
    // A prior manager selection must not replace the exact goal/date of a report handoff.
    const shared = page(api)
    shared.p.syncPartnerOwner()
    shared.p.setData({ coachGoalId: 'g1', coachDate: yesterday, coachReport: { status: 'done' } })
    eq(shared.p.openCoachInSteward(), true)
    const reads = [], report = { status: 'done', result: { summary: '准确目标的总结', suggestions: [] } }
    const managerApi = { goals: async () => [{ _id: 'g2', title: '游泳' }, { _id: 'g1', title: '晨跑' }], tasks: async () => [],
      getCoachWorkspace: async d => { reads.push(d); return { facts: { end: d.date }, report: d.goal_id === 'g1' && d.date === yesterday ? report : null } } }
    const manager = page(managerApi, new Map([['forest_steward_workspace_v2:' + JSON.stringify(['owner', 'account']), { version: 2, goalId: 'g2', demand: '' }]]), 'forest-steward/forest-steward')
    await manager.p.onShow()
    eq(manager.p.data.currentGoal.id, 'g1'); eq(manager.p.data.resultTab, 'summary')
    eq(manager.p.data.coachSummaryDate, yesterday); eq(manager.p.data.coachSummary.report.result.summary, '准确目标的总结')
    eq(reads[0], { goal_id: 'g1', date: yesterday })
    await manager.p.refreshStewardCoach(); eq(reads.at(-1).date, yesterday)
    manager.p.openCoach()
    const back = require('../miniprogram/utils/aiNavigation').createNavigation({}, () => manager.app).takePartnerIntent()
    eq(back.goalId, 'g1'); eq(back.date, yesterday)
    shared.p.setData({ coachCloudDirty: true }); eq(shared.p.openCoachInSteward() === undefined, true)
    shared.p.setData({ coachCloudDirty: false }); shared.p.openCoachInSteward()
    const other = page(managerApi, new Map(), 'forest-steward/forest-steward'); other.app.globalData.currentOpenid = 'other'
    await other.p.onShow(); eq(other.p.data.currentGoal, null)
    shared.p.setData({ coachGoalId: 'deleted' }); shared.p.openCoachInSteward()
    const missing = page(managerApi, manager.storage, 'forest-steward/forest-steward'); await missing.p.onShow()
    eq(missing.p.data.currentGoal, null); eq(missing.p.data.storageWarning.includes('未切换'), true)
    shared.app.globalData.userInfo = { id: 'recreated' }
    eq(shared.p.openCoachInSteward() === undefined, true)
  } finally { env.close() }
  console.log('coach-client: ' + checks + ' assertions passed (offline Page/SDK)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
