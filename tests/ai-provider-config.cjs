const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const root = path.resolve(__dirname, '..'), backendFile = path.join(root, 'cloudfunctions/app/index.js'), backendRequire = createRequire(backendFile)
const models = require('../miniprogram/utils/aiModelConfig')
let checks = 0
const eq = (actual, expected) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); checks++ }
const qKey = 'synthetic-qwen-secret-1234', dKey = 'synthetic-deepseek-secret-9876'
function page(relative, api, storage = new Map()) {
  const file = path.join(root, relative), localRequire = createRequire(file), app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, toast = []
  const wx = { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, structuredClone(v)), showToast: v => toast.push(v), showModal() {}, hideLoading() {}, showLoading() {} }
  let instance
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : localRequire(n), Page: d => { instance = d }, wx, getApp: () => app,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  instance.data = structuredClone(instance.data)
  instance.setData = function(patch) { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let target = this.data; for (const p of parts.slice(0, -1)) target = target[p]; target[parts.at(-1)] = value } }
  return { instance, app, storage, toast, wx }
}
async function main() {
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner' }], api_keys: [
    { _id: 'q', _openid: 'owner', provider: 'qwen', api_key: qKey, updated_at: 100, model: 'qwen-plus' },
    { _id: 'd', _openid: 'owner', provider: 'deepseek', api_key: dKey, updated_at: 200, model: 'deepseek-flash' },
    { _id: 'other', _openid: 'other', provider: 'deepseek', api_key: 'other-synthetic-secret', updated_at: 1000 }
  ], ai_plans: [] })
  const logs = [], requests = []
  let responseStatus = 200, responseBody = JSON.stringify({ choices: [{ message: { content: '你好' } }] })
  const https = { request(options, callback) {
    const req = new EventEmitter(); req.write = body => requests.push({ options, body: JSON.parse(body) }); req.destroy = () => {}
    req.end = () => { const response = new EventEmitter(); response.statusCode = responseStatus; callback(response); response.emit('data', responseBody); response.emit('end') }
    return req
  } }
  const context = vm.createContext({ require: n => n === 'wx-server-sdk' ? env.cloud : n === 'https' ? https : backendRequire(n), exports: {}, URL, Buffer, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(backendFile, 'utf8'), context)
  const run = (name, ...args) => context[name](...args)
  try {
    const list = await run('listApiKeys', 'owner')
    eq(list.data.length, 2); eq(list.data[0].provider, 'deepseek')
    eq('api_key' in list.data[0], false); eq(list.data[0].api_key_masked, '****9876')
    eq(JSON.stringify(list).includes(dKey), false)
    eq((await run('getUserApiConfig', 'owner', 'deepseek')).base_url, 'https://api.deepseek.com')
    eq(await run('getUserApiConfig', 'owner', 'openai'), null) // never fall back to Qwen
    eq((await run('getUserApiConfig', 'owner')).provider, 'deepseek')
    const connected = await run('aiTestConnection', 'owner', { provider: 'deepseek' })
    eq(connected.code, 0); eq(requests.at(-1).options.hostname, 'api.deepseek.com')
    eq(requests.at(-1).body.model, 'deepseek-flash'); eq(requests.at(-1).body.thinking, { type: 'disabled' })
    const count = requests.length
    const wrongOrigin = await run('aiTestConnection', 'owner', { provider: 'deepseek', baseUrl: 'https://example.invalid/v1' })
    eq(wrongOrigin.code, -1); eq(wrongOrigin.message.includes('重新填写'), true)
    eq((await run('saveApiKey', 'owner', { provider: 'deepseek', base_url: 'https://example.invalid/v1' })).code, -1)
    eq((await run('aiTestConnection', 'owner', { provider: 'openai' })).code, -1)
    eq(requests.length, count)
    await run('saveApiKey', 'owner', { provider: 'deepseek', api_key: '', base_url: 'https://api.deepseek.com/v1', model: 'my-saved-model' })
    eq(env.rows.api_keys.find(k => k._id === 'd').api_key, dKey)
    eq((await run('saveApiKey', 'owner', { provider: 'deepseek', api_key: '****9876' })).code, -1)
    eq((await run('saveApiKey', 'owner', { provider: '__proto__', clear: true })).code, -1)
    await run('saveApiKey', 'owner', { provider: 'qwen', api_key: 'synthetic-new-qwen-secret', model: 'qwen-plus' })
    eq((await run('listApiKeys', 'owner')).data[0].provider, 'qwen')
    eq(JSON.stringify(logs).includes(qKey), false); eq(JSON.stringify(logs).includes(dKey), false)

    const configApi = { myApiKeys: async () => (await run('listApiKeys', 'owner')).data, saveApiKey: data => run('saveApiKey', 'owner', data), aiTestConnection: data => run('aiTestConnection', 'owner', data) }
    const config = page('miniprogram/pages/ai-config/ai-config.js', configApi)
    await config.instance.onShow()
    eq(config.instance.data.provider, 'qwen')
    config.instance.selectProvider({ currentTarget: { dataset: { provider: 'deepseek' } } })
    eq(config.instance.data.hasExistingKey, true)
    eq(config.instance.data.model, 'my-saved-model')
    config.instance.onModel({ detail: { value: 'deepseek-flash' } })
    await config.instance.saveConfig()
    eq(config.instance.data.provider, 'deepseek'); eq(config.instance.data.activeProviderName, 'DeepSeek')
    eq(config.instance.data.apiKey, '')
    eq(JSON.stringify(config.instance.data).includes(dKey), false)
    eq(JSON.stringify([...config.storage]).includes(dKey), false)
    const reentered = page('miniprogram/pages/ai-config/ai-config.js', configApi, config.storage)
    await reentered.instance.onShow()
    eq(reentered.instance.data.provider, 'deepseek')
    await reentered.instance.testConnection()
    eq(reentered.instance.data.testResult.success, true)
    eq(requests.at(-1).options.hostname, 'api.deepseek.com')
    responseStatus = 403; responseBody = JSON.stringify({ error: { message: 'Free quota exhausted. ' + dKey } })
    await reentered.instance.testConnection()
    eq(reentered.instance.data.testResult.success, false)
    eq(reentered.instance.data.testResult.message.includes('免费额度已用尽'), true)
    eq(JSON.stringify(reentered.instance.data).includes(dKey), false)
    eq(JSON.stringify(logs).includes(dKey), false)
    responseStatus = 200; responseBody = JSON.stringify({ choices: [{ message: { content: '模型回复' } }] })
    const plannerCalls = []
    const plannerApi = { ...configApi, aiPlannerChat: async data => { plannerCalls.push(data); return { reply: '模型回复' } } }
    const planner = page('miniprogram/pages/ai/ai.js', plannerApi, config.storage)
    eq(await planner.instance._checkApiKey(), true)
    planner.instance._appendReply = () => {}; planner.instance._extractFromAIReply = () => {}
    planner.instance.setData({ planMessages: [{ role: 'user', content: '我想游泳' }] })
    await planner.instance._callAIPlanner('我想游泳')
    eq(plannerCalls[0].provider, 'deepseek')
    eq(JSON.stringify(plannerCalls).includes(dKey), false)
    plannerApi.aiStartGenerate = async data => { plannerCalls.push(data); return { plan_id: 'frontend-plan' } }
    plannerApi.aiDoGenerate = async data => { plannerCalls.push(data); return { goal: { title: '游泳计划', period_days: 7 }, tasks: [{ title: '练习', xp_reward: 10, estimated_minutes: 15 }] } }
    planner.instance._updatePlannerState({ goalContext: { what: '游泳', deadline: '7天', dailyTime: '15分钟', level: '新手' } })
    await planner.instance.generatePlanTasks()
    eq(plannerCalls[1].provider, 'deepseek')
    eq(plannerCalls[2].provider, 'deepseek')
    eq(plannerCalls[2].plan_id, 'frontend-plan')
    await run('aiPlannerChat', 'owner', { messages: [{ role: 'user', content: '游泳计划' }], provider: 'deepseek' })
    eq(requests.at(-1).options.hostname, 'api.deepseek.com')
    const start = await run('aiStartGenerate', 'owner', { provider: 'deepseek', planState: { what: '游泳' } })
    eq(env.rows.ai_plans[0].provider, 'deepseek')
    responseBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ goal: { title: '游泳' }, tasks: [{ title: '练习', xp_reward: 10 }] }) } }] })
    await run('aiDoGenerate', 'owner', { plan_id: start.data.plan_id, provider: 'qwen' })
    eq(requests.at(-1).options.hostname, 'api.deepseek.com') // provider pinned at start
    eq(env.rows.ai_plans[0].status, 'done')
    const removed = await run('saveApiKey', 'owner', { provider: 'deepseek', clear: true })
    eq(removed.cleared, true); eq(env.rows.api_keys.some(k => k._id === 'd'), false)
    eq(env.rows.api_keys.some(k => k._id === 'other'), true)
    const empty = page('miniprogram/pages/ai-config/ai-config.js', { myApiKeys: async () => { throw new Error('network') } })
    await empty.instance.onShow(); eq(!!empty.instance.data.configError, true)
    eq(empty.instance.data.configSaved, false)
    const unconfirmed = page('miniprogram/pages/ai-config/ai-config.js', {
      myApiKeys: async () => [], saveApiKey: async () => ({}),
    })
    await unconfirmed.instance.onShow()
    unconfirmed.instance.onApiKey({ detail: { value: qKey } })
    await unconfirmed.instance.saveConfig()
    eq(unconfirmed.instance.data.apiKey, qKey)
    eq(unconfirmed.toast.at(-1).title.includes('未收到保存回执'), true)
    const legacy = models.publicConfigs([{ provider: 'deepseek', api_key: dKey }])
    eq(legacy[0].has_key, true); eq(JSON.stringify(legacy).includes(dKey), false)
    console.log(JSON.stringify({ passed: checks, failed: 0, scope: 'Actual handlers + SDK offline transport + actual pages + stub HTTPS; no real key/cloud/model access' }, null, 2))
  } finally { env.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
