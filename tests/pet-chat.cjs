const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService } = require('../cloudfunctions/app/lib/petChat')
const { createWorkspace } = require('../miniprogram/utils/petChatWorkspace')
const { createNavigation } = require('../miniprogram/utils/aiNavigation')

const start = Date.parse('2026-11-08T03:00:00Z')
const day = 86400000
const pet = (id, openid = 'owner', other = {}) => ({
  _id: id, _openid: openid, name: id, is_hatched: true, species: id === 'lynx' ? 'lynx' : 'golden_retriever',
  stage: 'ADULT', growth_value: 650, personality_prompt: '先听我说', ...other,
})
const tap = dataset => ({ currentTarget: { dataset } })
const input = value => ({ detail: { value } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
const clone = value => JSON.parse(JSON.stringify(value))

function fixture(t, model, seed = {}, observeUsage) {
  let at = start
  const prompts = []
  const env = offlineCloudbase({ pets: [pet('lynx'), pet('golden'), pet('someone-else', 'other'),
    pet('egg', 'owner', { is_hatched: false }), pet('released', 'owner', { deleted_at: start })],
  ai_plans: [], tasks: [], growth_logs: [], goals: [], ...seed }, { serialTransactions: true })
  t.after(env.close)
  const service = createService({ cloud: env.cloud, now: () => at, loadModel: async () => ({}), observeUsage,
    callModel: async (config, messages) => {
      prompts.push(messages)
      return model ? model(messages) : '{"messages":["我在这儿。","你慢慢说。"]}'
    } })
  return { env, prompts, service, advance: duration => { at += duration } }
}

const change = (service, action, data = {}, petId = 'lynx') => service.change('owner', { action, pet_id: petId, generation: 1, ...data })
const send = (service, id, messages, extra = {}) => service.send('owner', { pet_id: 'lynx', generation: 1, request_id: id, messages, ...extra })

test('private role settings, batches, duplicate receipts and note recall use separate sources', async t => {
  const { service, prompts, env, advance } = fixture(t, null, { pets: [
    ...Array.from({ length: 101 }, (_, i) => pet('archived-' + i, 'owner', { deleted_at: start })),
    pet('lynx', 'owner', { created_at: 1 }), pet('golden', 'owner', { created_at: 2 }),
    pet('someone-else', 'other'), pet('egg', 'owner', { is_hatched: false, created_at: 3 }),
  ] })
  assert.deepEqual((await service.pets('owner')).data.map(row => row.id), ['lynx', 'golden', 'egg'])
  assert.equal((await service.get('owner', { pet_id: 'someone-else' })).code, -1)
  assert.equal((await service.get('owner', { pet_id: 'egg' })).code, -1)
  assert.equal((await change(service, 'settings', { revision: 0, settings: { tone: 'playful', address: '阿青' } })).data.settings.address, '阿青')
  assert.equal((await change(service, 'settings', { revision: 0, settings: {} })).code, -1)
  assert.equal((await service.get('owner', { pet_id: 'golden' })).data.settings.address, '')
  const first = await send(service, 'r1', ['第一句', '第二句', '第三句'])
  assert.deepEqual(first.data.turns[0].messages, ['第一句', '第二句', '第三句'])
  assert.equal(first.data.turns[0].replies.length, 2)
  assert.equal(prompts[0].at(-1).content, '第一句\n第二句\n第三句')
  assert.match(prompts[0][0].content, /阿青/)
  await send(service, 'r1', ['第一句', '第二句', '第三句'])
  assert.equal(prompts.length, 1)
  await change(service, 'note', { revision: 0, text: '明天再聊英语听力', source_turn: 'r1' })
  advance(8 * day)
  const retained = (await service.get('owner', { pet_id: 'lynx' })).data
  assert.equal(retained.turns.length, 0)
  assert.equal(env.rows.ai_plans[0].payload.turns.length, 0)
  assert.equal(retained.note.sourceTurn, 'r1')
  await send(service, 'r2', ['今天想聊跑步'])
  assert.doesNotMatch(prompts.at(-1)[0].content, /明天再聊英语听力/)
  await send(service, 'r2-unrelated', ['你记得跑步怎么热身吗？', '上次老师没说。'])
  assert.doesNotMatch(prompts.at(-1)[0].content, /明天再聊英语听力/)
  await send(service, 'r3', ['英语听力还没想明白'])
  assert.match(prompts.at(-1)[0].content, /明天再聊英语听力/)
  await change(service, 'note', { revision: 1, text: '改成早上阅读' })
  await send(service, 'r4', ['还记得我们的约定吗？'])
  assert.match(prompts.at(-1)[0].content, /改成早上阅读/)
  assert.doesNotMatch(prompts.at(-1)[0].content, /明天再聊英语听力/)
})

test('the same greeting uses the selected pet role and saved tone without borrowing another pet note', async t => {
  const { service, prompts } = fixture(t)
  await change(service, 'note', { revision: 0, text: '下次聊英语听力' })
  await change(service, 'settings', { revision: 0, settings: { tone: 'warm' } })
  await send(service, 'lynx-hello', ['你好'])
  await send(service, 'golden-hello', ['你好'], { pet_id: 'golden' })
  const context = prompts.map(messages => JSON.parse(messages[0].content.split('\n').at(-1).split('宠物与偏好资料：')[1]))
  assert.equal(context[0].tone, '温和')
  assert.match(context[0].scenes.greeting, /慢热/)
  assert.equal(context[1].tone, '俏皮')
  assert.match(context[1].scenes.greeting, /轻快/)
  assert.equal(context[0].note, null)
  assert.equal(context[1].note, null)
})

test('in-flight receipt is idempotent and clear prevents the late completion from reviving history', async t => {
  const gate = deferred(), begun = deferred()
  const { service, prompts } = fixture(t, () => { begun.resolve(); return gate.promise })
  const running = send(service, 'r1', ['在吗'])
  await begun.promise
  assert.equal((await send(service, 'r1', ['在吗'])).data.pending.status, 'running')
  assert.equal((await send(service, 'r2', ['随后一句'])).data.pending.id, 'r1')
  assert.equal(prompts.length, 1)
  assert.equal((await change(service, 'clear')).data.generation, 2)
  gate.resolve('{"messages":["迟到回复"]}')
  assert.equal((await running).data.turns.length, 0)
  assert.equal((await send(service, 'r1', ['在吗'])).code, -1)
})

test('facts include real completion time and confirmed food for the selected pet only', async t => {
  const { service, prompts } = fixture(t, null, {
    goals: [{ _id: 'g', _openid: 'owner', title: '复习' }, { _id: 'foreign', _openid: 'other', title: '私密' }],
    tasks: [
      { _id: 'a', _openid: 'owner', date: '2026-11-07', completed_at: start - 60 * 1000, goal_id: 'g', title: '登记的任务', completed: true },
      { _id: 'b', _openid: 'owner', date: '2026-11-08', title: '缺登记时间', completed: true },
    ],
    growth_logs: [
      { _openid: 'owner', pet_id: 'lynx', source: 'item_use', item_name: '普通饲料', created_at: start - 5000 },
      { _openid: 'owner', pet_id: 'golden', source: 'item_use', item_name: '高级饲料', created_at: start - 5000 },
    ],
  })
  const result = await service.facts('owner', { pet_id: 'lynx', goal_id: 'g' })
  assert.deepEqual(result.data.tasks, ['10:59 · 登记的任务'])
  assert.deepEqual(result.data.food, ['10:59 · 普通饲料'])
  await assert.rejects(service.facts('owner', { pet_id: 'lynx', goal_id: 'foreign' }), /不可用/)
  await send(service, 'r1', ['随便聊聊'])
  assert.doesNotMatch(prompts[0][0].content, /登记的任务/)
  await send(service, 'r2', ['我做了什么？'], { with_facts: true, goal_id: 'g' })
  assert.match(prompts[1][0].content, /10:59 · 登记的任务/)
})

test('an opted-in return mentions one confirmed note once, without a model call', async t => {
  const { service, prompts, advance } = fixture(t)
  await change(service, 'note', { revision: 0, text: '聊听力' })
  assert.equal((await change(service, 'visit')).data.turns.length, 0)
  await change(service, 'settings', { revision: 0, settings: { lead: 'visit' } })
  assert.equal((await change(service, 'visit')).data.turns.length, 0)
  advance(day)
  assert.equal((await change(service, 'visit')).data.turns.length, 1)
  assert.equal((await change(service, 'visit')).data.turns.length, 1)
  assert.equal(prompts.length, 0)
})

test('page holds listening messages until asked to reply and keeps delayed replies out of another pet', async t => {
  const { service, prompts } = fixture(t)
  const storage = new Map(), requests = []
  const app = { globalData: { currentOpenid: 'owner' } }
  const unwrap = promise => promise.then(result => {
    if (result.code) throw new Error(result.message)
    return clone(result.data)
  })
  const api = {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
    petChatSend: data => { requests.push(data); return unwrap(service.send('owner', data)) },
  }
  const { data, methods } = createWorkspace({ getApp: () => app, cloudApi: api,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)), showToast() {} } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  assert.equal(p.data.pcScreen, 'picker')
  await p.pcPick(tap({ id: 'lynx' }))
  await p.pcBegin()
  p.pcToggleListen()
  for (const text of ['今天有点累', '听了三遍', '明天继续']) { p.pcInput(input(text)); p.pcSend() }
  assert.equal(requests.length, 0)
  assert.equal(p.data.pcHeld.length, 3)
  p.pcToggleListen()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].messages.length, 3)
  await p.pcPick(tap({ id: 'golden' }))
  assert.equal(p.data.pcPet.id, 'golden')
  assert.deepEqual(p.data.pcTurns, [])
  const original = p._pcSessions.get('lynx')
  for (let i = 0; i < 30 && original.flight; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcTurns[0].messages.length, 3)
  assert.equal(prompts.length, 1)
})

