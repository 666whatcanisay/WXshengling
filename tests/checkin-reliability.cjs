// Actual production handlers + installed wx-server-sdk, with an offline wire transport.
// This exercises SDK serialization/retry; it is not a real cloud database test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs');
const root = path.resolve(__dirname, '..');
const appFile = path.join(root, 'cloudfunctions/app/index.js');
const appRequire = createRequire(appFile);
const quiet = { log() {}, warn() {}, error() {} };
let checks = 0, cases = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const task = (id, xp = 10) => ({ _id: id, _openid: 'owner', completed: false, xp_reward: xp, title: id });
const seed = (tasks = [task('t')], pool = []) => ({
  users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }], tasks, user_growth_pool: pool, growth_logs: [],
});
const source = process.argv[2] === '--source-ref'
  ? execFileSync('git', ['show', process.argv[3] + ':cloudfunctions/app/index.js'], { cwd: root, encoding: 'utf8' })
  : process.argv[2] === '--source-file' ? fs.readFileSync(path.resolve(process.argv[3]), 'utf8')
  : fs.readFileSync(appFile, 'utf8');
function contextFor(env) {
  const context = vm.createContext({
    require(name) {
      if (name === 'wx-server-sdk') return env.cloud;
      if (name === 'https') return { request() { throw new Error('Network disabled'); } };
      return appRequire(name);
    }, exports: {}, console: quiet, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: appFile });
  return {
    call: (name, data = {}, openid = 'owner') => vm.runInContext(name, context)(openid, structuredClone(data)),
    route: event => context.exports.main(event),
  };
}
async function scenario(data, hooks, run) {
  const env = offlineCloudbase(data, hooks);
  try { await run(env, contextFor(env)); cases++; } finally { env.close(); }
}
function balances(env, xp, logs, poolCount = 1) {
  eq(env.rows.users[0].total_xp, xp, 'user XP');
  eq(env.rows.growth_logs.length, logs, 'growth log count');
  eq(env.rows.user_growth_pool.length, poolCount, 'one pool per user');
  if (poolCount) {
    eq(env.rows.user_growth_pool[0].growth_pool, xp, 'pool balance');
    eq(env.rows.user_growth_pool[0].total_earned, xp, 'pool lifetime earnings');
  }
}
async function rejects(promise, regex) { await assert.rejects(promise, regex); checks++; }

