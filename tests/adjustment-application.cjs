const assert = require('node:assert/strict')
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs')
const { createService } = require('../cloudfunctions/app/lib/adjustmentService')
const { createService: createCoach } = require('../cloudfunctions/app/lib/coachService')
const { createAdjustmentGraph } = require('../cloudfunctions/app/lib/stewardGraph.cjs')
const schedule = require('../miniprogram/utils/planSchedule')
const { createClock } = require('./helpers/clock.cjs')
let checks = 0
const eq = (a,b) => { assert.deepEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b); checks++ }
const reject = async (f,p) => { await assert.rejects(f,p); checks++ }
const baseTime = Date.parse('2026-11-06T12:00:00+08:00'), input = {goal_id:'g1',date:'2026-11-06'}
const envelope = r => ({run_id:r.id,expected_revision:r.revision,confirmation:r.confirmation})
async function fixture(hooks = {}, taskCount = 2, historyCount = 0, timestamp = baseTime) {
 const state = { time:timestamp, calls:0 }, clock = createClock(() => state.time), today = clock.schedule.today(), request = {...input,date:today}
 const seed={ai_plans:[],goals:[{_id:'g1',_openid:'owner',title:'阅读',status:'active',start_date:schedule.addDays(today,-5),end_date:schedule.addDays(today,24)}],tasks:Array.from({length:taskCount},(_,i)=>({_id:'task'+i,_openid:'owner',goal_id:'g1',title:'阅读20分钟-'+i,date:schedule.addDays(today,i%2+1),completed:false,estimated_minutes:20,xp_reward:10,stage:1})),users:[{_id:'user',_openid:'owner',total_xp:70}],growth_logs:[],user_growth_pool:[{_id:'pool',_openid:'owner',growth_pool:30}]}
 seed.tasks.push(...Array.from({length:historyCount},(_,i)=>({_id:'history'+i,_openid:'owner',goal_id:'g1',title:'历史记录',date:schedule.addDays(today,-1),completed:false,estimated_minutes:20})))
 const env=offlineCloudbase(seed,{snapshotIsolation:true,serialTransactions:true,...hooks}),coach=createCoach({cloud:env.cloud,now:()=>state.time})
 const service=createService({cloud:env.cloud,coach,now:clock.now,graphFactory:createAdjustmentGraph,loadModel:async()=>({provider:'deepseek',model:'deepseek-chat'}),callModel:async(_,messages)=>{state.calls++;return JSON.stringify(messages[0].content.includes('调整规划师')?{changes:seed.tasks.filter(t=>t.date>request.date).map(t=>({task_id:t._id,title:'阅读10分钟-'+t._id,date:t.date,estimated_minutes:10,reason:'按用户明确要求减少单次负担'}))}:{summary:'可尝试，结合后续反馈调整',findings:[]})}})
 const w=await service.get('owner',request)
 let run=(await service.start('owner',{...request,request_id:'start',fingerprint:w.fingerprint,instructions:'任务缩短至10分钟',daily_minutes:Math.max(30,taskCount*10)})).run
 for(let i=0;run.status==='ready'&&i<7;i++)run=(await service.step('owner',{run_id:run.id,request_id:'step'+i})).run
 return {env,service,coach,state,run,seed,clock,close:()=>env.close()}
}
async function main(){
 let f=await fixture()
 try{
  const {service:s,run,env,state}=f,req=envelope(run),beforeRewards=JSON.stringify([env.rows.users,env.rows.growth_logs,env.rows.user_growth_pool]),beforeGoal=structuredClone(env.rows.goals)
  eq(run.can_apply,true);eq((await s.get('owner',input)).read_proof,undefined)
  eq((await f.coach.get('owner',input)).read_proof,undefined)
  await reject(()=>s.apply('other',req),/不存在/);await reject(()=>s.apply('',req),/身份/)
  await reject(()=>s.apply('owner',{...req,confirmation:'0'.repeat(64)}),/版本/)
  await reject(()=>s.apply('owner',{...req,expected_revision:2}),/版本/)
  const results=await Promise.all(Array.from({length:20},()=>s.apply('owner',req)))
  eq(new Set(results.map(r=>r.application.id)).size,1);eq(results.filter(r=>!r.cached).length,1)
  eq(env.rows.tasks.map(t=>t.estimated_minutes),[10,10]);eq(env.rows.tasks.map(t=>t.completed),[false,false]);eq(env.rows.tasks.map(t=>t.xp_reward),[10,10]);eq(env.rows.goals,beforeGoal.map(g=>({...g,last_task_adjustment_at:baseTime})));eq(JSON.stringify([env.rows.users,env.rows.growth_logs,env.rows.user_growth_pool]),beforeRewards);eq(state.calls,2)
  eq((await s.get('owner',input)).run.status,'applied');eq((await s.cancel('owner',{run_id:run.id})).run.status,'applied')
  env.mutate('tasks','task0',{title:'用户后来修改',completed:true});state.time+=86400000
  eq((await s.apply('owner',req)).application.id,results[0].application.id);eq(env.rows.tasks[0].title,'用户后来修改')
  eq((await s.applicationStatus('owner',req)).application.count,2)
 }finally{f.close()}
 for(const patch of [{completed:true},{status:'deleted'},{date:'2026-11-06'},{title:'另行编辑'},{goal_id:'another'},{_openid:'other'},{xp_reward:30}]){
  f=await fixture();try{const before=structuredClone(f.env.rows.tasks);f.env.mutate('tasks','task0',patch);await reject(()=>f.service.apply('owner',envelope(f.run)),/变化/);eq(f.env.rows.tasks[1],before[1]);eq((await f.service.applicationStatus('owner',envelope(f.run))).application,null)}finally{f.close()}
 }
 for(const patch of [{status:'done'},{end_date:'2026-11-06'},{title:'换目标名'}]){
  f=await fixture();try{f.env.mutate('goals','g1',patch);await reject(()=>f.service.apply('owner',envelope(f.run)),/变化/);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20])}finally{f.close()}
 }
 f=await fixture();try{
  const w=await f.coach.get('owner',input);await f.coach.saveFeedback('owner',{...input,request_id:'feedback',expected_revision:w.feedback.revision,values:{note:'时间不够'}})
  await reject(()=>f.service.apply('owner',envelope(f.run)),/变化/)
 }finally{f.close()}
 f=await fixture();try{
  const s=f.service,req=envelope(f.run);await s.cancel('owner',{run_id:f.run.id});await reject(()=>s.apply('owner',req),/取消/)
 }finally{f.close()}
 f=await fixture();try{
  const s=f.service,w=await s.get('owner',input);await s.start('owner',{...input,request_id:'new-head',fingerprint:w.fingerprint,instructions:'另一方案'})
  await reject(()=>s.apply('owner',envelope(f.run)),/替代/)
 }finally{f.close()}
 f=await fixture();try{
  const s=f.service;let r=(await s.save('owner',{run_id:f.run.id,expected_revision:1,changes:f.run.changes.map(t=>({...t,estimated_minutes:5})),instructions:'先做5分钟',daily_minutes:5})).run
  await reject(()=>s.apply('owner',envelope(r)),/规则检查/)
  r=(await s.check('owner',envelope(r))).run;eq(r.status,'awaiting_review');eq(r.can_apply,true);eq(r.review,null);eq(f.state.calls,2)
  await reject(()=>s.apply('owner',envelope(f.run)),/版本/)
  eq((await s.apply('owner',envelope(r))).application.revision,2);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[5,5]);eq(f.state.calls,2)
 }finally{f.close()}
 f=await fixture();try{
  let r=(await f.service.save('owner',{run_id:f.run.id,expected_revision:1,changes:f.run.changes,instructions:'每天最多5分钟',daily_minutes:5})).run
  r=(await f.service.check('owner',envelope(r))).run;eq(r.can_apply,false);await reject(()=>f.service.apply('owner',envelope(r)),/规则检查/)
 }finally{f.close()}
 let inject=false
 f=await fixture({beforeRequest(command,args){if(inject&&command==='database.modifyDocument'&&args.collectionName==='tasks'&&args.query.includes('task1'))throw Error('injected-write-failure')}})
 try{inject=true;await reject(()=>f.service.apply('owner',envelope(f.run)),/injected/);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20]);eq((await f.service.applicationStatus('owner',envelope(f.run))).application,null);inject=false;eq((await f.service.apply('owner',envelope(f.run))).application.count,2)}finally{f.close()}
 let race=false
 f=await fixture({beforeRequest(command,args,wire){if(race&&command==='database.startTransaction'){race=false;wire.mutate('tasks','task1',{completed:true})}}})
 try{race=true;await reject(()=>f.service.apply('owner',envelope(f.run)),/来源/);eq(f.env.rows.tasks[0].estimated_minutes,20);eq((await f.service.applicationStatus('owner',envelope(f.run))).application,null)}finally{f.close()}
 let midnight=false,current
 f=await fixture({beforeRequest(command,args){if(midnight&&command==='database.modifyDocument'&&args.collectionName==='tasks'){midnight=false;current.time+=86400000}}});current=f.state
 try{midnight=true;await reject(()=>f.service.apply('owner',envelope(f.run)),/跨日/);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20])}finally{f.close()}
 f=await fixture();try{f.state.time+=86400000;await reject(()=>f.service.apply('owner',envelope(f.run)),/变化/)}finally{f.close()}
 // New IDs discovered at preflight invalidate the exact source fingerprint.
 f=await fixture();try{await f.env.cloud.database().collection('tasks').add({data:{...f.seed.tasks[0],_id:'new-task'}});await reject(()=>f.service.apply('owner',envelope(f.run)),/变化/)}finally{f.close()}
 let closeAtCommit=false
 f=await fixture({beforeRequest(command,args,wire){if(closeAtCommit&&command==='database.commitTransaction'){closeAtCommit=false;wire.mutate('goals','g1',{status:'done'})}}})
 try{closeAtCommit=true;await reject(()=>f.service.apply('owner',envelope(f.run)),/来源/);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20]);eq(f.env.rows.goals[0].status,'done');eq((await f.service.applicationStatus('owner',envelope(f.run))).application,null)}finally{f.close()}
 f=await fixture({},20);try{eq((await f.service.apply('owner',envelope(f.run))).application.count,20);eq(f.env.rows.tasks.every(t=>t.estimated_minutes===10&&t.completed===false&&t.xp_reward===10),true)}finally{f.close()}
 f=await fixture({},2,95);try{eq(f.run.can_apply,false);await reject(()=>f.service.apply('owner',envelope(f.run)),/100条/);eq(f.env.rows.tasks[0].estimated_minutes,20)}finally{f.close()}
 console.log('adjustment-application: '+checks+' assertions passed (installed SDK/LangGraph offline; no real cloud writes)')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={fixture,envelope}