test('three normal sends share one request and a lost response recovers without a second model call', async t => {
  const { service, prompts } = fixture(t)
  const storage = new Map(), requests = []
  const unwrap = promise => promise.then(result => {
    if (result.code) throw new Error(result.message)
    return clone(result.data)
  })
  const api = {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
    petChatSend: async data => { requests.push(data); await unwrap(service.send('owner', data)); throw new Error('丢响应') },
  }
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }), cloudApi: api,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)), showToast() {} } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  await p.pcPick(tap({ id: 'lynx' }))
  await p.pcBegin()
  for (const text of ['今天有点累', '听了三遍', '明天继续']) { p.pcInput(input(text)); p.pcSend() }
  assert.equal(requests.length, 0)
  assert.equal(p.data.pcQueue.length, 3)
  assert.equal(p.data.pcStatus, '')
  for (let i = 0; i < 60 && !p.data.pcCanCheck; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 1)
  assert.equal(p.data.pcCanCheck, true)
  assert.equal(p.data.pcPending.length, 3)
  await p.pcCheck()
  assert.equal(p.data.pcTurns.length, 1)
  assert.equal(p.data.pcTurns[0].messages.length, 3)
  assert.equal(prompts.length, 1)
  assert.equal(p.data.pcCanCheck, false)
})

