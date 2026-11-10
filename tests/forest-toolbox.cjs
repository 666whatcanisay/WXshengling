const assert = require('node:assert/strict')
const { test } = require('node:test')
const { page } = require('./adjustment-client.cjs')
const { createClock } = require('./helpers/clock.cjs')

const tap = dataset => ({ currentTarget: { dataset } })
const input = value => ({ detail: { value } })

test('today draw uses actual active tasks and hands the selected one to the timer and original page', async () => {
  let now = Date.parse('2026-11-08T03:00:00Z')
  const clock = createClock(() => now)
  const date = clock.schedule.today()
  const goals = [{ _id: 'g1', title: '英语', status: 'active' }, { _id: 'g2', status: 'done' }]
  const tasks = [
    { id: 't1', title: '复习错题', date, goal_id: 'g1', estimated_minutes: 15 },
    { id: 't2', title: '背单词', date, goal_id: 'g1' },
    { id: 'done', title: '已完成', date, goal_id: 'g1', completed: true },
    { id: 'old', title: '昨天的', date: '2026-11-07', goal_id: 'g1' },
    { id: 'g2t', title: '结束目标', date, goal_id: 'g2' },
    { id: 'other', title: '无目标', date },
  ]
  const api = { tasks: async ({ date: requested }) => { assert.equal(requested, date); return tasks }, goals: async () => goals }
  const storage = new Map()
  const { p, wx } = page(api, storage, 'ai/ai', clock)
  wx.navigateTo = () => assert.fail('opening a timer never navigates automatically')
  await p.openTool(tap({ tool: 'todoDraw' }))
  assert.equal(p.data.todoCount, 2)
  p.drawTodo()
  const first = p.data.drawnTodo.id
  p.drawTodo()
  const selected = p.data.drawnTodo
  assert.deepEqual(new Set([first, selected.id]), new Set(['t1', 't2']))
  assert.equal(selected.goalTitle, '英语')
  p.focusFromTool(tap({ source: 'todo' }))
  assert.equal(p.data.pomodoroTask.id, selected.id)
  assert.equal(p.data.pomodoroFormattedTime, '05:00')
  p.startPomodoro()
  p.closeToolSheet()
  assert.equal(p.data.pomodoroRunning, true)
  p.onHide()
  now += 65000
  const reopened = page(api, storage, 'ai/ai', clock)
  await reopened.p.openTool(tap({ tool: 'pomodoro' }))
  assert.equal(reopened.p.data.pomodoroFormattedTime, '03:55')
  reopened.p.pausePomodoro()
  now += 30000
  reopened.p._refreshPomodoro()
  assert.equal(reopened.p.data.pomodoroFormattedTime, '03:55')
  reopened.p.startPomodoro()
  now += 235000
  reopened.p._refreshPomodoro()
  assert.equal(reopened.p.data.pomodoroStatus, '本轮专注结束')
  assert.equal(reopened.p.data.pomodoroRunning, false)
  let url
  reopened.wx.navigateTo = options => { url = options.url }
  reopened.p.openToolTask(tap({}))
  assert.equal(url, '/pages/goal-detail/goal-detail?id=g1&date=' + date + '&task=' + selected.id)
  const detail = page({ goalDetail: async () => goals[0], tasks: async () => tasks.slice(0, 2) }, new Map(), 'goal-detail/goal-detail', clock)
  detail.p.onLoad({ id: 'g1', date, task: selected.id })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detail.p.data.focusedTask, selected.id)
  assert.match(detail.p.data.taskAnchor, /^goal-task-\d+$/)
  assert.equal(detail.p.data.focusMissing, false)
  reopened.app.globalData.currentOpenid = 'other'
  reopened.p.syncToolboxOwner()
  assert.equal(reopened.p.data.pomodoroTask, null)
  assert.equal(reopened.p.data.pomodoroFormattedTime, '25:00')
})

test('task read failures keep forest inspiration available and a new owner ignores late task results', async () => {
  const errorPage = page({ goals: async () => [], tasks: async () => { throw Error('offline') } })
  await errorPage.p.openTool(tap({ tool: 'todoDraw' }))
  assert.equal(errorPage.p.data.todoStatus, 'error')
  errorPage.p.drawTodoIdea()
  assert.ok(errorPage.p.data.drawnTodo.text)
  assert.equal(errorPage.p.data.drawnTodo.id, undefined)

  let resolveTasks
  const delayed = page({ goals: async () => [], tasks: () => new Promise(resolve => { resolveTasks = resolve }) })
  const open = delayed.p.openTool(tap({ tool: 'todoDraw' }))
  delayed.app.globalData.currentOpenid = 'new'
  delayed.p.syncToolboxOwner()
  resolveTasks([])
  await open
  assert.equal(delayed.p.data.todoStatus, 'idle')
  const empty = page({ tasks: async () => [], goals: async () => [] }).p
  await empty.openTool(tap({ tool: 'todoDraw' }))
  assert.equal(empty.data.todoStatus, 'ready')
  assert.equal(empty.data.todoCount, 0)
})

test('name candidates open the existing goal form and preserve entered fields', () => {
  const ai = page({})
  const goals = page({}, new Map(), 'goals/goals')
  goals.app.isOfflineMode = true
  goals.p.showCreateForm()
  goals.p.setData({ formTitle: '还没写完的标题', formDesc: '说明', formDays: 7 })
  goals.options.modalConfirm = false
  ai.p.onGoalNameInput(input('练习吉他'))
  ai.p.generateGoalName()
  const name = ai.p.data.goalNames[1]
  assert.match(name, /练习吉他/)
  ai.p.useGoalName(tap({ name }))
  goals.p.onShow()
  assert.equal(goals.p.data.formTitle, '还没写完的标题')
  ai.p.useGoalName(tap({ name }))
  goals.options.modalConfirm = true
  goals.p.onShow()
  assert.equal(goals.p.data.formTitle, name)
  assert.equal(goals.p.data.formDesc, '说明')
  assert.equal(goals.p.data.formDays, 7)
  let confirm
  goals.options.modalHook = modal => { confirm = modal.success }
  ai.p.useGoalName(tap({ name: '旧账号候选标题' }))
  goals.p.onShow()
  goals.app.globalData.userInfo = { id: 'recreated' }
  confirm({ confirm: true })
  assert.equal(goals.p.data.formTitle, name)
})

test('capsule saves only show success on a receipt or recovered record and locked items stay closed', async () => {
  const clock = createClock(Date.parse('2026-11-08T03:00:00Z'))
  let persisted
  let reads = []
  const { p, options } = page({
    saveCapsule: async request => { persisted = { ...request, _id: 'saved' }; throw Error('response lost') },
    myCapsules: async () => reads,
  }, new Map(), 'ai/ai', clock)
  p.syncToolboxOwner()
  p.onCapsuleInput(input('未来的我'))
  await p.saveCapsule()
  assert.equal(p.data.capsuleSaved, false)
  assert.equal(p.data.capsuleUnconfirmed, true)
  assert.equal(p.data.capsuleText, '未来的我')
  assert.equal(options.toasts.some(toast => toast.icon === 'success'), false)
  reads = [persisted]
  await p.loadCapsules()
  assert.equal(p.data.capsuleSaved, true)
  assert.equal(p.data.capsuleUnconfirmed, false)
  assert.equal(p.data.capsuleText, '')
  assert.equal(p.data.myCapsules[0].can_open, false)
  options.modalHook = () => assert.fail('locked text must stay closed')
  p.openCapsule(tap({ id: 'saved' }))
})
