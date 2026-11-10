const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict')
const { createRequire } = require('node:module'), { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService: createCoach } = require('../cloudfunctions/app/lib/coachService')
const { createService } = require('../cloudfunctions/app/lib/adjustmentService')
const { createAdjustmentGraph } = require('../cloudfunctions/app/lib/stewardGraph.cjs')
const schedule = require('../miniprogram/utils/planSchedule')
let checks = 0
const eq = (a, b) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
function page(api, storage = new Map(), name = 'ai/ai', clock) {
  const file = path.resolve(__dirname, '../miniprogram/pages', name + '.js'), req = createRequire(file), app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, options = { storageFail: false, toasts: [] }
  let p
  const wx = { getStorageSync: k => storage.get(k), setStorageSync(k, v) { if (options.storageFail) throw Error('storage full'); storage.set(k, structuredClone(v)) }, removeStorageSync: k => storage.delete(k),
    showToast(v) { options.toasts.push(v) }, showModal(v) { if (options.modalHook) return options.modalHook(v); v.success({confirm:options.modalConfirm !== false}) }, pageScrollTo(v) { options.scroll = v.selector }, navigateTo() {}, switchTab() {}, stopPullDownRefresh() {} }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: n => n.endsWith('/cloudApi') ? api : clock && n.endsWith('/planSchedule') ? clock.schedule : req(n), Date: clock ? clock.Date : Date, Page: d => { p = d }, wx, getApp: () => app,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} })
  p.data = structuredClone(p.data)
  p.setData = function(patch, callback) { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let o = this.data; for (const k of parts.slice(0, -1)) o = o[k]; o[parts.at(-1)] = value } if (callback) callback() }
  return { p, app, storage, options, wx }
}
const event = value => ({ detail: { value } })
async function choose(p) { await p.loadCoachGoals(); await p.onCoachGoalChange(event('0')) }