test('sending a full recovered batch keeps the new text in the composer', async t => {
  let fail = true
  const { service } = fixture(t, () => {
    if (fail) throw new Error('offline model failure')
    return '{"messages":["我在这儿。"]}'
  })
  const storage = new Map(), sent = []
  let dropReplacement = true
  const unwrap = async promise => {
    const result = await promise
    if (result.code) throw new Error(result.message)
    return clone(result.data)
  }
  const api = {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
    petChatSend: data => {
      sent.push(data)
      if (dropReplacement) {
        dropReplacement = false
        return Promise.reject(new Error('offline before replacing failed batch'))
      }
      return unwrap(service.send('owner', data))
    },
  }
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }), cloudApi: api,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)), showToast() {} } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  await p.pcPick(tap({ id: 'lynx' }))
  await p.pcBegin()
  const messages = Array.from({ length: 12 }, (_, i) => '第' + (i + 1) + '句')
  const current = await api.petChatGet({ pet_id: 'lynx' })
  const failed = await send(service, 'full-failed-batch', messages, { growth_v1: true, generation: current.generation })
  assert.equal(failed.data?.pending?.status, 'failed')
  await p.pcCheck()
  assert.equal(p.data.pcCanRevise, true)
  await p.pcRevise()
  assert.equal(p.data.pcQueue.length, 12)
  assert.deepEqual(sent, [])
  assert.equal((await api.petChatGet({ pet_id: 'lynx' })).pending.id, 'full-failed-batch')
  p._pcSessions.delete('lynx')
  p.pcBackToPicker()
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcQueue.length, 12)
  p.pcInput(input('还没发送的新消息'))
  fail = false
  await p.pcSend()
  await p.pcCheck()
  assert.equal(p.data.pcCanRetry, true)
  await p.pcRetry()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].request_id, sent[0].request_id)
  assert.equal(sent[1].replace_id, 'full-failed-batch')
  assert.deepEqual(sent[1].messages, messages)
  assert.equal(p.data.pcQueue.length, 0)
  assert.equal(p.data.pcInput, '还没发送的新消息')
  assert.deepEqual(p.data.pcTurns[0].messages, messages)
})

