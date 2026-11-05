// Exact-ID cleanup through the installed SDK and offline wire transport.
// Covers rollback, ownership, unrelated activity, retries and absent/new pools.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs');
const { createManifest, runCleanup } = require('../tools/lib/node24-business-test.cjs');
const appFile = path.resolve(__dirname, '../cloudfunctions/app/index.js'), appRequire = createRequire(appFile);
const { createPublisher } = appRequire('./lib/planPublication');
let checks = 0, scenarios = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const reject = async (promise, pattern) => { await assert.rejects(promise, pattern); checks++; };
const user = () => ({ _id: 'user-a', _openid: 'owner', username: 'lzk', role: 'admin', total_xp: 100, nickname: '保留' });
const pool = () => ({ _id: 'legacy-pool', _openid: 'owner', growth_pool: 50, total_earned: 200, backpack: { keep: 1 } });
async function scenario(options, run) {
  const initialUser = user(), initialPool = options.noPool ? undefined : pool();
  const m = createManifest(initialUser, initialPool);
  const other = { _id: 'unrelated', _openid: 'other', title: '保留' };
  const env = offlineCloudbase({ users: [initialUser], user_growth_pool: initialPool ? [initialPool] : [],
    goals: [other], tasks: [], growth_logs: [], ai_plans: [] }, options.hooks || {});
  const db = env.cloud.database({ throwOnNotFound: false })._db;
  const publish = createPublisher(env.cloud);
  const context = vm.createContext({ exports: {}, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => name === 'wx-server-sdk' ? env.cloud : name === 'https'
      ? { request() { throw new Error('Network disabled'); } } : appRequire(name) });
  vm.runInContext(fs.readFileSync(appFile, 'utf8'), context);
  const checkin = id => context.exports.main({ action: 'taskCheckin', data: { task_id: id } });
  try {
    if (!options.empty) await publish(m.owner, m.request);
    for (let i = 0; i < (options.completed ?? 2); i++) eq((await checkin(m.taskIds[i])).success, true);
    await run({ env, db, m, publish }); scenarios++;
  } finally { env.close(); }
}
(async () => {
  await scenario({}, async ({ env, db, m, publish }) => {
    const before = structuredClone(env.rows);
    const preview = await runCleanup(db, m);
    eq(preview.reversedXp, 30); eq(preview.removed, 6); eq(env.rows, before);
    const results = await Promise.all([runCleanup(db, m, true), runCleanup(db, m, true)]);
    eq(results.filter(r => r.alreadyCleaned).length, 1);
    eq(env.rows.users[0].total_xp, 100); eq(env.rows.users[0].nickname, '保留');
    eq(env.rows.user_growth_pool[0].growth_pool, 50); eq(env.rows.user_growth_pool[0].total_earned, 200);
    eq(env.rows.user_growth_pool[0].backpack, { keep: 1 }); eq(env.rows.goals.map(g => g._id), ['unrelated']);
    eq(env.rows.tasks.length, 0); eq(env.rows.growth_logs.length, 0);
    eq(env.rows.ai_plans[0].status, 'publication_cleaned'); eq(env.rows.ai_plans[0].draft, null);
    await reject(publish(m.owner, m.request), /状态/);
    env.mutate('users', m.userId, { total_xp: 777 });
    eq((await runCleanup(db, m, true)).alreadyCleaned, true); eq(env.rows.users[0].total_xp, 777);
  });
  await scenario({ completed: 1 }, async ({ env, db, m }) => {
    eq((await runCleanup(db, m, true)).reversedXp, 10);
    eq(env.rows.users[0].total_xp, 100); eq(env.rows.growth_logs.length, 0);
  });
  await scenario({ noPool: true }, async ({ env, db, m }) => {
    eq((await runCleanup(db, m, true)).removed, 7);
    eq(env.rows.user_growth_pool.length, 0); eq(env.rows.users[0].total_xp, 100);
  });
  await scenario({ completed: 0 }, async ({ env, db, m }) => {
    eq((await runCleanup(db, m, true)).reversedXp, 0); eq(env.rows.user_growth_pool[0], pool());
  });
  for (const corrupt of [
    (env, m) => env.mutate('tasks', m.taskIds[0], { _openid: 'other' }),
    (env, m) => env.mutate('tasks', m.taskIds[0], { xp_reward: 999 }),
    (env, m) => env.mutate('tasks', m.taskIds[2], { completed: true }),
    (env, m) => env.mutate('users', m.userId, { total_xp: 131 }),
    (env, m) => env.mutate('user_growth_pool', m.poolId, { growth_pool: 81 }),
    (env, m) => env.mutate('user_growth_pool', m.poolId, { total_earned: 231 }),
    (env, m) => env.mutate('ai_plans', m.publicationId, { fingerprint: 'wrong' }),
  ]) await scenario({}, async ({ env, db, m }) => {
    corrupt(env, m); const snapshot = structuredClone(env.rows);
    await reject(runCleanup(db, m, true), /./); eq(env.rows, snapshot);
  });
  let failDelete = true;
  await scenario({ hooks: { beforeRequest(command) {
    if (failDelete && command === 'database.removeDocument') return { code: 'TEST_FAILURE', message: 'delete failed' };
  } } }, async ({ env, db, m }) => {
    const before = structuredClone(env.rows);
    await reject(runCleanup(db, m, true), /Delete failed/); eq(env.rows, before);
    failDelete = false; eq((await runCleanup(db, m, true)).reversedXp, 30); eq(env.rows.users[0].total_xp, 100);
  });
  let interfere = true;
  await scenario({ hooks: { beforeRequest(command, args, { mutate }) {
    if (interfere && command === 'database.removeDocument') {
      interfere = false; mutate('users', 'user-a', { total_xp: 999 });
    }
  } } }, async ({ env, db, m }) => {
    await reject(runCleanup(db, m, true), /unrelated changes/);
    eq(env.rows.tasks.length, 3); eq(env.rows.growth_logs.length, 2); eq(env.rows.users[0].total_xp, 999);
  });
  await scenario({ empty: true, completed: 0 }, async ({ env, db, m }) => {
    const before = structuredClone(env.rows);
    eq((await runCleanup(db, m, true)).noTestData, true); eq(env.rows, before);
  });
  console.log(JSON.stringify({ scenarios, assertions: checks, cloudWrites: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
