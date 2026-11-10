// Actual AI Page + local storage/read API stubs. No models, cloud writes or UI automation.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const assert = require('node:assert/strict'), { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..'), file = path.join(root, 'miniprogram/pages/ai/ai.js')
const localRequire = createRequire(file), schedule = require('../miniprogram/utils/planSchedule')
const today = schedule.today(), yesterday = schedule.addDays(today, -1)
let checks = 0
const eq = (actual, expected) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); checks++ }
function defer() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function page(api = {}, storage = new Map()) {
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, calls = { toast: [], write: 0 }
  const options = { failSave: false, failRead: false }
  const wx = {
    getStorageSync(key) { if (options.failRead) throw new Error('read failed'); return storage.get(key) },
    setStorageSync(key, value) { if (options.failSave) throw new Error('storage full'); calls.write++; storage.set(key, structuredClone(value)) },
    showToast: value => calls.toast.push(value), showModal() {}, switchTab() {}, navigateTo() {}
  }
  let instance
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
    Page: value => { instance = value }, wx, getApp: () => app,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  instance.data = structuredClone(instance.data)
  instance.setData = function(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.split('.'); let target = this.data
      for (const part of keys.slice(0, -1)) target = target[part]
      target[keys.at(-1)] = value
    }
  }
  instance.syncPartnerOwner()
  return { instance, app, wx, storage, calls, options }
}
const goals = [{ _id: 'a', title: '阅读', status: 'active' }, { _id: 'b', title: '运动', status: 'done' }, { _id: 'gone', status: 'deleted' }]
const choose = value => ({ detail: { value } })
async function main() {
  const empty = page(); empty.instance.loadReviewDraft()
  eq(empty.instance.data.reviewDraft, null)
  eq(empty.instance.data.reviewError, '')
  const p = page(), instance = p.instance
  instance._updatePlannerState({ generatedGoal: { title: '阅读计划' }, generatedTasks: [{ title: '读一章', date: today, estimated_minutes: 20 }],
    goalContext: { what: '每天阅读', dailyTime: '20分钟' }, sourcePlanId: 'plan-a' })
  instance.setData({ planStartDate: today, planDays: 7 })
  const original = JSON.stringify(instance.data.editableTasks)
  instance.openDraftReview()
  eq(instance.data.mode, 'review')
  eq(instance.data.showPlanModal, false)
  eq(instance.data.reviewDraft.title, '阅读计划')
  eq(instance.data.reviewDraft.count, 1)
  eq(instance.data.reviewDraft.revision, 1)
  eq(instance.data.reviewDraft.requirements.length, 2)
  instance.loadReviewDraft()
  eq(instance.data.reviewDraft.revision, 1)
  instance.data.editableTasks[0].title = '读两章'
  eq(instance.data.reviewDraft.tasks[0].title, '读一章') // snapshot cannot mutate under an eventual audit
  instance.loadReviewDraft()
  eq(instance.data.reviewDraft.revision, 2)
  eq(instance.data.reviewDraft.tasks[0].title, '读两章')
  instance.openPartnerPlanner()
  eq(instance.data.mode, 'plan')
  eq(instance.data.showPlanModal, true)
  eq(JSON.parse(original)[0].date, instance.data.editableTasks[0].date)
  eq(p.calls.write, 0)
  const scope = JSON.stringify(['owner', 'account'])
  p.storage.set('ai_publication_pending_v2:' + scope, { version: 2, scope, request: { publication_id: 'pending', goal: { title: '待确认原稿', target_days: 5, start_date: today }, tasks: [{ title: '原稿任务', date: today }] }, context: { what: '确认目标' } })
  instance.loadReviewDraft()
  eq(instance.data.reviewDraft.title, '待确认原稿')
  eq(instance.data.reviewDraft.locked, true)
  eq(instance.data.reviewDraft.tasks[0].title, '原稿任务')
  p.app.globalData.currentOpenid = 'other'
  instance.loadReviewDraft()
  eq(instance.data.reviewDraft, null)
  p.app.globalData.currentOpenid = ''
  instance.loadReviewDraft()
  eq(!!instance.data.reviewError, true)

  const query = [], coach = page({ goals: async () => goals, tasks: async params => {
    query.push(params)
    return [{ id: '1', goal_id: params.goal_id, date: params.date, title: '阅读', completed: true },
      { id: '2', goal_id: params.goal_id, date: params.date, completed: false },
      { goal_id: 'wrong', date: params.date, completed: true }, { goal_id: params.goal_id, date: '2000-01-01', completed: true }]
  } })
  await coach.instance.loadCoachGoals()
  eq(coach.instance.data.coachGoals.length, 2)
  eq(coach.instance.data.coachGoalId, '')
  eq(coach.instance.data.coachFacts, null)
  eq(query.length, 0)
  await coach.instance.onCoachGoalChange(choose('0'))
  eq(query[0], { goal_id: 'a', date: today })
  eq(coach.instance.data.coachFacts, { total: 2, completed: 1, pending: 1, rate: 50 })
  coach.instance.onCoachReason({ currentTarget: { dataset: { reason: '时间不够' } } })
  coach.instance.onCoachNote(choose('今天加班'))
  eq(coach.instance.saveCoachFeedback(), true)
  eq(coach.storage.size, 1)
  await coach.instance.onCoachDateChange(choose(yesterday))
  eq(coach.instance.data.coachNote, '')
  await coach.instance.onCoachDateChange(choose(today))
  eq(coach.instance.data.coachNote, '今天加班')
  eq(coach.instance.data.coachReason, '时间不够')
  coach.options.failRead = true
  coach.instance.restoreCoachFeedback()
  eq(coach.instance.data.coachFeedbackReadError, true)
  coach.instance.onCoachNote(choose('不可覆盖'))
  eq(coach.instance.data.coachNote, '')
  coach.options.failRead = false
  coach.instance.restoreCoachFeedback()
  eq(coach.instance.data.coachFeedbackReadError, false)
  eq(coach.instance.data.coachNote, '今天加班')
  await coach.instance.onCoachGoalChange(choose('1'))
  eq(coach.instance.data.coachNote, '')
  await coach.instance.onCoachGoalChange(choose('0'))
  coach.instance.onCoachNote(choose('保存失败时保留'))
  coach.options.failSave = true
  await coach.instance.onCoachDateChange(choose(yesterday))
  eq(coach.instance.data.coachDate, today)
  eq(coach.instance.data.coachNote, '保存失败时保留')
  eq(!!coach.instance.data.coachFeedbackError, true)
  coach.options.failSave = false
  coach.instance.leavePartnerWorkspace()
  eq(coach.instance.data.coachFeedbackStatus, '已保存到本机 · 尚未同步云端')
  coach.app.globalData.currentOpenid = 'other'
  await coach.instance.loadCoachGoals()
  eq(coach.instance.data.coachNote, '')
  eq(coach.instance.data.coachGoalId, '')

  const noTasks = page({ goals: async () => goals, tasks: async () => [] })
  await noTasks.instance.loadCoachGoals(); await noTasks.instance.onCoachGoalChange(choose(0))
  eq(noTasks.instance.data.coachFacts, { total: 0, completed: 0, pending: 0, rate: null })
  const failure = page({ goals: async () => goals, tasks: async () => { throw new Error('network') } })
  await failure.instance.loadCoachGoals(); await failure.instance.onCoachGoalChange(choose(0))
  eq(failure.instance.data.coachFacts, null)
  eq(!!failure.instance.data.coachTasksError, true)
  eq(failure.calls.toast.length, 0) // no fake "analysis completed"
  const bad = page({ goals: async () => ({ success: false }) }); await bad.instance.loadCoachGoals()
  eq(!!bad.instance.data.coachGoalsError, true)
  const fetching = defer(), waiting = page({ goals: () => fetching.promise })
  const goalReading = waiting.instance.loadCoachGoals()
  await waiting.instance.onCoachDateChange(choose(yesterday))
  eq(waiting.instance.data.coachDate, today)
  fetching.resolve(goals); await goalReading
  eq(waiting.instance.data.coachGoalsLoading, false)
  const a = defer(), b = defer(), racing = page({ goals: async () => goals, tasks: params => params.date === today ? a.promise : b.promise })
  await racing.instance.loadCoachGoals()
  const first = racing.instance.onCoachGoalChange(choose(0))
  const second = racing.instance.onCoachDateChange(choose(yesterday))
  b.resolve([{ title: '昨天任务', goal_id: 'a', date: yesterday, completed: true }]); await second
  a.resolve([{ title: '今天任务', goal_id: 'a', date: today, completed: false }]); await first
  eq(racing.instance.data.coachTasks[0].title, '昨天任务')
  eq(racing.instance.data.coachFacts.completed, 1)
  const late = defer(), closed = page({ goals: async () => goals, tasks: () => late.promise })
  await closed.instance.loadCoachGoals(); const reading = closed.instance.onCoachGoalChange(choose(0))
  closed.instance.leavePartnerWorkspace(); late.resolve([{ goal_id: 'a', date: today, completed: true }]); await reading
  eq(closed.instance.data.coachFacts, null)
  const navigation = require('../miniprogram/utils/aiNavigation').createNavigation(coach.wx, () => coach.app)
  eq(navigation.openPartner('invalid'), false)
  navigation.openPartner('coach', { goalId: 'a' })
  eq(navigation.takePartnerIntent().goalId, 'a')
  navigation.openPartner('review')
  eq(navigation.takePartnerIntent().mode, 'review')
  const linked = page({ goals: async () => goals, tasks: async () => [] })
  linked.instance.loadPetInfo = () => {}
  linked.instance.loadCapsules = () => {}
  const linkedNav = require('../miniprogram/utils/aiNavigation').createNavigation(linked.wx, () => linked.app)
  linkedNav.openPartner('coach', { goalId: 'b' })
  await linked.instance.onShow()
  eq(linked.instance.data.mode, 'coach')
  eq(linked.instance.data.coachGoalId, 'b')
  eq(linked.instance.data.coachFacts.total, 0)
  linkedNav.openPartner('review')
  await linked.instance.onShow()
  eq(linked.instance.data.mode, 'review')
  console.log(JSON.stringify({ passed: checks, failed: 0, scope: 'Actual AI Page and read/storage stubs; no models/cloud/phone verification' }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
