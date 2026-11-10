const assert = require('node:assert/strict')
const { page } = require('./adjustment-client.cjs')
const { createNavigation } = require('../miniprogram/utils/aiNavigation')
let checks = 0
const eq = (a, b) => { assert.deepEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
async function navigation() {
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account', openid: 'owner' } } }, tabs = [], routes = []
  const nav = createNavigation({ switchTab: v => tabs.push(v), navigateTo: v => routes.push(v), showToast() {} }, () => app)
  const scope = JSON.stringify(['owner', 'account'])
  nav.openPartner('coach', { goalId: 'old', date: '2026-11-06' })
  nav.openPartner('coach', { goalId: 'new', date: '2026-11-07' })
  tabs[0].fail()
  eq(nav.takePartnerIntent(), { scope, mode: 'coach', prompt: '', goalId: 'new', date: '2026-11-07' })
  nav.openPartner('plan', { prompt: '取消本次交接' }); tabs[2].fail(); eq(nav.takePartnerIntent(), null)
  nav.openPartner('review'); app.globalData.currentOpenid = 'other'; eq(nav.takePartnerIntent(), null)
  app.globalData.currentOpenid = 'owner'
  nav.openSteward({ goalId: 'old', date: '2026-11-06' }); nav.openSteward({ goalId: 'new', date: '2026-11-07' })
  routes[0].fail(); eq(nav.takeStewardIntent(), { scope, goalId: 'new', date: '2026-11-07' })
  let opened = 0
  nav.openPartner('chat', { petId: 'p1', onOpen: () => { opened++ } })
  eq(nav.takePartnerIntent().petId, 'p1')
  tabs.at(-1).success(); eq(opened, 1)
  nav.openNewGoal('现账号目标'); eq(nav.takeNewGoalTitle(), '现账号目标')
  nav.openPet('p1'); eq(nav.takePetIntent().petId, 'p1')
  nav.openPartner('chat', { petId: 'old-pet', onOpen: () => { opened++ } })
  const oldJump = tabs.at(-1)
  nav.openSteward({ goalId: 'old-goal', suggestion: { report_id: 'old' } })
  nav.openNewGoal('旧账号目标')
  nav.openPet('old-pet')
  app.globalData.userInfo = { id: 'recreated', openid: 'owner' }
  oldJump.success(); eq(opened, 1)
  eq(nav.takePartnerIntent(), null); eq(nav.takeStewardIntent(), null)
  eq(nav.takeNewGoalTitle(), ''); eq(nav.takePetIntent(), null)
  nav.openPlanner('新账号需求'); eq(nav.takePartnerIntent().prompt, '新账号需求')
  app.globalData.userInfo = null
  eq(nav.openPlanner('缺少登录信息'), false)
}
async function hiddenReads() {
  const gate = defer(); let adjustmentReads = 0, delayed = false
  const c = page({ goals: async () => [{ _id: 'g1', title: '阅读' }], tasks: async () => [],
    getCoachWorkspace: () => delayed ? gate.promise : Promise.resolve({ facts: {} }),
    getAdjustmentWorkspace: async () => { adjustmentReads++; return null } }, new Map(), 'forest-steward/forest-steward')
  await c.p.onShow(); await c.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
  delayed = true
  const loading = c.p.setResultTab({ currentTarget: { dataset: { tab: 'summary' } } })
  c.p.onHide(); gate.resolve({ marker: 'late hidden response' }); await loading
  eq(c.p.data.coachSummary, null); eq(adjustmentReads, 0); eq(c.p.data.coachSummaryLoading, false)
  delayed = false; await c.p.onShow()
  eq(c.p.data.coachSummary, { facts: {} }); eq(adjustmentReads, 1)
  const tasks = defer(); let waitTasks = false
  const d = page({ goals: async () => [{ _id: 'g1', title: '阅读' }], tasks: () => waitTasks ? tasks.promise : Promise.resolve([]), getCoachWorkspace: async () => ({}) }, new Map(), 'forest-steward/forest-steward')
  await d.p.onShow(); waitTasks = true
  const choosing = d.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
  d.p.onHide(); tasks.resolve([{ _id: 'old', goal_id: 'g1', date: d.p.data.today, title: '晚到任务' }]); await choosing
  eq(d.p.data.tasks, []); eq(d.p.data.taskLoading, false)
}
async function main() {
  const part = process.argv[2]
  if (!part || part === 'navigation') await navigation()
  if (!part || part === 'hidden') await hiddenReads()
  console.log('workspace-lifecycle: ' + checks + ' assertions passed (actual navigation/Page, offline)')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