(async () => {
  await scenario({ users: [
    { _id: 'a', _openid: 'admin', username: 'lzk', role: 'admin' },
    { _id: 'u', _openid: 'owner', role: 'user' },
  ] }, {}, async (env, api) => {
    eq(await api.call('checkAdmin', {}, 'admin'), true);
    for (const id of ['owner', 'stranger', '']) eq(await api.call('checkAdmin', {}, id), false);
    // Every admin action must reject even if the client supplies admin identity/role.
    const actions = [...source.matchAll(/case "(admin\w+)"/g)].map(m => m[1]);
    eq(actions.length, 14);
    for (const action of actions) {
      const result = await api.route({ action, openid: 'admin', data: { openid: 'admin', _openid: 'admin', role: 'admin' } });
      eq(result.code, -1, action + ' must use trusted caller identity');
    }
    env.cloud.getWXContext = () => ({});
    eq((await api.route({ action: 'adminDashboard', data: { openid: 'admin' } })).code, -1);
  });
  await scenario(seed(), { beforeRequest(cmd, args) {
    if (cmd === 'database.getDocument' && args.collectionName === 'users') throw new Error('READ_FAILED');
  } }, async (env, api) => { eq(await api.call('checkAdmin'), false, 'admin query failure denies'); });

  await scenario(seed(), {}, async (env, api) => {
    const r = await api.call('taskCheckin', { task_id: 't' });
    eq(r.success, true); eq(r.xp_earned, 10); balances(env, 10, 1);
    eq(env.rows.growth_logs[0]._id, 'checkin-log:t', 'SDK must receive deterministic log ID');
    eq(env.rows.user_growth_pool[0]._id, 'pool:owner', 'SDK must receive deterministic pool ID');
    const dup = await api.call('taskCheckin', { task_id: 't' });
    eq(dup.already_completed, true); eq(dup.xp_earned, 0); balances(env, 10, 1);
  });
  await scenario(seed(), {}, async (env, api) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => api.call('taskCheckin', { task_id: 't' })));
    eq(results.filter(r => r.success && !r.already_completed).length, 1);
    eq(results.filter(r => r.already_completed).length, 19);
    eq(env.stats.conflicts > 0, true, 'optimistic transactions must actually overlap');
    balances(env, 10, 1);
  });
  for (const existing of [[], [{ _id: 'legacy-random', _openid: 'owner', growth_pool: 0, total_earned: 0 }]]) {
    await scenario(seed([task('a'), task('b', 15)], existing), {}, async (env, api) => {
      const results = await Promise.all(['a', 'b'].map(task_id => api.call('taskCheckin', { task_id })));
      eq(results.every(r => r.success && !r.already_completed), true);
      eq(env.rows.tasks.every(t => t.completed), true);
      balances(env, 25, 2);
      eq(env.stats.conflicts > 0, true);
      eq(env.rows.user_growth_pool[0]._id, existing.length ? 'legacy-random' : 'pool:owner');
    });
  }
  let injected = false;
  await scenario(seed(), { commitConflict() { if (!injected) { injected = true; return true; } return false; } }, async (env, api) => {
    eq((await api.call('taskCheckin', { task_id: 't' })).success, true);
    eq(env.stats.starts, 2, 'installed SDK retries commit conflict'); balances(env, 10, 1);
  });
  await scenario(seed(), { commitConflict: () => true }, async (env, api) => {
    await rejects(api.call('taskCheckin', { task_id: 't' }), error => error.code === 'DATABASE_TRANSACTION_CONFLICT');
    eq(env.stats.starts, 4, 'default SDK retry limit is bounded');
    eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
  });
  // Fail after each successive core write; retry the SAME task/state, not a reset fixture.
  for (const target of ['users', 'growth_logs', 'user_growth_pool']) {
    let fail = true;
    await scenario(seed(), { beforeRequest(cmd, args) {
      if (fail && args.transactionId && args.collectionName === target && ['database.modifyDocument', 'database.insertDocument'].includes(cmd)) {
        fail = false; throw new Error('INJECTED_' + target);
      }
    } }, async (env, api) => {
      await rejects(api.call('taskCheckin', { task_id: 't' }), /INJECTED_/);
      eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
      eq((await api.call('taskCheckin', { task_id: 't' })).success, true); balances(env, 10, 1);
    });
  }
  for (const name of ['users', 'user_growth_pool']) {
    await scenario(seed(), { beforeRequest(cmd, args) {
      if (!args.transactionId && cmd === 'database.getDocument' && args.collectionName === name) throw new Error('READ_FAILED');
    } }, async (env, api) => {
      await rejects(api.call('taskCheckin', { task_id: 't' }), /READ_FAILED/);
      eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
    });
  }
  await scenario(seed(), { beforeRequest(cmd, args) {
    if (cmd === 'database.modifyDocument' && args.collectionName === 'users') return { data: { updated: 0 } };
  } }, async (env, api) => {
    await rejects(api.call('taskCheckin', { task_id: 't' }), /users/);
    eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
  });
  // Old SDK wraps a document-operation conflict and drops its raw code. It must
  // still roll back and permit a later request; don't assume automatic retry.
  let failWrite = true;
  await scenario(seed(), { beforeRequest(cmd, args) {
    if (failWrite && cmd === 'database.modifyDocument' && args.collectionName === 'users') {
      failWrite = false;
      return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'database transaction conflict' };
    }
  } }, async (env, api) => {
    await rejects(api.call('taskCheckin', { task_id: 't' }), /transaction conflict/);
    eq(env.stats.starts, 1, 'wx wrapper does not preserve this operation conflict code');
    eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
    eq((await api.call('taskCheckin', { task_id: 't' })).success, true); balances(env, 10, 1);
  });
  await scenario({ ...seed(), growth_logs: [{ _id: 'checkin-log:t', xp_change: 10 }] }, {}, async (env, api) => {
    await rejects(api.call('taskCheckin', { task_id: 't' }), /duplicate/);
    eq(env.rows.tasks[0].completed, false); eq(env.rows.users[0].total_xp, 0);
    eq(env.rows.growth_logs.length, 1); eq(env.rows.user_growth_pool.length, 0);
  });
  for (const name of ['users', 'user_growth_pool']) {
    const data = seed([task('t')], [{ _id: 'legacy', _openid: 'owner', growth_pool: 0, total_earned: 0 }]);
    await scenario(data, { beforeRequest(cmd, args, state) {
      if (cmd === 'database.startTransaction') state.mutate(name, name === 'users' ? 'u' : 'legacy', { _openid: 'other' });
    } }, async (env, api) => {
      await rejects(api.call('taskCheckin', { task_id: 't' }), /记录已变更/);
      eq(env.rows.tasks[0].completed, false); balances(env, 0, 0);
    });
  }
  await scenario(seed(), { beforeRequest(cmd, args, state) {
    if (cmd === 'database.startTransaction') state.mutate('tasks', 't', { xp_reward: 25 });
  } }, async (env, api) => {
    eq((await api.call('taskCheckin', { task_id: 't' })).xp_earned, 25); balances(env, 25, 1);
  });
  for (const changed of [
    { users: [] },
    { users: [{ _id: 'u', _openid: 'owner' }, { _id: 'u2', _openid: 'owner' }] },
    { user_growth_pool: [{ _id: 'p1', _openid: 'owner' }, { _id: 'p2', _openid: 'owner' }] },
  ]) {
    await scenario({ ...seed(), ...changed }, {}, async (env, api) => {
      eq((await api.call('taskCheckin', { task_id: 't' })).code, -1);
      eq(env.rows.tasks[0].completed, false); eq(env.rows.growth_logs.length, 0);
    });
  }
  for (const patch of [{ _openid: 'other' }, { date: '2030-01-01' }]) {
    let changed = false;
    await scenario(seed(), { beforeRequest(cmd, args, state) {
      if (!changed && cmd === 'database.startTransaction') { changed = true; state.mutate('tasks', 't', patch); }
    } }, async (env, api) => {
      eq((await api.call('taskCheckin', { task_id: 't' })).code, -1);
      eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
    });
  }
  await scenario(seed(), {}, async (env, api) => {
    eq((await api.call('taskCheckin', { task_id: 'missing' })).code, -1);
    eq((await api.call('taskCheckin', { task_id: 't' }, '')).code, -1);
    eq((await api.call('taskCheckin', { task_id: 't' }, 'other')).code, -1);
    eq(env.rows.tasks[0].completed, false); balances(env, 0, 0, 0);
  });

  // Exercise page methods, preserving existing first-checkin pet behavior.
  for (const [file, method, expectedFirstHatch] of [
    ['home', 'quickCheckin', 1], ['record', 'completeTask', 0],
    ['goals', 'toggleTodayTask', 1], ['goal-detail', 'checkinTask', 0],
  ]) {
    for (const response of [{ success: true, already_completed: true, xp_earned: 0 }, { success: true, xp_earned: 0 }, { success: true, xp_earned: 10 }]) {
      let page, hatches = 0;
      const toasts = [];
      const pageFile = path.join(root, 'miniprogram/pages', file, file + '.js');
      const localRequire = createRequire(pageFile);
      const api = { taskCheckin: async () => response, hatchProgress: async () => { hatches++; } };
      const context = vm.createContext({
        Page(value) { page = value; }, require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
        getApp: () => ({ globalData: {} }),
        wx: new Proxy({}, { get: (_, key) => key === 'showToast' ? value => toasts.push(value.title) : () => {} }),
        console: quiet, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
      });
      vm.runInContext(fs.readFileSync(pageFile, 'utf8'), context);
      page.data = JSON.parse(JSON.stringify(page.data));
      page.setData = patch => Object.assign(page.data, patch);
      const entry = { id: 't', completed: false, xp_reward: 99 };
      Object.assign(page.data, { tasks: [entry], todayTasks: [entry], todayGrowth: { xp: 0 }, selectedDate: '2026-01-01', goals: [{ id: 'g', todayTasks: [{ id: 't', done: false }] }] });
      await page[method]({ currentTarget: { dataset: { id: 't', taskid: 't', goalid: 'g' } } });
      const awarded = !response.already_completed && response.xp_earned > 0;
      eq(hatches, awarded ? expectedFirstHatch : 0, file + ' pet side effects');
      if (file === 'home') eq(page.data.todayGrowth.xp, response.xp_earned);
      if (file === 'record') eq(page.data.checkinResult.xp_added, response.xp_earned);
      if (file === 'goal-detail') eq(page.data.result && page.data.result.xp_added, response.already_completed ? null : response.xp_earned);
      eq(toasts.some(t => /99XP|失败/.test(t)), false, file + ' must not display fallback XP or swallow page errors');
    }
  }
  console.log(JSON.stringify({ passed: checks, scenarios: cases, failed: 0, scope: 'Production handlers/pages + installed wx-server-sdk 2.4.0 and its transaction retry; offline optimistic wire transport, no real cloud validation' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
