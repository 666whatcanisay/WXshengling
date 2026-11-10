const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict')
const { createRequire } = require('node:module')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
const current = { revision: 2, draft: { snapshot: { goal: { title: '阅读' } } } }
function page(api, name = 'forest-steward/forest-steward') {
  const file = path.resolve(__dirname, '../miniprogram/pages', name + '.js'), req = createRequire(file), storage = new Map()
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }; let p
  const wx = { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k),
    showToast() {}, showModal() {}, switchTab() {}, navigateTo() {}, stopPullDownRefresh() {} }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : req(n), Page: v => { p = v }, wx, getApp: () => app,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  p.data = structuredClone(p.data)
  p.setData = function(patch, callback) { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let o = this.data; for (const k of parts.slice(0, -1)) o = o[k]; o[parts.at(-1)] = value } if (callback) callback() }
  return { p, app, wx }
}
const run = (status = 'ready', id = 'run1') => ({ id, mode: 'new', status, is_current: status === 'awaiting_confirmation',
  draft_revision: 3, draft_title: '游泳', steps: [{ name: 'manager', label: '森林管家', status: 'done' }] })
async function main() {
  let startCalls = 0, steps = [], saved = null
  const api = { goals: async () => [], getPlannerDraft: async () => current, getStewardRun: async () => ({ run: saved }),
    startStewardRun: async d => { startCalls++; eq(d.expected_revision, 2); return { run: saved = run() } },
    stepStewardRun: async d => { steps.push(d); return { run: saved = run(steps.length === 4 ? 'awaiting_confirmation' : 'ready') } },
    cancelStewardRun: async () => ({ run: saved = run('cancelled') }) }
  const { p } = page(api); await p.onShow(); await p.refreshSteward()
  eq(startCalls, 0); eq(steps.length, 0); eq(p.data.stewardHasDraft, true)
  p.onDemandInput({ detail: { value: '我想游泳，10天，每天20分钟' } })
  await p.startNewSteward()
  eq(startCalls, 1); eq(steps.length, 4); eq(new Set(steps.map(s => s.request_id)).size, 4)
  eq(p.data.stewardRun.status, 'awaiting_confirmation'); eq(p.data.stewardBaseRevision, 3); eq(p.data.stewardBusy, '')
  await p.refreshSteward(); eq(steps.length, 4)
  p.openStewardDraft()
  const nav = require('../miniprogram/utils/aiNavigation').createNavigation({}, () => ({ globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }))
  eq(nav.takePartnerIntent().refreshDraft, true)
  await p.cancelSteward(); eq(p.data.stewardRun.status, 'cancelled')

  const pending = defer(); let hiddenSteps = 0
  const hidden = page({ ...api, getStewardRun: async () => ({ run: run() }), stepStewardRun: async () => { hiddenSteps++; return pending.promise } })
  await hidden.p.onShow(); await hidden.p.refreshSteward()
  const executing = hidden.p.continueSteward(); hidden.p.onHide(); pending.resolve({ run: run('ready') }); await executing
  eq(hiddenSteps, 1); eq(hidden.p.data.stewardRun.status, 'ready')
  await hidden.p.onShow(); await hidden.p.refreshSteward(); eq(hiddenSteps, 1) // Re-entry reads; never silently resumes paid work.

  let uncertainStarts = 0
  const uncertain = page({ ...api, getStewardRun: async () => ({ run: null }), startStewardRun: async () => { uncertainStarts++; throw Error('response lost') } })
  await uncertain.p.onShow(); await uncertain.p.refreshSteward(); uncertain.p.data.demand = '我想阅读'
  await uncertain.p.startNewSteward(); eq(uncertain.p.data.stewardUncertain, true)
  await uncertain.p.startNewSteward(); eq(uncertainStarts, 1)
  await uncertain.p.refreshSteward(); eq(uncertain.p.data.stewardUncertain, false)

  const late = defer(), switched = page({ ...api, getStewardRun: () => late.promise })
  const loading = switched.p.onShow(); switched.app.globalData.userInfo = { id: 'recreated' }; late.resolve({ run: run('awaiting_confirmation') }); await loading
  eq(switched.p.data.stewardRun, null)

  // A manager handoff refreshes a saved old AI-tab draft, while dirty work stays protected.
  const schedule = require('../miniprogram/utils/planSchedule'), day = schedule.today()
  const fresh = { id: 'd3', revision: 3, fingerprint: 'a'.repeat(64), conversation_id: 'chat3', source: 'model', messages: [],
    context: { values: { what: '游泳' }, sources: {}, revision: 2 }, snapshot: { goal: { title: '管家新稿', target_days: 7, start_date: day, stages: [] },
      tasks: [{ draft_task_id: 't3', title: '呼吸练习', date: day, stage: 1, estimated_minutes: 10, xp_reward: 10 }] } }
  const ai = page({ getPlannerDraft: async () => ({ revision: 3, draft: fresh }), getPlannerReview: async () => ({ review: null }) }, 'ai/ai')
  ai.p.syncPlannerDraftOwner(); ai.p.syncPartnerOwner(); ai.p.applyPlannerDraft({ ...fresh, id: 'd2', revision: 2, snapshot: { ...fresh.snapshot, goal: { ...fresh.snapshot.goal, title: '旧稿' } } })
  ai.p.data.auditBusy = 'ai' // A late review of the old version must not block the manager's new-draft handoff.
  require('../miniprogram/utils/aiNavigation').createNavigation(ai.wx, () => ai.app).openPartner('review', { refreshDraft: true })
  await ai.p.onShow(); eq(ai.p.data.reviewDraft.title, '管家新稿'); eq(ai.p.data.cloudDraftRevision, 3)
  ai.p.editPlanTaskTitle({ detail: { value: '未保存的本机修改' }, currentTarget: { dataset: { index: 0 } } })
  require('../miniprogram/utils/aiNavigation').createNavigation(ai.wx, () => ai.app).openPartner('review', { refreshDraft: true })
  await ai.p.onShow(); eq(ai.p.data.editableTasks[0].title, '未保存的本机修改'); eq(ai.p.data.draftCloudState, 'dirty')
  eq(ai.p.data.auditError.includes('本机'), true)
  const reference = { run_id: 'bound', binding: { draft_id: fresh.id, revision: fresh.revision, fingerprint: fresh.fingerprint,
    requirements_revision: fresh.context.revision, rules_version: 'planner-review-v1' } }
  const bound = page({ getPlannerDraft: async () => ({ revision: 3, draft: fresh }), getPlannerReview: async () => ({ review: null }),
    getStewardRun: async () => ({ run: { id: 'bound', handoff: reference } }) }, 'ai/ai')
  const boundNav = require('../miniprogram/utils/aiNavigation').createNavigation(bound.wx, () => bound.app)
  boundNav.openPartner('review', { stewardRunId: 'bound', steward: reference })
  await bound.p.onShow()
  eq(bound.p.data.stewardDraft, true)
  eq(bound.p.data.reviewDraft.title, '管家新稿')
  const review = { id: 'review-current', is_current: true, binding: reference.binding }
  bound.p.setData({ auditRules: review })
  bound.p.openReviewFinding({ currentTarget: { dataset: { review: review.id, task: 't3' } } })
  eq(bound.p.data.planEditAnchor, 'plan-task-0')
  eq(bound.p.data.showPlanModal, true)
  bound.p.openDraftReview()
  bound.p.setData({ auditRules: review })
  bound.p.openReviewFinding({ currentTarget: { dataset: { review: review.id, task: 'deleted-task' } } })
  eq(bound.p.data.showPlanModal, false)
  eq(bound.p.data.auditError.includes('任务已删除'), true)
  bound.p.setData({ auditRules: { ...review, binding: { ...review.binding, revision: 2 } } })
  bound.p.openReviewFinding({ currentTarget: { dataset: { review: review.id, task: 't3' } } })
  eq(bound.p.data.showPlanModal, false)
  eq(bound.p.data.auditError.includes('审核版本已变化'), true)
  bound.p.editPlanTaskTitle({ detail: { value: '留在本机的新版' }, currentTarget: { dataset: { index: 0 } } })
  boundNav.openPartner('review', { stewardRunId: 'bound', steward: reference })
  await bound.p.onShow()
  eq(bound.p.data.editableTasks[0].title, '留在本机的新版')
  eq(bound.p.data.auditError.includes('本机'), true)
  console.log('steward-client: ' + checks + ' assertions passed (offline Page/API stubs)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
