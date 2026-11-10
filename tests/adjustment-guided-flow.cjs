const assert = require('node:assert/strict')
const { page, event } = require('./adjustment-client.cjs')
const { fixture } = require('./adjustment-application.cjs')
let checks = 0
const eq = (a, b) => { assert.deepEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b); checks++ }
function client(f, options = {}, storage = new Map()) {
  const calls = { apply: [], query: 0 }
  const api = {
    goals: async () => f.env.rows.goals,
    tasks: async () => [],
    getCoachWorkspace: d => f.coach.get('owner', d),
    getAdjustmentWorkspace: d => options.read ? options.read(d) : f.service.get('owner', d),
    startAdjustment: d => f.service.start('owner', d),
    stepAdjustment: d => f.service.step('owner', d),
    saveAdjustment: d => f.service.save('owner', d),
    checkAdjustment: d => f.service.check('owner', d),
    applyAdjustment: d => { calls.apply.push(structuredClone(d)); return options.apply ? options.apply(d, calls.apply.length) : f.service.apply('owner', d) },
    getAdjustmentApplication: d => { calls.query++; return f.service.applicationStatus('owner', d) }
  }
  const c = page(api, storage, 'forest-steward/forest-steward', f.clock)
  c.calls = calls
  c.open = async () => {
    await c.p.onShow()
    await c.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
    await c.p.setResultTab({ currentTarget: { dataset: { tab: 'summary' } } })
    return c
  }
  return c
}
async function main() {
  let f = await fixture()
  try {
    const c = await client(f).open(), p = c.p
    eq(p.data.adjustmentFlow.phase, 'confirm')
    p.scrollAdjustmentComparison(); eq(c.options.scroll, '#adjustment-comparison')
    p.onAdjustmentEdit({ currentTarget: { dataset: { index: 0, field: 'title' } }, detail: { value: '阅读10分钟（小步骤）' } })
    eq(p.data.adjustmentFlow.action, 'save')
    await p.handleAdjustmentNext()
    eq(p.data.adjustmentRun.revision, 2); eq(p.data.adjustmentFlow.action, 'check')
    eq(f.env.rows.tasks.map(t => t.estimated_minutes), [20, 20])
    await p.handleAdjustmentNext()
    eq(p.data.adjustmentFlow.action, 'apply'); eq(p.data.adjustmentRun.review, null); eq(f.state.calls, 2)
    c.options.modalConfirm = false; await p.handleAdjustmentNext()
    eq(c.calls.apply.length, 0); eq(p.data.adjustmentFlow.phase, 'confirm')
    c.options.modalConfirm = true; await p.handleAdjustmentNext()
    eq(p.data.adjustmentFlow.phase, 'applied'); eq(p.data.adjustmentApplicationReceipt.revision, 2)
    eq(f.env.rows.tasks.map(t => t.estimated_minutes), [10, 10]); eq(c.calls.apply.length, 1); eq(f.state.calls, 2)
    const restored = await client(f, {}, c.storage).open()
    eq(restored.p.data.adjustmentFlow.phase, 'applied')
    await restored.p.handleAdjustmentNext(); eq(restored.calls.apply.length, 0)
    // A subsequent run must not keep the previous run's success receipt.
    restored.p.showAdjustmentRequirements(); eq(restored.options.scroll, '#adjustment-requirements')
    restored.p.onAdjustmentInstructions(event('再调整一轮，保留10分钟'))
    await restored.p.startAdjustment()
    eq(restored.p.data.adjustmentApplicationReceipt, null)
    eq(restored.p.data.adjustmentRun.id === p.data.adjustmentRun.id, false)
    eq(restored.p.data.adjustmentFlow.phase === 'applied', false)
  } finally { f.close() }

  f = await fixture()
  try {
    const c = await client(f, { apply: (d, n) => n === 1 ? Promise.reject(Error('network lost before submission')) : f.service.apply('owner', d) }).open()
    await c.p.handleAdjustmentNext()
    eq(c.p.data.adjustmentFlow.action, 'query'); eq(c.calls.apply.length, 1)
    await c.p.handleAdjustmentNext()
    eq(c.p.data.adjustmentFlow.action, 'retry'); eq(c.calls.query, 1); eq(c.calls.apply.length, 1)
    eq(c.p.data.adjustmentError, ''); eq(f.env.rows.tasks.map(t => t.estimated_minutes), [20, 20])
    await c.p.handleAdjustmentNext()
    eq(c.calls.apply[1], c.calls.apply[0]); eq(c.p.data.adjustmentFlow.phase, 'applied'); eq(f.state.calls, 2)
  } finally { f.close() }

  f = await fixture()
  try {
    const c = await client(f).open(), key = [...c.storage.keys()].find(k => k.startsWith('forest_adjustment_input_v2:') && !k.endsWith(':application'))
    // Simulate an interrupted generation: inputs cached, cloud run already done.
    c.p.cacheAdjustment()
    const inputKey = key || [...c.storage.keys()].find(k => k.startsWith('forest_adjustment_input_v2:'))
    const saved = c.storage.get(inputKey)
    c.storage.set(inputKey, { ...saved, dirty: false, inputChanged: true })
    const same = await client(f, {}, c.storage).open()
    eq(same.p.data.adjustmentInputChanged, false); eq(same.p.data.adjustmentFlow.action, 'apply')
    c.storage.set(inputKey, { ...saved, instructions: '本机新增要求尚未提交', dirty: false, inputChanged: true })
    const changed = await client(f, {}, c.storage).open()
    eq(changed.p.data.adjustmentDirty, true); eq(changed.p.data.adjustmentFlow.action, 'save')
    eq(changed.p.data.adjustmentInstructions, '本机新增要求尚未提交')
    await changed.p.handleAdjustmentNext(); eq(changed.p.data.adjustmentRun.revision, 2); eq(f.state.calls, 2)
    changed.app.globalData.currentOpenid = 'other'
    await changed.p.handleAdjustmentNext()
    eq(changed.p.data.adjustmentFlow.disabled, true); eq(changed.calls.apply.length, 0)
    // Scoped goal selection keeps the adjustment tab; the global picker retains
    // its existing Today landing behavior. No task writes or model calls.
    changed.app.globalData.currentOpenid = 'owner'
    changed.p.openAdjustmentGoals(); eq(changed.p.data.goalPickerOpen, true)
    await changed.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
    eq(changed.p.data.resultTab, 'summary')
    changed.p.toggleGoals()
    await changed.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
    eq(changed.p.data.resultTab, 'today'); eq(f.state.calls, 2)
  } finally { f.close() }

  f = await fixture()
  try {
    const first = await client(f, { apply: async () => { throw Error('network lost') } }).open()
    await first.p.handleAdjustmentNext()
    const retry = await client(f, { read: async () => { throw Error('draft read unavailable') } }, first.storage).open()
    eq(retry.p.data.adjustmentRun, null); eq(retry.p.data.adjustmentFlow.action, 'query')
    await retry.p.handleAdjustmentNext(); eq(retry.p.data.adjustmentFlow.action, 'retry')
    await retry.p.handleAdjustmentNext()
    eq(retry.p.data.adjustmentFlow.phase, 'applied'); eq(retry.p.data.adjustmentPendingApplication, null)
    eq(retry.p.data.adjustmentError.includes('应用结果待核对'), false)
    eq(retry.calls.apply.length, 1); eq(retry.p.data.adjustmentApplicationReceipt.count, 2)
  } finally { f.close() }
  console.log('adjustment-guided-flow: ' + checks + ' assertions passed (actual Page/service/LangGraph offline)')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