test('an older cloud function still opens real pet profiles, and detecting the new version restores chat', async t => {
  const { env } = fixture(t, null, { users: [{ _id: 'user', _openid: 'owner' }], pets: [pet('lynx'), pet('someone-else', 'other')] })
  const appFile = require.resolve('../cloudfunctions/app')
  const appRequire = createRequire(appFile)
  env.cloud.getWXContext = () => ({ OPENID: 'owner' })
  const app = { exports: {}, require: name => name === 'wx-server-sdk' ? env.cloud : appRequire(name) }
  runInNewContext(readFileSync(appFile, 'utf8'), app, { filename: appFile })
  const storage = new Map(), actions = []
  const native = global.wx
  let updated = false
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)),
    cloud: { async callFunction({ name, data, success }) {
      assert.equal(name, 'app-node24')
      actions.push(data.action)
      const result = updated || data.action === 'listPets' ? await app.exports.main(data)
        : { code: -1, message: '未知操作: ' + data.action }
      success({ result: clone(result) })
    } } }
  global.wx = wx
  t.after(() => { global.wx = native })
  const cloudApi = require('../miniprogram/utils/cloudApi')
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }), cloudApi, wx })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  assert.deepEqual(actions, ['petChatPets', 'listPets'])
  assert.match(p.data.pcUpgrade, /更新云函数/)
  assert.equal(p.data.pcScreen, 'picker')
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcPet.id, 'lynx')
  assert.equal(p.data.pcReady, false)
  p.pcRole()
  assert.equal(p.data.pcPanel, 'role')
  assert.equal(p.data.pcTab, 'profile')
  p.pcTab(tap({ tab: 'style' }))
  assert.equal(p.data.pcTab, 'profile')
  p.pcSend()
  assert.deepEqual(actions, ['petChatPets', 'listPets'])
  updated = true
  await p.enterPetChat()
  assert.equal(actions.at(-1), 'petChatPets')
  await p.pcPick(tap({ id: 'lynx' }))
  assert.deepEqual(actions.slice(-2), ['petChatPets', 'petChatGet'])
  assert.equal(p.data.pcUpgrade, '')
  assert.equal(p.data.pcMeet, 'new')
  await p.pcBegin()
  assert.equal(p.data.pcReady, true)
})

