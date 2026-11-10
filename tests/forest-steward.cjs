// Exercise production pages with read-only API stubs. No cloud writes/model calls.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const today = require('../miniprogram/utils/planSchedule').today()
const navigation = require('../miniprogram/utils/aiNavigation')
let checks = 0
const eq = (actual, expected) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); checks++ }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function page(api = {}, options = {}, filename = 'forest-steward/forest-steward') {
  const application = options.application || { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }
  const storage = options.storage || new Map()
  const calls = { tabs: [], routes: [], toasts: [], modals: [] }
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync(key, value) { if (options.storageFails) throw new Error('STORAGE_FULL'); storage.set(key, structuredClone(value)) },
    showToast: value => calls.toasts.push(value), showModal: value => calls.modals.push(value),
    navigateTo: value => calls.routes.push(value), switchTab: value => calls.tabs.push(value), stopPullDownRefresh() {}
  }
  const file = path.join(root, 'miniprogram/pages', filename + '.js'), localRequire = createRequire(file)
  let instance
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
    Page: value => { instance = value }, wx, getApp: () => application,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}
  })
  instance.data = structuredClone(instance.data)
  instance.setData = function(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  return { instance, storage, application, calls, wx }
}
const event = id => ({ currentTarget: { dataset: { id } } })
const goals = [{ _id: 'a', title: '阅读', status: 'active' }, { _id: 'b', title: '跑步', status: 'done' }, { _id: 'gone', status: 'deleted' }]
async function main() {
  let taskCalls = 0
  const first = page({ goals: async () => goals, tasks: async () => { taskCalls++; return [] } })
  await first.instance.onShow()
  eq(first.instance.data.goals.length, 2)
  eq(first.instance.data.currentGoal, null) // no silently selected first goal
  eq(taskCalls, 0)
  eq(first.instance.data.goals[1].statusLabel, '已完成')
  first.instance.onDemandInput({ detail: { value: '每天阅读20分钟' } })
  first.instance.onHide()
  const reopened = page({ goals: async () => goals }, { storage: first.storage })
  await reopened.instance.onShow()
  eq(reopened.instance.data.demand, '每天阅读20分钟')
  const oldKey = 'forest_steward_workspace_v1:owner'
  const oldCache = { version: 1, demand: '缺少账号绑定的旧稿', goalId: 'a' }
  first.storage.set(oldKey, oldCache)
  reopened.application.globalData.userInfo = { id: 'recreated' }
  eq(reopened.instance.openPlanner(), false)
  await reopened.instance.onShow()
  eq(reopened.instance.data.demand, '')
  eq(reopened.instance.data.currentGoal, null)
  eq(first.storage.get(oldKey), oldCache)

  const taskQueries = []
  const real = page({ goals: async () => ({ data: goals }), tasks: async params => {
    taskQueries.push(params)
    return [{ id: '1', goal_id: 'a', date: today, title: '读书', completed: true, estimated_minutes: 20 },
      { id: '2', goal_id: 'a', date: today, title: '笔记', completed: false },
      { id: 'other', goal_id: 'b', date: today, completed: true },
      { id: 'old', goal_id: 'a', date: '2000-01-01', completed: true }]
  } })
  await real.instance.onShow()
  await real.instance.selectGoal(event('a'))
  eq(taskQueries[0], { date: today, goal_id: 'a' })
  eq(real.instance.data.tasks.length, 2)
  eq(real.instance.data.completed, 1)
  eq(real.instance.data.pending, 1)
  eq(real.instance.data.tasks[1].minutesLabel, '未设置预计时长')
  real.instance.viewGoal()
  eq(real.calls.routes[0].url, '/pages/goal-detail/goal-detail?id=a')
  const resumed = page({ goals: async () => goals, tasks: async () => [] }, { storage: real.storage })
  await resumed.instance.onShow()
  eq(resumed.instance.data.currentGoal.id, 'a')
  eq(resumed.instance.data.tasks.length, 0)
  eq(resumed.instance.data.completed, 0)

  const oldRequest = deferred(), newRequest = deferred()
  const racing = page({ goals: async () => goals, tasks: params => params.goal_id === 'a' ? oldRequest.promise : newRequest.promise })
  await racing.instance.onShow()
  const oldLoad = racing.instance.selectGoal(event('a'))
  const newLoad = racing.instance.selectGoal(event('b'))
  newRequest.resolve([{ id: 'b-task', goal_id: 'b', date: today, completed: true }])
  await newLoad
  oldRequest.resolve([{ id: 'a-task', goal_id: 'a', date: today, completed: false }])
  await oldLoad
  eq(racing.instance.data.currentGoal.id, 'b')
  eq(racing.instance.data.tasks[0].id, 'b-task')
  eq(racing.instance.data.completed, 1)

  const failure = page({ goals: async () => goals, tasks: async () => { throw new Error('network') } })
  await failure.instance.onShow()
  await failure.instance.selectGoal(event('a'))
  eq(!!failure.instance.data.taskError, true)
  eq(failure.instance.data.taskLoading, false)
  eq(failure.instance.data.loadedAt, '')
  const malformed = page({ goals: async () => ({ success: false }) })
  await malformed.instance.onShow()
  eq(!!malformed.instance.data.error, true)
  eq(malformed.instance.data.loading, false)

  const pending = deferred(), closed = page({ goals: () => pending.promise })
  const closing = closed.instance.onShow()
  closed.instance.onUnload()
  pending.resolve(goals)
  await closing
  eq(closed.instance.data.goals.length, 0)

  const brokenStorage = page({ goals: async () => goals }, { storageFails: true })
  await brokenStorage.instance.onShow()
  brokenStorage.instance.onDemandInput({ detail: { value: '新需求' } })
  brokenStorage.instance.onDemandBlur()
  eq(!!brokenStorage.instance.data.storageWarning, true)
  eq(brokenStorage.instance.data.demand, '新需求')

  real.application.globalData.currentOpenid = 'different-owner'
  await real.instance.onShow()
  eq(real.instance.data.currentGoal, null)
  eq(real.instance.data.demand, '')
  let anonymousReads = 0
  const anonymous = page({ goals: async () => { anonymousReads++; return goals } }, { application: { globalData: {} } })
  await anonymous.instance.onShow()
  anonymous.instance.openPlanner()
  eq(anonymousReads, 0)
  eq(anonymous.calls.tabs.length, 0)

  first.instance.openPlanner()
  eq(first.calls.tabs[0].url, '/pages/ai/ai')
  const nav = navigation.createNavigation(first.wx, () => first.application)
  eq(nav.takePlannerIntent().prompt, '每天阅读20分钟')
  eq(nav.takePlannerIntent(), null)
  nav.openPlanner('不应串账号')
  first.application.globalData.userInfo = { id: 'recreated' }
  eq(nav.takePlannerIntent(), null)
  nav.openPlanner('跳转失败')
  first.calls.tabs.at(-1).fail()
  eq(nav.takePlannerIntent(), null)

  const planner = page({}, {}, 'ai/ai')
  planner.instance._restorePendingPublication = () => false
  planner.instance.loadPetInfo = () => {}
  planner.instance.loadCapsules = () => {}
  planner.instance.data.planMessages = [{ role: 'user', content: '原对话' }]
  planner.instance.data.planInput = '未发送的原文'
  planner.instance._pendingPublication = { request: { publication_id: 'keep' } }
  const plannerNav = navigation.createNavigation(planner.wx, () => planner.application)
  plannerNav.openPlanner('新需求')
  planner.instance.onShow()
  eq(planner.instance.data.mode, 'plan')
  eq(planner.instance.data.planMessages[0].content, '原对话')
  eq(planner.instance._pendingPublication.request.publication_id, 'keep')
  eq(planner.instance.data.planInput, '未发送的原文')
  planner.calls.modals[0].success({ confirm: false })
  eq(planner.instance.data.planInput, '未发送的原文')
  plannerNav.openPlanner('新需求')
  planner.instance.onShow()
  planner.calls.modals[1].success({ confirm: true })
  eq(planner.instance.data.planInput, '新需求')
  eq(planner.instance._pendingPublication.request.publication_id, 'keep')
  plannerNav.openPlanner('旧账号留下的弹窗需求')
  planner.instance.onShow()
  planner.application.globalData.userInfo = { id: 'recreated' }
  planner.instance.onShow()
  planner.calls.modals[2].success({ confirm: true })
  eq(planner.instance.data.planInput, '')
  console.log(JSON.stringify({ passed: checks, failed: 0, scope: 'Production frontend, offline read-only stubs; no cloud/model/phone verification' }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
