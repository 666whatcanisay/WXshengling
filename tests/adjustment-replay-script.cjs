const fs=require('node:fs'),assert=require('node:assert/strict'),{fixture}=require('./adjustment-manual-scripts.cjs')
const {createService}=require('../cloudfunctions/app/lib/adjustmentService'),{createService:createCoach}=require('../cloudfunctions/app/lib/coachService'),{createAdjustmentGraph}=require('../cloudfunctions/app/lib/stewardGraph.cjs'),dates=require('../cloudfunctions/app/lib/taskRules')
const setup=fs.readFileSync(require.resolve('../tools/adjustment-apply-manual-setup.js'),'utf8'),replay=fs.readFileSync(require.resolve('../tools/adjustment-apply-manual-replay.js'),'utf8')
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++}
async function prepared(apply=true){
 const f=fixture();assert.equal((await f.run(setup)).ok,true)
 const goal=f.env.rows.goals[0],tasks=f.env.rows.tasks,today=dates.businessDate();let models=0
 const service=createService({cloud:f.env.cloud,coach:createCoach({cloud:f.env.cloud}),graphFactory:createAdjustmentGraph,loadModel:async()=>({provider:'deepseek',model:'deepseek-chat'}),callModel:async(_,messages)=>{models++;return JSON.stringify(messages[0].content.includes('调整规划师')?{changes:tasks.map(t=>({task_id:t._id,title:t.title.replace('20','10'),date:t.date,estimated_minutes:10,reason:'本轮明确要求'}))}:{summary:'按明确预算检查',findings:[]})}})
 const input={goal_id:goal._id,date:today},w=await service.get('owner',input)
 let run=(await service.start('owner',{...input,request_id:'test-start',fingerprint:w.fingerprint,instructions:'每日10分钟',daily_minutes:10})).run
 for(let i=0;run.status==='ready'&&i<7;i++)run=(await service.step('owner',{run_id:run.id,request_id:'step'+i})).run
 const request={run_id:run.id,expected_revision:run.revision,confirmation:run.confirmation}
 if(apply)await service.apply('owner',request)
 const script=replay.replace("'10f29c566aede179000384776d3f22e2'",JSON.stringify(goal._id)).replace("'[联调] 确认应用-mw526pzz'",JSON.stringify(goal.title)).replace("['76dc6f266aede45a0003e3dd0ddbc28f', '3946422f6aede45a0008ba2e43f78402']",JSON.stringify(tasks.map(t=>t._id)))
 return {...f,script,service,request,models:()=>models,replayCount:()=>f.calls.filter(c=>c.action==='applyAdjustment').length}
}
async function main(){
 let f=await prepared()
 try{const before=structuredClone(f.env.rows),r=await f.run(f.script);eq(r.ok,true);eq(r.replayCached,true);eq(r.sameReceipt,true);eq(r.appliedTasks,2);eq(r.tasksUnchangedByReplay,true);eq(r.goalUnchangedByReplay,true);eq(f.replayCount(),1);eq(f.env.rows,before);eq(f.models(),2);eq((await f.run(f.script)).ok,false);eq(f.replayCount(),1)}finally{f.close()}
 f=await prepared(false);try{eq((await f.run(f.script)).ok,false);eq(f.replayCount(),0);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20]);eq(f.models(),2)}finally{f.close()}
 for(const kind of ['storageFail','foreignIdentity']){f=await prepared();try{f.state[kind]=true;eq((await f.run(f.script)).ok,false);eq(f.replayCount(),0)}finally{f.close()}}
 f=await prepared();try{f.state.loseApplyResponse=true;const r=await f.run(f.script);eq(r.ok,false);eq(r.replaySent,true);eq(f.replayCount(),1);eq((await f.run(f.script)).ok,false);eq(f.replayCount(),1);eq((await f.service.applicationStatus('owner',f.request)).application.count,2)}finally{f.close()}
 console.log('adjustment-replay-script: '+checks+' assertions passed (actual native handlers/SDK/LangGraph offline; no real cloud/model)')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={prepared}
