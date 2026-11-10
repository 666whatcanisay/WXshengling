const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module')
const {page,event}=require('./adjustment-client.cjs'),{fixture,envelope}=require('./adjustment-application.cjs')
let checks=0
const eq=(a,b)=>{assert.deepEqual(a===undefined?a:JSON.parse(JSON.stringify(a)),b);checks++}
async function main(){
 const f=await fixture();let applyCalls=0,queryCalls=0,loseResponse=false
 const api={goals:async()=>[{_id:'g1',title:'阅读'}],tasks:async()=>[],getCoachWorkspace:d=>f.coach.get('owner',d),getAdjustmentWorkspace:d=>f.service.get('owner',d),checkAdjustment:d=>f.service.check('owner',d),cancelAdjustment:d=>f.service.cancel('owner',d),applyAdjustment:async d=>{applyCalls++;const r=await f.service.apply('owner',d);if(loseResponse)throw Error('network timeout after commit');return r},getAdjustmentApplication:d=>{queryCalls++;return f.service.applicationStatus('owner',d)}}
 async function open(storage=new Map(),overrides={}){const c=page({...api,...overrides},storage,'forest-steward/forest-steward',f.clock);await c.p.onShow();await c.p.selectGoal({currentTarget:{dataset:{id:'g1'}}});await c.p.setResultTab({currentTarget:{dataset:{tab:'summary'}}});return c}
 try{
  let c=await open();eq(c.p.data.adjustmentRun.can_apply,true)
  c.options.modalConfirm=false;await c.p.confirmAdjustmentApplication();eq(applyCalls,0);eq(c.p.data.adjustmentPendingApplication,null)
  c.options.modalConfirm=true;c.p.onAdjustmentInstructions(event('尚未保存'));await c.p.confirmAdjustmentApplication();eq(applyCalls,0)
  c=await open();c.options.storageFail=true;await c.p.confirmAdjustmentApplication();eq(applyCalls,0);eq(c.p.data.adjustmentPendingApplication,null)
  c=await open();let accept; c.options.modalHook=v=>{accept=v.success}
  const waiting=c.p.confirmAdjustmentApplication();await c.p.confirmAdjustmentApplication();eq(applyCalls,0);eq(c.p.data.adjustmentBusy,'等待你确认');accept({confirm:false});await waiting;eq(c.p.data.adjustmentBusy,'')
  c=await open();loseResponse=true;await c.p.confirmAdjustmentApplication();eq(applyCalls,1);eq(!!c.p.data.adjustmentPendingApplication,true);eq(c.p.data.adjustmentApplicationReceipt,null);eq(c.p.data.adjustmentError.includes('待核对'),true)
  const previous=c.p.data.adjustmentEdits[0].title;c.p.onAdjustmentEdit({currentTarget:{dataset:{index:0,field:'title'}},detail:{value:'不能换稿'}});eq(c.p.data.adjustmentEdits[0].title,previous)
  // Recompile equivalent: local receipt query succeeds even if workspace read fails.
  const restored=await open(c.storage,{getAdjustmentWorkspace:async()=>{throw Error('read unavailable')}})
  eq(!!restored.p.data.adjustmentPendingApplication,true);eq(applyCalls,1)
  await restored.p.queryAdjustmentApplication();eq(queryCalls,1);eq(restored.p.data.adjustmentPendingApplication,null);eq(restored.p.data.adjustmentApplicationReceipt.count,2);eq(applyCalls,1)
  const again=await open(c.storage);eq(again.p.data.adjustmentRun.status,'applied');eq(again.p.data.adjustmentApplicationReceipt.count,2)
  await again.p.confirmAdjustmentApplication();eq(applyCalls,1);eq(f.state.calls,2)
  // Stale owner/context cannot accept a modal or send the previous account's action.
  const other=page(api,new Map(),'forest-steward/forest-steward',f.clock);other.app.globalData.currentOpenid='other'
  await other.p.onShow();eq(other.p.data.adjustmentPendingApplication,null)
 }finally{f.close()}
 // No receipt yet is not a definitive failure: retain the exact envelope and
 // freeze edits. An explicit cancel closes the race with an in-flight apply.
 const g=await fixture();try{
  const storage=new Map(),api2={goals:async()=>[{_id:'g1',title:'阅读'}],tasks:async()=>[],getCoachWorkspace:d=>g.coach.get('owner',d),getAdjustmentWorkspace:d=>g.service.get('owner',d),applyAdjustment:async()=>{throw Error('network lost before response')},getAdjustmentApplication:d=>g.service.applicationStatus('owner',d),cancelAdjustment:d=>g.service.cancel('owner',d)}
  const c=page(api2,storage,'forest-steward/forest-steward',g.clock);await c.p.onShow();await c.p.selectGoal({currentTarget:{dataset:{id:'g1'}}});await c.p.setResultTab({currentTarget:{dataset:{tab:'summary'}}})
  await c.p.confirmAdjustmentApplication();await c.p.queryAdjustmentApplication();eq(!!c.p.data.adjustmentPendingApplication,true)
  const originalReceipt = c.p.data.adjustmentPendingApplication
  const switched = page(api2, storage, 'forest-steward/forest-steward', g.clock)
  switched.app.globalData.userInfo = { id: 'recreated' }
  await switched.p.onShow()
  await switched.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
  await switched.p.setResultTab({ currentTarget: { dataset: { tab: 'summary' } } })
  eq(switched.p.data.adjustmentPendingApplication, null)
  eq([...storage.entries()].find(([key]) => key.endsWith(':application'))[1], originalReceipt)
  await c.p.cancelAdjustment();eq(c.p.data.adjustmentPendingApplication,null);eq(c.p.data.adjustmentRun.status,'cancelled');eq(g.env.rows.tasks.map(t=>t.estimated_minutes),[20,20]);eq(g.state.calls,2)
 }finally{g.close()}
 // Exercise actual cloudApi transport: applying is never automatically retried.
 let requests=0,timers=0;const file=path.resolve(__dirname,'../miniprogram/utils/cloudApi.js'),context={module:{exports:{}},require:createRequire(file),wx:{cloud:{callFunction(o){requests++;o.fail({errMsg:'network timeout'})}},showToast(){},getNetworkType(o){o.success({networkType:'wifi'})}},console:{log(){},warn(){},error(){}},setTimeout(){timers++}}
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context);await assert.rejects(()=>context.module.exports.applyAdjustment(envelope({id:'r',revision:1,confirmation:'hash'})));checks++;eq(requests,1);eq(timers,0)
 console.log('adjustment-application-client: '+checks+' assertions passed (actual Page/transport/SDK offline)')
}
main().catch(e=>{console.error(e);process.exitCode=1})
