// Real handlers and installed SDK, with offline wire transport; page restart uses
// a shared storage Map and a fresh production Page instance, not copied logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs');
const root = path.resolve(__dirname, '..');
const appFile = path.join(root, 'cloudfunctions/app/index.js');
const appRequire = createRequire(appFile);
const quiet = { log() {}, warn() {}, error() {} };
let checks = 0, scenarios = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const reject = async (promise, pattern) => { await assert.rejects(promise, pattern); checks++; };
const request = () => ({ publication_id: 'draft-a', source_plan_id: 'source-a',
  goal: { title: '七天阅读', target_days: 7, start_date: '2026-11-04', stages: [{ name: '起步', duration: '第1-7天' }] },
  tasks: [{ title: '阅读', xp_reward: 10, date: '2026-11-04', stage: 1, estimated_minutes: 15 },
    { title: '总结', xp_reward: 20, date: '2026-11-10', stage: 2, estimated_minutes: 20 }] });
const seed = () => ({ goals: [], tasks: [], users: [{ _id: 'user', _openid: 'owner' }], ai_plans: [
  { _id: 'source-a', _openid: 'owner', status: 'done', result: { tasks: [] } },
] });
function backend(env) {
  const context = vm.createContext({
    require: name => name === 'wx-server-sdk' ? env.cloud : name === 'https'
      ? { request() { throw new Error('Network disabled'); } } : appRequire(name),
    exports: {}, console: quiet, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(appFile, 'utf8'), context);
  return {
    call: (input, owner = 'owner') => vm.runInContext('publishAiPlan', context)(owner, structuredClone(input)),
    route: event => context.exports.main(event),
  };
}
async function scenario(hooks, run) {
  const env = offlineCloudbase(seed(), hooks);
  try { await run(env, backend(env)); scenarios++; } finally { env.close(); }
}
function totals(env, goals = 1, tasks = 2) {
  eq(env.rows.goals.length, goals, 'goal count'); eq(env.rows.tasks.length, tasks, 'task count');
}
const records = env => env.rows.ai_plans.filter(p => p.kind === 'plan_publication');
function page(api, storage = new Map(), application = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } }, storageFails = false) {
  const file = path.join(root, 'miniprogram/pages/ai/ai.js'), localRequire = createRequire(file);
  let definition;
  const toasts = [], navigation = [];
  const wx = new Proxy({
    getStorageSync: key => storage.has(key) ? structuredClone(storage.get(key)) : undefined,
    setStorageSync(key, value) { if (storageFails) throw new Error('STORAGE_FULL'); storage.set(key, structuredClone(value)); },
    removeStorageSync: key => storage.delete(key),
    showToast: value => toasts.push(value), navigateTo: value => navigation.push(value),
  }, { get: (obj, key) => key in obj ? obj[key] : () => {} });
  const context = vm.createContext({
    Page(value) { definition = value; }, require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
    getApp: () => application, wx, console: quiet, setTimeout(fn) { fn(); }, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  definition.data = JSON.parse(JSON.stringify(definition.data));
  definition.setData = function(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let obj = this.data;
      for (const part of parts.slice(0, -1)) obj = obj[part];
      obj[parts.at(-1)] = value;
    }
  };
  const draft = request();
  definition._updatePlannerState({ generatedGoal: draft.goal, generatedTasks: draft.tasks, sourcePlanId: draft.source_plan_id });
  definition.setData({ planDays: 7, planStartDate: draft.goal.start_date });
  return { instance: definition, toasts, navigation, storage, application };
}
async function callApi(api, input) {
  const result = await api.call(input);
  if (result.code === -1) throw new Error(result.message);
  return result;
}

(async () => {
  await scenario({}, async (env, api) => {
    const first = await api.route({ action: 'publishAiPlan', data: request(), openid: 'fake' });
    eq(first.success, true); eq(first.created_count, 2); eq(first.already_published, false);
    totals(env); eq(records(env)[0].status, 'publication_done');
    eq(env.rows.goals[0]._openid, 'owner'); eq(env.rows.goals[0].end_date, '2026-11-10');
    eq(env.rows.goals[0].time_zone, 'Asia/Shanghai');
    eq(env.rows.tasks.map(t => [t.date, t.stage, t.estimated_minutes]), [['2026-11-04', 1, 15], ['2026-11-10', 2, 20]]);
    const repeat = await api.call({ ...request(), publication_id: 'new-client-id' });
    eq(repeat.goal_id, first.goal_id, 'same server source across sessions dedupes');
    eq(repeat.already_published, true); totals(env);
    env.mutate('goals', first.goal_id, { status: 'deleted' });
    env.mutate('ai_plans', 'source-a', { status: 'failed' });
    await api.call(request()); eq(env.rows.goals[0].status, 'deleted', 'replay must not resurrect goal'); totals(env);
  });
  await scenario({}, async (env, api) => {
    const result = await Promise.all(Array.from({ length: 20 }, () => api.call(request())));
    eq(result.every(r => r.success), true);
    eq(new Set(result.map(r => r.goal_id)).size, 1); totals(env);
    eq(records(env).length, 1); eq(env.stats.conflicts > 0, true, 'transactions actually overlap');
  });
  for (const target of ['between-transactions', 'goals', 'second-task', 'receipt']) {
    let failed = false, starts = 0, taskWrites = 0;
    await scenario({ beforeRequest(command, args) {
      if (command === 'database.startTransaction') starts++;
      if (command === 'database.insertDocument' && args.collectionName === 'tasks') taskWrites++;
      const hit = target === 'between-transactions' ? command === 'database.startTransaction' && starts === 2
        : target === 'goals' ? command === 'database.insertDocument' && args.collectionName === 'goals'
        : target === 'second-task' ? command === 'database.insertDocument' && args.collectionName === 'tasks' && taskWrites === 2
        : command === 'database.modifyDocument' && args.collectionName === 'ai_plans';
      if (hit && !failed) { failed = true; throw new Error('INJECTED_' + target); }
    } }, async (env, api) => {
      await reject(api.call(request()), /INJECTED_/); totals(env, 0, 0);
      eq(records(env).length, 1); eq(records(env)[0].status, 'publication_pending');
      eq((await api.call(request())).success, true); totals(env);
      eq(records(env)[0].status, 'publication_done');
    });
  }
  let forceConflict = true;
  await scenario({ commitConflict: stats => stats.commits >= 1 && forceConflict }, async (env, api) => {
    await reject(api.call(request()), e => e.code === 'DATABASE_TRANSACTION_CONFLICT');
    totals(env, 0, 0); eq(records(env)[0].status, 'publication_pending');
    forceConflict = false; eq((await api.call(request())).success, true); totals(env);
  });
  await scenario({}, async (env, api) => {
    await api.call(request());
    const changed = request(); changed.tasks[0].title = 'different';
    await reject(api.call(changed), /恢复原草稿/); totals(env);
    eq(env.rows.tasks[0].title, '阅读');
  });
  for (const edit of [
    r => { r.tasks[1].date = '2026-11-11'; }, r => { r.tasks[0].estimated_minutes = 0; },
    r => { r.tasks[0].xp_reward = -1; }, r => { r.tasks = []; },
    r => { r.tasks = Array.from({ length: 21 }, () => r.tasks[0]); },
    r => { r.goal.target_days = 0; }, r => { r.publication_id = '../bad'; },
  ]) {
    await scenario({}, async (env, api) => {
      const input = request(); edit(input);
      eq((await api.call(input)).code, -1); totals(env, 0, 0); eq(records(env).length, 0);
    });
  }
  await scenario({}, async (env, api) => {
    await reject(api.call(request(), 'other'), /来源计划/); totals(env, 0, 0);
    eq((await api.call(request(), '')).code, -1);
    const template = request(); template.source_plan_id = '';
    const a = await api.call(template), b = await api.call(template, 'other');
    eq(a.goal_id !== b.goal_id, true, 'local request ID must be scoped to caller'); totals(env, 2, 4);
  });
  await scenario({}, async (env, api) => {
    env.mutate('ai_plans', 'source-a', { status: 'pending' });
    await reject(api.call(request()), /来源计划/); totals(env, 0, 0); eq(records(env).length, 0);
    env.mutate('ai_plans', 'source-a', { status: 'done' });
    await api.call(request());
    const result = await api.route({ action: 'aiDoGenerate', data: { plan_id: records(env)[0]._id } });
    eq(result.code, -1); eq(result.message, '发布记录不能用于生成任务');
    eq(records(env)[0].status, 'publication_done');
  });
  let omitUpdate = true;
  await scenario({ beforeRequest(command, args) {
    if (omitUpdate && command === 'database.modifyDocument' && args.collectionName === 'ai_plans') return { data: { updated: 0 } };
  } }, async (env, api) => {
    await reject(api.call(request()), /发布结果未保存/); totals(env, 0, 0);
    eq(records(env)[0].status, 'publication_pending');
    omitUpdate = false; eq((await api.call(request())).success, true); totals(env);
  });
  await scenario({}, async (env, api) => {
    const input = request(); input.tasks = Array.from({ length: 20 }, (_, index) => ({ ...input.tasks[0], title: 'Task ' + index }));
    eq((await api.call(input)).created_count, 20); totals(env, 1, 20);
  });
  await scenario({}, async (env, api) => {
    let calls = 0;
    const storage = new Map();
    const cloudApi = { async publishAiPlan(input) {
      calls++; const result = await callApi(api, input);
      if (calls === 1) throw new Error('NETWORK_RESPONSE_LOST');
      return result;
    } };
    const first = page(cloudApi, storage);
    await first.instance.publishPlanTasks(); totals(env);
    eq(storage.size, 1); eq(first.instance.data.publicationPending, true);
    eq(first.toasts.some(t => t.icon === 'success'), false, 'lost response must not claim success');
    const snapshot = JSON.stringify(first.instance.data.editableTasks);
    first.instance.deletePlanTask({ currentTarget: { dataset: { index: 0 } } });
    eq(JSON.stringify(first.instance.data.editableTasks), snapshot, 'submitted draft is immutable');
    first.instance.closePlanModal(); eq(first.instance.data.showPlanModal, false);
    const restarted = page(cloudApi, storage);
    eq(restarted.instance._restorePendingPublication(), true); eq(restarted.instance.data.showPlanModal, true);
    await restarted.instance.publishPlanTasks(); totals(env);
    eq(storage.size, 0); eq(restarted.instance.data.publicationPending, false);
    eq(restarted.navigation.length, 1); eq(restarted.toasts.at(-1).title, '已确认此前发布成功');
  });
  await scenario({}, async (env, api) => {
    const storage = new Map();
    const first = page({ publishAiPlan: async () => { throw new Error('OFFLINE'); } }, storage);
    await first.instance.publishPlanTasks(); totals(env, 0, 0); eq(storage.size, 1);
    const restarted = page({ publishAiPlan: input => callApi(api, input) }, storage);
    restarted.instance._restorePendingPublication();
    await restarted.instance.publishPlanTasks(); totals(env); eq(storage.size, 0);
  });
  await scenario({}, async (env, api) => {
    let release, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const test = page({ async publishAiPlan(input) { calls++; await gate; return callApi(api, input); } });
    const first = test.instance.publishPlanTasks();
    test.instance.closePlanModal();
    await test.instance.publishPlanTasks(); eq(calls, 1, 'closing modal must not unlock in-flight publication');
    release(); await first; totals(env);
  });
  await scenario({}, async (env, api) => {
    let called = false;
    const test = page({ publishAiPlan: async () => { called = true; } }, new Map(), undefined, true);
    await test.instance.publishPlanTasks(); eq(called, false); totals(env, 0, 0);
    eq(test.toasts.at(-1).title, 'STORAGE_FULL');
  });
  await scenario({}, async (env, api) => {
    const test = page({ publishAiPlan: async () => { throw new Error('OFFLINE'); } });
    await test.instance.publishPlanTasks();
    const legacyKey = 'ai_publication_pending_v1:owner';
    const legacy = { version: 1, owner: 'owner', request: request() };
    test.storage.set(legacyKey, legacy);
    test.application.globalData.userInfo = { id: 'recreated-account' };
    eq(test.instance._restorePendingPublication(), false); eq(test.instance.data.publicationPending, false);
    eq(test.instance.data.plannerState.generatedGoal, null);
    eq(test.storage.size, 2, 'both original and unattributed records remain on device');
    eq(test.storage.get(legacyKey), legacy);
    test.application.globalData.userInfo = { id: 'account' };
    eq(test.instance._restorePendingPublication(), true);
    eq(test.instance.data.plannerState.generatedGoal.title, request().goal.title);
  });
  await scenario({}, async (env, api) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const test = page({ async publishAiPlan(input) { await gate; return callApi(api, input); } });
    const pending = test.instance.publishPlanTasks();
    test.application.globalData.userInfo = { id: 'recreated-account' };
    test.instance._restorePendingPublication();
    eq(test.instance.data.plannerState.generatedGoal, null, 'switching accounts hides in-flight draft');
    eq(test.instance.data.showPlanModal, false);
    release(); await pending;
    eq(test.navigation.length, 0, 'late result must not navigate another account');
    eq(test.storage.size, 1, 'original account can confirm later');
  });
  await scenario({}, async (env, api) => {
    const test = page({ publishAiPlan: async () => ({}) });
    await test.instance.publishPlanTasks();
    eq(test.storage.size, 1); eq(test.instance.data.publicationPending, true);
    eq(test.toasts.some(t => t.icon === 'success'), false);
    const original = JSON.stringify(test.instance.data.editableTasks);
    test.instance.initPlanChat();
    eq(JSON.parse(JSON.stringify(test.instance.data.editableTasks)), JSON.parse(original), 'starting chat resumes outstanding publication');
    eq(test.instance.data.showPlanModal, true);
  });
  console.log(JSON.stringify({ passed: checks, scenarios, failed: 0,
    scope: 'Production publication handler/page + installed SDK with offline wire transport; no real cloud or phone validation' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