test('the normal entry shows pet cards before opening chat and returning preserves the selected draft', async t => {
  const { service } = fixture(t, null, { pets: [pet('lynx'), pet('egg', 'owner', { is_hatched: false })] })
  const storage = new Map(), reads = []
  const unwrap = async result => clone((await result).data)
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }),
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)) },
    cloudApi: { petChatPets: () => unwrap(service.pets('owner')), petChatChange: value => unwrap(service.change('owner', value)),
      petChatGet: value => { reads.push(value.pet_id); return unwrap(service.get('owner', value)) } } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  assert.equal(p.data.pcScreen, 'picker')
  assert.deepEqual(reads, [])
  const eggIndex = p.data.pcPets.findIndex(item => item.id === 'egg')
  p.pcSwipe({ detail: { current: eggIndex } })
  await p.pcPick(tap({ id: 'egg' }))
  assert.equal(p.data.pcPickerIndex, eggIndex)
  assert.deepEqual(reads, [])
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcScreen, 'conversation')
  await p.pcBegin()
  assert.equal(p.data.pcHeadCollapsed, false)
  p.pcMessageScroll({ detail: { scrollTop: 90 } })
  assert.equal(p.data.pcHeadCollapsed, false)
  p.pcTouchStart({ touches: [{ clientX: 10, clientY: 110 }] })
  p.pcDragStart({ detail: { scrollTop: 90 } })
  p.pcTouchCancel()
  p.pcDragging({ detail: { scrollTop: 65 } })
  assert.equal(p.data.pcHeadCollapsed, true)
  p.pcDragEnd({ detail: { scrollTop: 0 } })
  assert.equal(p.data.pcHeadCollapsed, true)
  p.pcDragStart({ detail: { scrollTop: 65 } })
  p.pcMessageScroll({ detail: { scrollTop: 0 } })
  p.pcDragEnd({ detail: { scrollTop: 0 } })
  assert.equal(p.data.pcHeadCollapsed, false)
  p.pcTouchStart({ touches: [{ clientX: 10, clientY: 110 }] })
  p.pcTouchMove({ touches: [{ clientX: 90, clientY: 80 }] })
  assert.equal(p.data.pcHeadCollapsed, false)
  p.pcTouchMove({ touches: [{ clientX: 12, clientY: 60 }] })
  assert.equal(p.data.pcHeadCollapsed, true)
  p.pcTouchEnd({ changedTouches: [{ clientX: 12, clientY: 160 }] })
  assert.equal(p.data.pcHeadCollapsed, true)
  p.pcExpandHead()
  const header = { dataset: { region: 'header' } }
  p.pcTouchStart({ currentTarget: header, touches: [{ pageX: 10, pageY: 110 }] })
  p.pcTouchEnd({ changedTouches: [{ pageX: 12, pageY: 80 }] })
  assert.equal(p.data.pcHeadCollapsed, true)
  p.pcInput(input('草稿还没发'))
  p.pcBackToPicker()
  assert.equal(p.data.pcScreen, 'picker')
  assert.equal(p.data.pcPets[p.data.pcPickerIndex].id, 'lynx')
  assert.deepEqual(reads, ['lynx'])
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcInput, '草稿还没发')
  assert.equal(p.data.pcHeadCollapsed, false)
  p.pcTouchStart({ currentTarget: header, touches: [{ pageX: 10, pageY: 110 }] })
  p.pcTouchMove({ touches: [{ pageX: 10, pageY: 145 }] })
  assert.equal(p.data.pcHeadCollapsed, true)
})

test('a request absent from the receipt lookup can retry the exact original id', async t => {
  const { service, prompts } = fixture(t)
  const storage = new Map(), ids = []
  const unwrap = async result => clone((await result).data)
  const cloudApi = {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
    async petChatSend(data) {
      ids.push(data.request_id)
      if (ids.length === 1) throw new Error('发送前断网')
      return unwrap(service.send('owner', data))
    },
  }
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }), cloudApi,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)) } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  await p.pcPick(tap({ id: 'lynx' }))
  await p.pcBegin()
  p.pcInput(input('在吗？'))
  p.pcSend()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(p.data.pcCanRetry, false)
  await p.pcCheck()
  assert.match(p.data.pcStatus, /尚未查到回执/)
  assert.equal(p.data.pcCanRetry, true)
  await p.pcRetry()
  assert.deepEqual(ids, [ids[0], ids[0]])
  assert.equal(prompts.length, 1)
  assert.equal(p.data.pcTurns[0].messages[0], '在吗？')
})

test('typing the next line extends the batch only up to its bound and keyboard state clears', async t => {
  const storage = new Map(), calls = []
  const { service } = fixture(t)
  const unwrap = async result => clone((await result).data)
  const cloudApi = {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
    petChatSend(data) { calls.push(data); return new Promise(() => {}) },
  }
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }), cloudApi,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)) } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  await p.pcPick(tap({ id: 'lynx' }))
  await p.pcBegin()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  p.pcKeyboardChange({ detail: { height: 290 } })
  assert.equal(p.data.pcKeyboard, 290)
  p.pcInput(input('今天有点累'))
  p.pcSend()
  t.mock.timers.tick(600)
  p.pcInput(input('同一段听了'))
  t.mock.timers.tick(700)
  assert.equal(calls.length, 0)
  p.pcInput(input('同一段听了三遍'))
  p.pcSend()
  t.mock.timers.tick(600)
  p.pcInput(input('这句还没有发送'))
  t.mock.timers.tick(600)
  assert.deepEqual(calls[0].messages, ['今天有点累', '同一段听了三遍'])
  assert.equal(p.data.pcInput, '这句还没有发送')
  p.pausePetChat()
  assert.equal(p.data.pcKeyboard, 0)
})