async function main() {
 const today=schedule.today(), tomorrow=schedule.addDays(today,1)
 const env=offlineCloudbase({ai_plans:[],goals:[{_id:'g1',_openid:'owner',title:'阅读',status:'active',start_date:today,end_date:schedule.addDays(today,30)}],tasks:[{_id:'t1',_openid:'owner',goal_id:'g1',title:'阅读20分钟',date:tomorrow,completed:false,estimated_minutes:20,xp_reward:10}]})
 let calls=0,starts=0
 const coach=createCoach({cloud:env.cloud})
 const service=createService({cloud:env.cloud,coach,graphFactory:createAdjustmentGraph,loadModel:async()=>({provider:'deepseek',model:'deepseek-chat'}),callModel:async(_,messages)=>{calls++;return JSON.stringify(messages[0].content.includes('调整规划师')?{changes:[{task_id:'t1',title:'阅读5页',date:tomorrow,estimated_minutes:10,reason:'按本轮要求缩短单次时间'}]}:{summary:'本轮调整符合明确预算',findings:[]})}})
 const api={goals:async()=>[{_id:'g1',title:'阅读'}],tasks:async()=>[],getCoachWorkspace:d=>coach.get('owner',d),getAdjustmentWorkspace:d=>service.get('owner',d),startAdjustment:d=>{starts++;return service.start('owner',d)},stepAdjustment:d=>service.step('owner',d),saveAdjustment:d=>service.save('owner',d),cancelAdjustment:d=>service.cancel('owner',d)}
 async function open(storage=new Map(), overrides={}) {const c=page({...api,...overrides},storage,'forest-steward/forest-steward');await c.p.onShow();await c.p.selectGoal({currentTarget:{dataset:{id:'g1'}}});await c.p.setResultTab({currentTarget:{dataset:{tab:'summary'}}});return c}
 try{
  const c=await open(),p=c.p
  eq(p.data.adjustmentWorkspace.snapshot.tasks.length,1);eq(p.data.adjustmentRun,null);eq(calls,0)
  p.onAdjustmentInstructions(event('缩短单次投入，先做10分钟'));p.onAdjustmentMinutes(event('10'));await p.startAdjustment()
  eq(p.data.adjustmentRun.status,'awaiting_review');eq(p.data.adjustmentRun.review.revision,1);eq(calls,2);eq(starts,1)
  const inputDraft=await open();inputDraft.p.toggleAdjustmentInputs();inputDraft.p.onAdjustmentInstructions(event('尚未提交的新要求'))
  const inputRestored=await open(inputDraft.storage);eq(inputRestored.p.data.adjustmentInstructions,'尚未提交的新要求');eq(inputRestored.p.data.adjustmentDirty,true);eq(inputRestored.p.data.adjustmentShowInputs,true);eq(calls,2)
  p.onAdjustmentEdit({currentTarget:{dataset:{index:0,field:'estimated_minutes'}},detail:{value:'5'}})
  eq(p.data.adjustmentDirty,true);await p.continueAdjustment();eq(calls,2)
  await p.saveAdjustmentEdits();eq(p.data.adjustmentRun.revision,2);eq(p.data.adjustmentRun.review,null);eq(p.data.adjustmentRun.status,'ready')
  const restored=await open(c.storage);eq(restored.p.data.adjustmentInstructions,'缩短单次投入，先做10分钟');eq(restored.p.data.adjustmentEdits[0].estimated_minutes,5);eq(calls,2)
  await restored.p.continueAdjustment();eq(calls,3);eq(restored.p.data.adjustmentRun.review.revision,2)
  const device2=await open()
  restored.p.onAdjustmentEdit({currentTarget:{dataset:{index:0,field:'title'}},detail:{value:'设备一新标题'}});await restored.p.saveAdjustmentEdits()
  device2.p.onAdjustmentEdit({currentTarget:{dataset:{index:0,field:'title'}},detail:{value:'设备二未提交标题'}});await device2.p.saveAdjustmentEdits()
  eq(device2.p.data.adjustmentDirty,true);eq(device2.p.data.adjustmentEdits[0].title,'设备二未提交标题');eq(device2.p.data.adjustmentError.includes('版本'),true)
  await device2.p.loadAdjustment();eq(device2.p.data.adjustmentConflict,true)
  await device2.p.readAdjustmentCloud();eq(device2.p.data.adjustmentEdits[0].title,'设备一新标题');eq(device2.p.data.adjustmentDirty,false)
  device2.p.restoreAdjustmentBackup();eq(device2.p.data.adjustmentEdits[0].title,'设备二未提交标题');eq(device2.p.data.adjustmentConflict,true)
  const hold=defer(),late=await open();late.p.setData({adjustmentWorkspace:null})
  const work=late.p.loadAdjustment(); // ordinary read completes normally
  await work
  const pending=page({...api,getAdjustmentWorkspace:()=>hold.promise},new Map(),'forest-steward/forest-steward')
  await pending.p.onShow();await pending.p.selectGoal({currentTarget:{dataset:{id:'g1'}}})
  const reading=pending.p.setResultTab({currentTarget:{dataset:{tab:'summary'}}})
  await new Promise(r=>setImmediate(r));pending.app.globalData.currentOpenid='other';pending.p.pauseAdjustment()
  hold.resolve(await service.get('owner',{goal_id:'g1',date:today}));await reading;eq(pending.p.data.adjustmentWorkspace,null)
  const broken=await open();broken.options.storageFail=true;broken.p.onAdjustmentInstructions(event('保存失败保护'));const before=starts;await broken.p.startAdjustment();eq(starts,before)
  await device2.p.readAdjustmentCloud();await device2.p.continueAdjustment()
  device2.p.keepAdjustmentOriginal({currentTarget:{dataset:{index:0}}});eq(device2.p.data.adjustmentEdits.length,0)
  await device2.p.saveAdjustmentEdits();await device2.p.cancelAdjustment();device2.p.onAdjustmentInstructions(event('取消后新一轮的要求'));eq(device2.p.data.adjustmentDirty,false)
  eq(env.rows.tasks[0].title,'阅读20分钟');eq(env.rows.tasks[0].estimated_minutes,20);eq(env.rows.tasks[0].xp_reward,10)
 }finally{env.close()}
 await coachSuggestionHandoff()
 console.log('adjustment-client: '+checks+' assertions passed (actual Page/SDK/LangGraph offline)')
}
async function coachSuggestionHandoff() {
 const date = schedule.today()
 const suggestion = { action: '先读十分钟', message: '试着缩短', evidence: [{ id: 'past', label: '登记结果' }] }
 const report = { id: 'coach-report', fingerprint: 'a'.repeat(64), status: 'done', result: { suggestions: [suggestion] } }
 let current = true, starts = 0
 const api = {
  goals: async () => [{ _id: 'g1', title: '阅读' }, { _id: 'g2', title: '散步' }], tasks: async () => [],
  getCoachWorkspace: async () => ({ report: current ? report : null }),
  getAdjustmentWorkspace: async () => ({ fingerprint: 'current', run: null, applicationSupported: true,
   snapshot: { eligible: true, complete: true, tasks: [{ id: 't1' }], coach_fingerprint: current ? report.fingerprint : 'changed',
    report: current ? { id: report.id, analysis: report.result } : null } }),
  startAdjustment: async () => { starts++; throw Error('test should not generate') }
 }
 const source = page({}, new Map(), 'ai/ai')
 source.p.syncPartnerOwner()
 source.p.setData({ coachReport: report, coachGoalId: 'g1', coachDate: date })
 const target = page(api, new Map(), 'forest-steward/forest-steward')
 const key = 'forest_adjustment_input_v2:' + JSON.stringify([JSON.stringify(['owner', 'account']), 'g1', date])
 target.storage.set(key, { instructions: '保留我原先的文字', minutes: '', edits: [], inputChanged: true })
 source.p.openCoachInSteward({ currentTarget: { dataset: { index: 0 } } })
 await target.p.onShow()
 eq(target.p.data.currentGoal.id, 'g1')
 eq(target.p.data.coachSummaryDate, date)
 eq(target.p.data.adjustmentInstructions, '保留我原先的文字')
 eq(target.p.data.adjustmentSuggestion.action, '先读十分钟')
 eq(starts, 0)
 current = false
 await target.p.loadAdjustment()
 eq(target.p.data.adjustmentSuggestion.stale, true)
 await target.p.startAdjustment()
 eq(starts, 0)
 target.p.removeAdjustmentSuggestion()
 eq(target.p.data.adjustmentSuggestion, null)
 eq(target.p.data.adjustmentInstructions, '保留我原先的文字')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={page,event}
