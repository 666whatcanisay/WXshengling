// Exercise Console helpers against actual handlers and the installed SDK offline.
// In particular, createGoal/createTask return {success:true,id}, not {code:0}.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const {offlineCloudbase}=require('./helpers/offline-cloudbase.cjs')
const setup=fs.readFileSync(path.resolve(__dirname,'../tools/adjustment-apply-manual-setup.js'),'utf8')
const recovery=fs.readFileSync(path.resolve(__dirname,'../tools/adjustment-apply-manual-recover.js'),'utf8')
const fixedGuard="if (!r || r.success === false || (r.code !== undefined ? r.code !== 0 : r.success !== true))"
let checks=0
const eq=(a,b)=>{assert.deepEqual(a,b);checks++}
function fixture(){
 const env=offlineCloudbase({goals:[],tasks:[],ai_plans:[],users:[{_id:'user',_openid:'owner',username:'fixture',role:'admin',total_xp:10}]})
 const load=relative=>{const file=path.resolve(__dirname,'..',relative),req=createRequire(file),ctx={exports:{},require:n=>n==='wx-server-sdk'?env.cloud:req(n),console:{log(){},warn(){},error(){}},URL,Buffer,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(file,'utf8'),ctx);return ctx.exports.main}
 const handlers={'app-node24':load('cloudfunctions/app/index.js'),'login-node24':load('cloudfunctions/login/index.js')},storage=new Map(),calls=[],outputs=[]
 const state={storageFail:false,loseTaskResponse:false,loseApplyResponse:false,foreignIdentity:false}
 const wx={getStorageSync:k=>storage.get(k),setStorageSync(k,v){if(state.storageFail)throw Error('storage failed');storage.set(k,structuredClone(v))},cloud:{async callFunction(o){calls.push({name:o.name,action:o.data.action||''});const r=await handlers[o.name](o.data);if(state.loseTaskResponse&&o.data.action==='createTask'||state.loseApplyResponse&&o.data.action==='applyAdjustment')throw Error('lost response');return {result:r}}}}
 async function run(code){outputs.length=0;await vm.runInNewContext(code,{wx,getApp:()=>({globalData:{currentOpenid:state.foreignIdentity?'other':'owner'}}),getCurrentPages:()=>[],console:{log(label,value){outputs.push({label,value:JSON.parse(value)})}},Date,JSON,Error});return outputs[0].value}
 const writeCalls=()=>calls.filter(c=>['createGoal','createTask'].includes(c.action)).length
 return {env,storage,calls,outputs,state,run,writeCalls,close:()=>env.close()}
}
function recoveryFor(goal){
 return recovery.replace("goalId = '10f29c566aede179000384776d3f22e2', title = '[联调] 确认应用-mw526pzz'",'goalId = '+JSON.stringify(goal._id)+', title = '+JSON.stringify(goal.title))
}
async function main(){
 let f=fixture()
 try{
  const r=await f.run(setup);eq(r.ok,true);eq(f.env.rows.goals.length,1);eq(f.env.rows.tasks.length,2);eq(f.writeCalls(),3);eq(r.futureTasks,2)
  eq(f.calls.some(c=>/applyAdjustment|startAdjustment|stepAdjustment|taskCheckin/.test(c.action)),false)
  const repeated=await f.run(setup);eq(repeated.ok,false);eq(f.writeCalls(),3)
 }finally{f.close()}
 f=fixture()
 try{
  // Reproduce the actual partial-write defect, rather than giving every mocked
  // native response code:0 and masking the old endpoint's real contract.
  const broken=setup.replace(fixedGuard,'if (!r || r.code !== 0 || r.success === false)')
  const result=await f.run(broken);eq(result.ok,false);eq(result.stage,'before_goal');eq(f.env.rows.goals.length,1);eq(f.env.rows.tasks.length,0)
  const original=structuredClone(f.env.rows.goals[0]),script=recoveryFor(original),r=await f.run(script)
  const { task_activity_version, ...unchangedGoal } = f.env.rows.goals[0]
  eq(r.ok,true);eq(r.createdGoals,0);eq(r.createdTasks,2);eq(r.futureTasks,2);eq(f.env.rows.goals.length,1);eq(f.env.rows.tasks.length,2);eq(unchangedGoal,original);eq(task_activity_version,2);eq(f.env.rows.tasks.every(t=>t.goal_id===original._id&&t.completed===false&&t.estimated_minutes===20&&t.xp_reward===10),true)
  const writes=f.writeCalls();eq((await f.run(script)).ok,false);eq(f.writeCalls(),writes)
 }finally{f.close()}
 for(const failure of ['storageFail','foreignIdentity']){
  f=fixture();try{f.state[failure]=true;eq((await f.run(setup)).ok,false);eq(f.writeCalls(),0)}finally{f.close()}
 }
 f=fixture();try{
  await f.run(setup.replace(fixedGuard,'if (!r || r.code !== 0 || r.success === false)'))
  const script=recoveryFor(f.env.rows.goals[0]);f.state.storageFail=true
  eq((await f.run(script)).ok,false);eq(f.env.rows.tasks.length,0)
 }finally{f.close()}
 f=fixture();try{
  await f.run(setup.replace(fixedGuard,'if (!r || r.code !== 0 || r.success === false)'))
  const script=recoveryFor(f.env.rows.goals[0]);f.state.loseTaskResponse=true
  eq((await f.run(script)).ok,false);eq(f.env.rows.goals.length,1);eq(f.env.rows.tasks.length,1)
  const writes=f.writeCalls();eq((await f.run(script)).ok,false);eq(f.writeCalls(),writes)
 }finally{f.close()}
 console.log('adjustment-manual-scripts: '+checks+' assertions passed (actual native handler contracts/SDK offline; no cloud writes)')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={fixture}