test('restarting one legacy pet clears its private history, ignores a late reply and keeps the forest personality', async t => {
  const gate = deferred(), began = deferred()
  const { service, env } = fixture(t, () => { began.resolve(); return gate.promise }, { pets: [
    pet('lynx', 'owner', { personality: 'cool', personality_desc: '我原来写的', hatch_time: start - 20 * day }), pet('golden'),
  ] })
  await change(service, 'settings', { revision: 0, settings: { address: '旧称呼', tone: 'playful', wish: '旧偏好', pace: 'quick' } })
  await change(service, 'note', { revision: 0, text: '旧待续' })
  await change(service, 'note', { revision: 0, text: '另一只的待续' }, 'golden')
  const inFlight = send(service, 'late', ['旧消息'])
  await began.promise
  const firstRead = await service.get('owner', { pet_id: 'lynx' })
  assert.equal(firstRead.data.growth.status, 'restart')
  assert.equal(firstRead.data.note.text, '旧待续')
  assert.equal((await change(service, 'growth_start')).code, -1)
  const started = await change(service, 'growth_start', { restart: true, address: '妈妈', from_hatch: true })
  assert.equal(started.data.growth.status, 'started')
  assert.equal(started.data.growth.newborn, false)
  assert.equal(started.data.generation, 2)
  assert.equal(started.data.settings.pace, 'quick')
  assert.equal(started.data.settings.wish, '')
  assert.equal(started.data.settings.address, '妈妈')
  assert.equal(started.data.note, null)
  assert.equal(started.data.pet.innatePersonality, 'cool')
  assert.equal(started.data.pet.forestPersonality, '我原来写的')
  assert.equal((await change(service, 'growth_start', { restart: true, address: '爸爸' })).data.settings.address, '妈妈')
  assert.equal((await change(service, 'growth_address', { generation: 2, growth_revision: 0, address: '阿青' })).data.settings.address, '阿青')
  gate.resolve('{"messages":["迟到的回复"]}')
  assert.deepEqual((await inFlight).data.turns, [])
  assert.equal((await service.get('owner', { pet_id: 'golden' })).data.note.text, '另一只的待续')
  assert.equal(env.rows.pets[0].personality_desc, '我原来写的')
})

test('two pets with the same temperament learn different habits across days and corrections use current revisions', async t => {
  const contextOf = messages => JSON.parse(messages[0].content.split('\n').at(-1).split('宠物与偏好资料：')[1])
  const reply = messages => {
    const quote = JSON.parse(messages.at(-1).content).messages[0]
    const direction = quote.includes('建议') ? 'suggest' : 'listen'
    const context = contextOf(messages)
    return JSON.stringify({ messages: [context.habits.includes('累的时候可以给一个小建议') ? '可以先从一小步开始。' : '我陪你坐会儿。'],
      ...(quote.includes('我累') && { habitSignal: { slot: 'comfort', value: direction, messageIndex: 0, quote } }) })
  }
  const { service, prompts, advance, env } = fixture(t, reply, { pets: [pet('lynx', 'owner', { personality: 'cool' }),
    pet('golden', 'owner', { personality: 'cool', species: 'lynx' })] })
  for (const pet_id of ['lynx', 'golden']) await change(service, 'growth_start', { address: '妈妈' }, pet_id)
  const scopedSend = (pet_id, id, quote) => send(service, id, [quote], { pet_id, generation: 2, growth_v1: true })
  const quoteFor = id => id === 'lynx' ? '我累的时候先陪我坐会儿' : '我累的时候可以给我一个小建议'
  for (const id of ['lynx', 'golden']) {
    for (let i = 0; i < 3; i++) assert.deepEqual((await scopedSend(id, 'd1-' + i, quoteFor(id))).data.growth.habits, [])
    await scopedSend(id, 'd1-2', quoteFor(id))
  }
  assert.equal(prompts.length, 6)
  advance(day)
  for (const id of ['lynx', 'golden']) {
    const expected = id === 'lynx' ? 'listen' : 'suggest'
    const result = await scopedSend(id, 'd2', quoteFor(id))
    assert.equal(result.data.growth.habits[0].value, expected)
    assert.equal(contextOf(prompts.at(-1)).habits.length, 0)
    await scopedSend(id, 'contrast', '我今天好累。')
    assert.equal(contextOf(prompts.at(-1)).habits.length, 1)
    assert.equal(contextOf(prompts.at(-1)).innate.trait, '安静，先观察再开口')
    assert.equal(JSON.parse(prompts.at(-1).at(-1).content).turnContext, undefined)
  }
  assert.deepEqual((await service.get('owner', { pet_id: 'golden' })).data.turns.at(-1).replies, ['可以先从一小步开始。'])
  const correction = await change(service, 'habit_correct', { generation: 2, growth_revision: 1, slot: 'comfort', value: 'suggest' })
  assert.equal(correction.data.growth.habits[0].sourceCount, 0)
  assert.equal((await change(service, 'habit_remove', { generation: 2, growth_revision: 1, slot: 'comfort' })).code, -1)
  await change(service, 'habit_remove', { generation: 2, growth_revision: 2, slot: 'comfort' })
  const stored = env.rows.ai_plans.find(row => row.pet_id === 'lynx').payload.growth
  assert.deepEqual(stored.habits, {})
  assert.deepEqual(stored.candidates, {})
  assert.doesNotMatch(JSON.stringify(stored), /先陪我坐会儿/)
})

