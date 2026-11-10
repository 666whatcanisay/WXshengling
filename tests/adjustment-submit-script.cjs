const fs=require('node:fs'),assert=require('node:assert/strict'),{prepared}=require('./adjustment-replay-script.cjs'),dates=require('../cloudfunctions/app/lib/taskRules')
const source=fs.readFileSync(require.resolve('../tools/adjustment-apply-manual-submit.js'),'utf8')
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++}
function script(f,request=f.request){const g=f.env.rows.goals[0];return source.replace("'10f29c566aede179000384776d3f22e2'",JSON.stringify(g._id)).replace("'[联调] 确认应用-mw526pzz'",JSON.stringify(g.title)).replace("['76dc6f266aede45a0003e3dd0ddbc28f', '3946422f6aede45a0008ba2e43f78402']",JSON.stringify(f.env.rows.tasks.map(t=>t._id))).replace(/const expectedRequest = .*/, 'const expectedRequest = '+JSON.stringify(request)).replace("'2026-11-06' // The original confirmed run date",JSON.stringify(dates.businessDate())+' // The original confirmed run date')}
async function main(){
 let f=await prepared(false)
 try{const users=structuredClone(f.env.rows.users),s=script(f),r=await f.run(s);eq(r.ok,true);eq(r.applicationSent,true);eq(r.replayCached,true);eq(r.sameReceipt,true);eq(r.appliedTasks,2);eq(f.replayCount(),2);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[10,10]);eq(f.env.rows.tasks.map(t=>t.xp_reward),[10,10]);eq(f.env.rows.users,users);eq(f.models(),2);eq((await f.run(s)).ok,false);eq(f.replayCount(),2);eq((await f.run(f.script)).ok,false);eq(f.replayCount(),2)}finally{f.close()}
 f=await prepared(true);try{const before=structuredClone(f.env.rows),r=await f.run(script(f));eq(r.ok,true);eq(r.applicationSent,false);eq(f.replayCount(),1);eq(f.env.rows,before)}finally{f.close()}
 f=await prepared(false);try{const r=await f.run(script(f,{...f.request,confirmation:'0'.repeat(64)}));eq(r.ok,false);eq(r.applicationSent,false);eq(f.replayCount(),0);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20])}finally{f.close()}
 f=await prepared(false);try{f.state.storageFail=true;eq((await f.run(script(f))).ok,false);eq(f.replayCount(),0);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[20,20])}finally{f.close()}
 f=await prepared(false);try{f.state.loseApplyResponse=true;const s=script(f),r=await f.run(s);eq(r.ok,false);eq(r.applicationSent,true);eq(r.replaySent,false);eq(f.env.rows.tasks.map(t=>t.estimated_minutes),[10,10]);eq((await f.run(s)).ok,false);eq(f.replayCount(),1);f.state.loseApplyResponse=false;eq((await f.run(f.script)).ok,true);eq(f.replayCount(),2);eq(f.models(),2)}finally{f.close()}
 console.log('adjustment-submit-script: '+checks+' assertions passed (actual native handlers/SDK/LangGraph offline; no real cloud/model)')
}
main().catch(e=>{console.error(e);process.exitCode=1})
