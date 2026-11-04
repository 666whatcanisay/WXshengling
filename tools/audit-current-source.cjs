const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');
const { createRequire } = require('module');

// Read and execute the current source with an in-memory database; never connects to CloudBase.
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cloudfunctions/app/index.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
let collections = {};
let idCounter = 0;
const op = (kind, value) => ({ __auditOp: kind, value });
function matches(row, filter) {
  return Object.entries(filter || {}).every(([key, value]) => {
    if (value && value.__auditOp === 'neq') return row[key] !== value.value;
    if (value && value.__auditOp === 'eq') return row[key] === value.value;
    if (value && value.__auditOp === 'in') return value.value.includes(row[key]);
    return row[key] === value;
  });
}
function query(name, filter = {}) {
  return {
    where(next) { return query(name, next); },
    doc(id) { return query(name, { _id: id }); },
    async get() {
      const rows = copy((collections[name] || []).filter(row => matches(row, filter)));
      return { data: rows };
    },
    async count() { return { total: (collections[name] || []).filter(row => matches(row, filter)).length }; },
    async add({ data }) {
      const row = { _id: `audit_${++idCounter}`, ...copy(data) };
      (collections[name] ||= []).push(row);
      return { _id: row._id };
    },
    async update({ data }) {
      let updated = 0;
      for (const row of collections[name] || []) {
        if (!matches(row, filter)) continue;
        for (const [key, value] of Object.entries(data)) {
          if (value && value.__auditOp === 'inc') row[key] = (row[key] || 0) + value.value;
          else row[key] = copy(value);
        }
        updated++;
      }
      return { updated, stats: { updated } };
    },
    orderBy() { return this; }, limit() { return this; }, skip() { return this; }, field() { return this; },
  };
}
const db = {
  collection: name => query(name),
  async createCollection(name) { collections[name] ||= []; },
  command: { inc: value => op('inc', value), neq: value => op('neq', value), eq: value => op('eq', value), in: value => op('in', value) },
};
let seed = 5;
const auditMath = Object.create(Math);
auditMath.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
const context = vm.createContext({
  require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'audit' }) };
    if (name === 'https') return { request() { throw new Error('Network calls prohibited in local audit'); } };
    if (name === 'crypto') return require('crypto');
    if (name === './lib/taskRules') return require(path.join(root, 'cloudfunctions/app/lib/taskRules'));
    throw new Error(`Unexpected dependency: ${name}`);
  },
  exports: {}, console: { log() {}, warn() {}, error() {} }, Math: auditMath, Date, Buffer, setTimeout, clearTimeout,
});
vm.runInContext(source, context, { filename: 'current-cloudfunctions-app.js' });
const call = (name, data) => { context.auditInput = data; return vm.runInContext(`${name}('audit', auditInput)`, context); };
function reset(data) { collections = copy(data); }
function pet(overrides = {}) {
  return { _id: 'pet', _openid: 'audit', name: '审阅测试宠物', is_hatched: true, growth_value: 100, stage: 'BABY',
    species: 'orange_cat', egg_type: 'forest_egg', talent: 1, experience: 0, level: 1, bond: 50,
    attributes: { vitality: 2, wisdom: 2, luck: 2, resonance: 2 }, ...overrides };
}
function loadPage(relative, api) {
  let definition;
  const pageFile = path.join(root, relative);
  const localRequire = createRequire(pageFile);
  const pageContext = vm.createContext({
    Page(value) { definition = value; },
    require(name) { return name.endsWith('/cloudApi') ? api : localRequire(name); },
    getApp: () => ({ globalData: {}, isOfflineMode: false }),
    wx: new Proxy({}, { get: (_, key) => key === 'getStorageSync' ? () => '' : () => {} }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(pageFile, 'utf8'), pageContext, { filename: relative });
  definition.data = copy(definition.data);
  definition.setData = function(values, callback) { Object.assign(this.data, values); if (callback) callback(); };
  return definition;
}

(async () => {
  const findings = {};
  reset({ users: [{ _id: 'admin', _openid: 'owner', username: 'lzk', role: 'admin' }] });
  findings.adminFallback = { unrelatedCaller: 'audit', accepted: await call('checkAdmin', {}) };
  reset({ users: [{ _id: 'u', _openid: 'audit', total_xp: 0 }],
    tasks: [{ _id: 'task', _openid: 'audit', completed: false, xp_reward: 10 }],
    user_growth_pool: [{ _id: 'pool', _openid: 'audit', growth_pool: 0, total_earned: 0 }] });
  await Promise.all([call('taskCheckin', { task_id: 'task' }), call('taskCheckin', { task_id: 'task' })]);
  findings.concurrentTaskReward = { userXp: collections.users[0].total_xp,
    growthPool: collections.user_growth_pool[0].growth_pool, logs: collections.growth_logs.length };
  reset({ goals: [{ _id: 'goal', _openid: 'audit', completed_days: 0 }], tasks: [] });
  await call('repairGoalDays', { goal_id: 'goal' });
  findings.repairWithoutTasks = { completedDays: collections.goals[0].completed_days };

  // A future task must not prevent today's completed tasks from counting as a completed day.
  // Run the production handler with isolated rows; no CloudBase calls are made.
  const auditDates = require('../cloudfunctions/app/lib/taskRules');
  const auditToday = auditDates.businessDate();
  const auditTomorrow = auditDates.addDays(auditToday, 1);
  reset({ users: [{ _id: 'u', _openid: 'audit', total_xp: 0 }],
    goals: [{ _id: 'goal', _openid: 'audit', completed_days: 0 }],
    tasks: [
      { _id: 'todayTask', _openid: 'audit', goal_id: 'goal', date: auditToday, completed: false, xp_reward: 10 },
      { _id: 'futureTask', _openid: 'audit', goal_id: 'goal', date: auditTomorrow, completed: false, xp_reward: 10 },
    ],
    user_growth_pool: [{ _id: 'pool', _openid: 'audit', growth_pool: 0, total_earned: 0 }] });
  await call('taskCheckin', { task_id: 'todayTask' });
  findings.goalCompletionWithFutureTasks = {
    todayTaskCompleted: collections.tasks[0].completed,
    futureTaskCompleted: collections.tasks[1].completed,
    expectedCompletedDays: 1,
    actualCompletedDays: collections.goals[0].completed_days,
  };

  const observedSpecies = vm.runInContext(`(() => {
    const result = {};
    for (const egg of ['forest_egg','home_egg','wild_egg']) {
      result[egg] = {};
      for (let i=0;i<10000;i++) {
        const p = hatchPetV7(egg); result[egg][p.species]=(result[egg][p.species]||0)+1;
      }
    }
    return result;
  })()`, context);
  findings.hatching = { samplesPerEgg: 10000, observedSpecies };

  findings.buffRewards = {};
  for (const species of ['orange_cat', 'golden_retriever']) {
    reset({ users: [{ _id: 'u', _openid: 'audit', total_xp: 0 }], pets: [pet({ species })] });
    const result = await call('dailyCheckin', {});
    findings.buffRewards[species] = { xp: result.xp_earned, userXp: collections.users[0].total_xp };
  }

  reset({ pets: [pet({ is_hatched: false, growth_value: 0, stage: 'egg' })], user_growth_pool: [{ _id: 'pool', _openid: 'audit', growth_pool: 800 }] });
  const allocation = await call('allocatePool', { pet_id: 'pet', amount: 800 });
  findings.eggOvershoot = { allocated: allocation.allocated, poolRemaining: collections.user_growth_pool[0].growth_pool,
    finalPetGrowth: collections.pets[0].growth_value, finalStage: collections.pets[0].stage };

  reset({ pets: [pet({ experience: 295 })] });
  const interaction = await call('petInteract', { pet_id: 'pet', action: 'feed' });
  const PetConstants = require(path.join(root, 'miniprogram/utils/petConstants.js'));
  findings.stageConflict = { databaseStage: collections.pets[0].stage, growth: collections.pets[0].growth_value,
    experience: collections.pets[0].experience, displayedStage: PetConstants.getPetAppearance(collections.pets[0]).stage,
    stageChanged: interaction.stage_changed };

  findings.talentGrowth = {};
  for (const talent of [1, 100]) {
    reset({ pets: [pet({ talent, growth_value: 299 })], user_growth_pool: [{ _id: 'pool', _openid: 'audit', growth_pool: 1 }] });
    seed = 77;
    const result = await call('allocatePool', { pet_id: 'pet', amount: 1 });
    findings.talentGrowth[talent] = { bonus: result.attr_bonus, finalAttributes: collections.pets[0].attributes };
  }

  reset({ pets: [pet({ growth_value: 299, attributes: { vitality: 10, wisdom: 10, luck: 10, resonance: 10 } })],
    user_growth_pool: [{ _id: 'pool', _openid: 'audit', growth_pool: 1 }] });
  seed = 77;
  await call('allocatePool', { pet_id: 'pet', amount: 1 });
  findings.attributeCap = collections.pets[0].attributes;

  reset({ users: [{ _id: 'u', _openid: 'audit', streak_days: 30 }], checkins: [{ _id: 'c', _openid: 'audit' }] });
  const achievements = await call('listAchievements', {});
  findings.achievementCollection = { actualUserStreak: 30, unlockedNames: achievements.data.map(row => row.name) };

  let capturedGoal;
  const goalsPage = loadPage('miniprogram/pages/goals/goals.js', { async createGoal(data) { capturedGoal=data; } });
  goalsPage.data.formTitle='审阅测试目标'; goalsPage.data.formDays=7;
  await goalsPage.submitGoal();
  findings.goalDuration = { selectedDays: 7, submittedTarget: capturedGoal.target_value ?? null };

  const createdGoals = [], createdTasks = [];
  const aiPage = loadPage('miniprogram/pages/ai/ai.js', {
    async createGoal(data) { createdGoals.push(data); return { id: 'testgoal' }; },
    async createTask(data) { createdTasks.push(data); return { id: 'testtask' }; },
  });
  aiPage._updatePlannerState({generatedTasks:[{title:'第一天阅读',xp_reward:10,stage:1,estimated_minutes:15,day_index:1},{title:'第七天总结',xp_reward:20,stage:2,estimated_minutes:20,day_index:7}],generatedGoal:{title:'7天阅读',period:'7天'}});
  aiPage.data.plannerState.lastPlanId='audit-plan';
  await aiPage.publishPlanTasks();
  findings.aiPublishing = { goal: createdGoals, tasks: createdTasks };

  let deductionCalls=0;
  const petsPage=loadPage('miniprogram/pages/pets/pets.js', {
    async useBackpackItem() { deductionCalls++; }, async getBackpack() { return []; },
  });
  petsPage.data.backpack=[{name:'普通饲料',count:2}];
  petsPage._consumeItem(0,{name:'普通饲料',count:2});
  petsPage._rollbackItem(0,{name:'普通饲料',count:2});
  await Promise.resolve(); await Promise.resolve();
  findings.itemRollback = { cloudDeductionCalls: deductionCalls, localCountAfterRollback: petsPage.data.backpack[0].count };

  const dirs=['miniprogram/pages','miniprogram/utils','miniprogram/custom-tab-bar','cloudfunctions'];
  function walk(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='node_modules'?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]); }
  const jsFiles=dirs.flatMap(d=>walk(path.join(root,d))).filter(p=>p.endsWith('.js')).concat(path.join(root,'miniprogram/app.js'));
  const syntaxFailures=[];
  for(const file of jsFiles){const result=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0)syntaxFailures.push({file:path.relative(root,file),error:result.stderr});}
  findings.syntax={checkedFiles:jsFiles.length,failures:syntaxFailures};
  const assets=walk(path.join(root,'miniprogram/assets')).filter(f=>/\.(png|jpg|jpeg|webp|gif)$/i.test(f));
  const thumbs=assets.filter(f=>/_thumb\.png$/i.test(f));
  findings.resources={localImages:assets.length,thumbnailImages:thumbs.length,totalImageBytes:assets.reduce((n,f)=>n+fs.statSync(f).size,0)};
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(findings, null, 2) + '\n');
  console.log(JSON.stringify(findings,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