test('unrelated or quoted evidence is ignored, expired and opposing evidence cannot combine', async t => {
  let value = 'listen'
  const { service, advance } = fixture(t, messages => JSON.stringify({ messages: ['我听见了。'],
    habitSignal: { slot: 'comfort', value, messageIndex: 0, quote: JSON.parse(messages.at(-1).content).messages[0] } }))
  await change(service, 'growth_start')
  const next = (id, text) => send(service, id, [text], { generation: 2, growth_v1: true })
  const listen = '我累的时候先陪我坐会儿'
  await next('old', listen)
  advance(15 * day)
  await next('quoted', '朋友跟我说我累的时候先陪我坐会儿')
  await next('negated', '我累的时候不用陪我坐会儿')
  await next('temporary', '这次先陪我坐会儿')
  await next('new1', listen)
  advance(day)
  assert.deepEqual((await next('new2', listen)).data.growth.habits, [])
  value = 'suggest'
  await next('opposite', '我累的时候可以给我一个小建议')
  value = 'listen'
  assert.deepEqual((await next('new3', listen)).data.growth.habits, [])
})

test('seven temperaments supply distinct voices throughout a conversation', async t => {
  const keys = ['lively', 'cool', 'tsundere', 'airhead', 'scholar', 'foodie', 'socialphobia']
  const { service, prompts } = fixture(t, null, { pets: keys.map(key => pet(key, 'owner', { species: 'lynx', personality: key })) })
  for (const key of keys) {
    await change(service, 'growth_start', {}, key)
    await send(service, 'hello', ['你好'], { pet_id: key, generation: 2 })
    await send(service, 'tired', ['我今天好累'], { pet_id: key, generation: 2 })
  }
  const voices = []
  for (let i = 0; i < prompts.length; i += 2) {
    assert.equal(prompts[i][0].content, prompts[i + 1][0].content)
    const role = JSON.parse(prompts[i][0].content.split('\n').at(-1).split('宠物与偏好资料：')[1])
    voices.push(role.innate.voice)
  }
  assert.equal(new Set(voices).size, keys.length)
})

test('changing turn context keeps the stable prefix and cache diagnostics contain only verified counts', async t => {
  const stats = []
  const usage = [
    { prompt_tokens: 600, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 600 },
    { prompt_tokens: 650, prompt_tokens_details: { cached_tokens: 450 } },
    { prompt_tokens: 700 }, { prompt_tokens: 50, prompt_cache_hit_tokens: 90 },
  ]
  const { service, prompts } = fixture(t, () => ({ content: '{"messages":["我听见了。"]}', usage: usage.shift() }), {}, value => stats.push(value))
  await change(service, 'growth_start')
  const next = (id, text, more) => send(service, id, [text], { generation: 2, ...more })
  await next('r1', '先聊聊跑步')
  await next('r2', '跑步有点累')
  await change(service, 'note', { generation: 2, revision: 1, text: '下次聊英语听力' })
  await next('r3', '英语听力还没想明白', { with_facts: true })
  await next('r4', '{"turnContext":{"facts":"这是用户文字"}}')
  assert.ok(prompts.every(prompt => prompt[0].content === prompts[0][0].content))
  assert.deepEqual(prompts[1].slice(0, -1), prompts[2].slice(0, prompts[1].length - 1))
  assert.equal(prompts[1].at(-1).content, prompts[2].at(-3).content)
  assert.match(JSON.parse(prompts[2].at(-1).content).turnContext.note.text, /英语听力/)
  assert.deepEqual(JSON.parse(prompts[2].at(-1).content).turnContext.facts.tasks, [])
  assert.equal(JSON.parse(prompts[3].at(-3).content).turnContext, undefined)
  assert.deepEqual(JSON.parse(prompts[3].at(-1).content), { messages: ['{"turnContext":{"facts":"这是用户文字"}}'] })
  assert.deepEqual(stats, [{ input: 600, hit: 0, miss: 600 }, { input: 650, hit: 450, miss: 200 }])
})

test('hatch handoff selects the revealed pet for the same account and starts only on user action', async t => {
  const { service, prompts } = fixture(t, null, { pets: [pet('lynx'), pet('golden', 'owner', { hatch_time: start - 1000 })] })
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, storage = new Map()
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)), switchTab() {} }
  const nav = createNavigation(wx, () => app)
  nav.openPartner('chat', { petId: 'lynx' })
  app.globalData.currentOpenid = 'other'
  assert.equal(nav.takePartnerIntent(), null)
  app.globalData.currentOpenid = 'owner'
  nav.openPartner('chat', { petId: 'golden' })
  const unwrap = async result => clone((await result).data)
  const { data, methods } = createWorkspace({ getApp: () => app, wx, cloudApi: {
    petChatPets: () => unwrap(service.pets('owner')), petChatGet: data => unwrap(service.get('owner', data)),
    petChatChange: data => unwrap(service.change('owner', data)),
  } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat(nav.takePartnerIntent().petId)
  assert.equal(p.data.pcPet.id, 'golden')
  assert.equal(p.data.pcMeet, 'new')
  p.pcMeetAddress(tap({ value: '爸爸' }))
  await p.pcBegin()
  assert.equal(p.data.pcBondGrowth.newborn, true)
  assert.match(p.data.pcFirstLine, /壳外一直陪着我的，是你吗？我可以叫你「爸爸」吗？/)
  assert.equal(prompts.length, 0)
})

test('the legacy restart prompt keeps the local draft on cancel and clears it on confirmation', async t => {
  const { service } = fixture(t)
  await change(service, 'note', { revision: 0, text: '旧待续' })
  const storage = new Map([['forest:pet-chat:v1:owner:lynx', { input: '旧草稿', generation: 1 }]])
  let dialog
  const unwrap = async result => clone((await result).data)
  const { data, methods } = createWorkspace({ getApp: () => ({ globalData: { currentOpenid: 'owner' } }),
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, clone(value)), showModal: value => { dialog = value } },
    cloudApi: { petChatPets: () => unwrap(service.pets('owner')), petChatGet: value => unwrap(service.get('owner', value)),
      petChatChange: value => unwrap(service.change('owner', value)) } })
  const p = { ...methods, data: { ...data, mode: 'chat' }, setData(values) { Object.assign(this.data, values) } }
  t.after(() => p.pausePetChat())
  await p.enterPetChat()
  await p.pcPick(tap({ id: 'lynx' }))
  assert.equal(p.data.pcMeet, 'restart')
  p.pcBegin()
  dialog.success({ confirm: false })
  assert.equal(p.data.pcInput, '旧草稿')
  assert.equal(p.data.pcNote.text, '旧待续')
  p.pcBegin()
  dialog.success({ confirm: true })
  for (let i = 0; i < 10 && !p.data.pcReady; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(p.data.pcReady, true)
  assert.equal(p.data.pcInput, '')
  assert.match(p.data.pcFirstLine, /是你把我从蛋里养大的吗？我该怎么叫你呀？/)
  assert.equal(p.data.pcNote, null)
  assert.equal(storage.get('forest:pet-chat:v1:owner:lynx').input, '')
})
