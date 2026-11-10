const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs');
const { createClock } = require('./helpers/clock.cjs');
const taskRules = require('../cloudfunctions/app/lib/taskRules');

const now = Date.parse('2026-11-08T16:30:00Z');
const date = taskRules.businessDate(now);
const seed = () => ({
  users: [{ _id: 'u', _openid: 'owner', username: 'owner-user', total_xp: 0, role: 'user' }],
  goals: [], checkins: [], tasks: [], pets: [], user_growth_pool: [], growth_logs: [], emotions: [], capsules: [],
});

function fixture(t, initial, hooks, loginEnv = {}) {
  const env = offlineCloudbase(initial, hooks);
  t.after(env.close);
  let fixtureNow = now;
  const fixtureClock = createClock(() => fixtureNow);
  const logs = [];
  const load = name => {
    const file = resolve(__dirname, '../cloudfunctions', name, 'index.js');
    const req = createRequire(file);
    const context = {
      exports: {}, Buffer, URL, Date: fixtureClock.Date, setTimeout, clearTimeout, process: { env: loginEnv },
      console: Object.fromEntries(['log', 'warn', 'error'].map(method => [method, (...args) => logs.push(args.map(String).join(' '))])),
      require(name) {
        if (name === 'wx-server-sdk') return env.cloud;
        if (name === './lib/taskRules') return { ...taskRules, businessDate: timestamp => taskRules.businessDate(timestamp ?? now) };
        if (name === './lib/petChat') return { createService: options => req(name).createService({ ...options, now: () => now }) };
        if (name === 'https') return { request() { throw Error('network disabled'); } };
        return req(name);
      },
    };
    runInNewContext(readFileSync(file, 'utf8'), context, { filename: file });
    return context.exports.main;
  };
  const app = load('app');
  const login = load('login');
  return { env, logs, advance: ms => { fixtureNow += ms; },
    app: (action, data, accountId) => app({ action, data, accountId }), login: (action, data) => login({ action, data }) };
}

test('password reset hashes without logging; both legacy formats upgrade on login', async t => {
  const initial = seed();
  const fake = 'offline-password-a';
  const legacy = createHash('sha256').update('forest_camp_salt_' + fake).digest('hex');
  initial.users[0].password = legacy;
  initial.users.push({ _id: 'admin', _openid: 'manager', role: 'admin' });
  const { env, logs, app, login } = fixture(t, initial);
  assert.equal((await login('accountLogin', { username: 'owner-user', password: legacy })).code, -1);
  assert.equal((await login('accountLogin', { username: 'owner-user', password: fake })).code, 0);
  assert.match(env.rows.users[0].password, /^scrypt-v1:/);
  env.mutate('users', 'u', { password: fake });
  assert.equal((await login('accountLogin', { username: 'owner-user', password: fake })).code, 0);
  assert.match(env.rows.users[0].password, /^scrypt-v1:/);
  env.cloud.getWXContext = () => ({ OPENID: 'manager' });
  const next = 'offline-password-b';
  assert.equal((await app('adminResetPassword', { userId: 'u', newPassword: next })).success, true);
  assert.match(env.rows.users[0].password, /^scrypt-v1:/);
  assert.ok(logs.every(line => !line.includes(next) && !line.includes(fake)));
  env.cloud.getWXContext = () => ({ OPENID: 'owner' });
  assert.equal((await login('accountLogin', { username: 'owner-user', password: fake })).code, -1);
  assert.equal((await login('accountLogin', { username: 'owner-user', password: next })).code, 0);
  env.cloud.getWXContext = () => ({ OPENID: 'new-owner' });
  assert.equal((await login('accountRegister', { username: 'new-user', password: next })).code, 0);
  assert.notEqual(env.rows.users.find(user => user._openid === 'new-owner').password, env.rows.users[0].password);
});

test('read-compatible login can roll out before writes are enabled', async t => {
  const initial = seed();
  const oldPassword = 'offline-rollout-password';
  initial.users[0].password = oldPassword;
  initial.users.push({ _id: 'admin', _openid: 'manager', role: 'admin' });
  const { env, app, login } = fixture(t, initial, {}, { FOREST_SCRYPT_WRITE: '0' });
  assert.equal((await login('accountLogin', { username: 'owner-user', password: oldPassword })).code, 0);
  assert.equal(env.rows.users[0].password, oldPassword);
  env.cloud.getWXContext = () => ({ OPENID: 'manager' });
  const next = 'offline-rollout-reset';
  assert.equal((await app('adminResetPassword', { userId: 'u', newPassword: next })).success, true);
  env.cloud.getWXContext = () => ({ OPENID: 'owner' });
  assert.equal((await login('accountLogin', { username: 'owner-user', password: next })).code, 0);
});

test('legacy binding rolls back on failure and settles competing identities once', async t => {
  const initial = seed();
  initial.users.push(
    { _id: 'legacy-1', username: 'legacy-one', password: 'offline-only' },
    { _id: 'legacy-2', username: 'legacy-two', password: 'offline-only' },
    { _id: 'legacy-3', username: 'legacy-three', password: 'offline-only' },
  );
  let fail = true;
  const { env, login } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'account_claims') {
      throw Error('offline identity claim failure');
    }
  } }, { FOREST_SCRYPT_WRITE: '0' });
  const bind = (openid, username) => {
    env.cloud.getWXContext = () => ({ OPENID: openid });
    return login('accountLogin', { username, password: 'offline-only' });
  };
  assert.equal((await bind('wx-a', 'legacy-one')).code, -1);
  assert.equal(env.rows.users[1]._openid, undefined);
  assert.equal(env.rows.users[1].last_login_at, undefined);
  fail = false;
  const competing = await Promise.all([bind('wx-a', 'legacy-one'), bind('wx-b', 'legacy-one')]);
  assert.equal(competing.filter(result => result.code === 0).length, 1);
  assert.equal(env.rows.users[1]._openid, competing.find(result => result.code === 0).data.openid);
  const oneWechat = await Promise.all([bind('wx-c', 'legacy-two'), bind('wx-c', 'legacy-three')]);
  assert.equal(oneWechat.filter(result => result.code === 0).length, 1);
  assert.equal(env.rows.users.filter(user => user._openid === 'wx-c').length, 1);
  assert.equal((await login('login')).data.id, oneWechat.find(result => result.code === 0).data.id);
});

test('registration serializes usernames, WeChat identities and the first administrator', async t => {
  const initial = seed();
  initial.users = [];
  const { env, login } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true }, { FOREST_SCRYPT_WRITE: '0' });
  const callAs = (openid, action, data) => {
    env.cloud.getWXContext = () => ({ OPENID: openid });
    return login(action, data);
  };
  const register = (openid, username) => callAs(openid, 'accountRegister', { username, password: 'offline-only' });
  const wechat = openid => callAs(openid, 'authLogin');
  const first = await Promise.all([register('wx-a', 'first-user'), wechat('wx-b')]);
  assert.ok(first.every(result => result.code === 0));
  assert.equal(env.rows.users.filter(user => user.role === 'admin').length, 1);
  const sameName = await Promise.all([register('wx-c', 'same-name'), register('wx-d', 'same-name')]);
  assert.equal(sameName.filter(result => result.code === 0).length, 1);
  assert.equal(env.rows.users.filter(user => user.username === 'same-name').length, 1);
  const sameWechat = await Promise.all([register('wx-e', 'parallel-name'), wechat('wx-e')]);
  assert.ok(sameWechat.some(result => result.code === 0));
  assert.equal(env.rows.users.filter(user => user._openid === 'wx-e').length, 1);
  const repeated = await Promise.all([wechat('wx-f'), wechat('wx-f')]);
  assert.ok(repeated.every(result => result.code === 0));
  assert.equal(repeated[0].data.id, repeated[1].data.id);
  assert.equal(repeated.filter(result => result.data.is_new).length, 1);
});

test('a ban stops login and existing sessions before reads, writes or profile updates', async t => {
  const initial = seed();
  initial.users[0].password = 'offline-only';
  initial.users.push(
    { _id: 'admin', _openid: 'manager', role: 'admin' },
    { _id: 'unbound', username: 'legacy-unbound', password: 'offline-legacy' },
  );
  const { env, app, login } = fixture(t, initial, { serialTransactions: true });
  env.cloud.getWXContext = () => ({ OPENID: 'manager' });
  assert.equal((await app('adminSetUserStatus', { userId: 'missing', status: 'banned' })).code, -1);
  assert.equal((await app('adminSetUserStatus', { userId: 'admin', status: 'banned' })).code, -1);
  assert.equal((await app('adminSetUserStatus', { userId: 'u', status: 'banned' })).success, true);
  env.cloud.getWXContext = () => ({ OPENID: 'owner' });
  const denied = result => assert.equal(result.reason, 'ACCOUNT_BANNED');
  denied(await login('accountLogin', { username: 'owner-user', password: 'offline-only' }));
  denied(await login('accountLogin', { username: 'legacy-unbound', password: 'offline-legacy' }));
  denied(await login('authLogin', { nickname: 'blocked-change' }));
  denied(await login('login'));
  denied(await app('getDashboard'));
  denied(await app('dailyCheckin', { _openid: 'manager', role: 'admin' }));
  denied(await app('petChatPets'));
  assert.equal(env.rows.users[0].nickname, undefined);
  assert.equal(env.rows.users[0].last_login_at, undefined);
  assert.equal(env.rows.users[2]._openid, undefined);
  assert.equal(env.rows.checkins.length, 0);
  env.cloud.getWXContext = () => ({ OPENID: 'manager' });
  assert.equal((await app('adminSetUserStatus', { userId: 'u', status: 'active' })).success, true);
  env.cloud.getWXContext = () => ({ OPENID: 'owner' });
  assert.equal((await login('login')).code, 0);
  assert.equal((await app('dailyCheckin')).success, true);
});

test('sign-in rolls back failed awards and repeated requests settle once', async t => {
  let fail = true;
  const { env, app } = fixture(t, seed(), { serialTransactions: true, beforeRequest(command, args) {
    if (fail && command === 'database.modifyDocument' && args.collectionName === 'users') throw Error('offline write failure');
  } });
  assert.equal((await app('hatchProgress', { source: 'checkin' })).code, -1);
  assert.equal((await app('dailyCheckin')).code, -1);
  assert.equal(env.rows.checkins.length, 0);
  assert.equal(env.rows.user_growth_pool.length, 0);
  fail = false;
  const replies = await Promise.all([app('dailyCheckin'), app('dailyCheckin')]);
  assert.equal(replies.filter(reply => reply.xp_earned === 10).length, 1);
  assert.equal((await app('dailyCheckin')).already_signed, true);
  assert.equal((await app('hatchProgress', { source: 'checkin' })).already_awarded, true);
  assert.equal(env.rows.users[0].total_xp, 10);
  assert.equal(env.rows.checkins.length, 1);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 5);
  assert.equal((await app('getDashboard')).data.todayGrowth.xp, 10);
});

test('task growth is receipt-backed and an egg can hatch at the existing threshold', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', is_hatched: false, growth_value: 95, attributes: null });
  initial.tasks.push({ _id: 't', _openid: 'owner', title: 'fixture', date, xp_reward: 10 });
  const { env, app } = fixture(t, initial, { serialTransactions: true });
  assert.equal((await app('hatchProgress', { source: 'complete_goal', task_id: 't' })).code, -1);
  assert.equal((await app('taskCheckin', { task_id: 't', pet_growth: true })).xp_earned, 10);
  assert.equal((await app('taskCheckin', { task_id: 't', pet_growth: true })).already_completed, true);
  assert.equal(env.rows.pets[0].is_hatched, true);
  assert.equal(env.rows.pets[0].growth_value, 100);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 10);
  assert.equal(env.rows.user_growth_pool[0].total_earned, 20);
  const before = await app('petChatGet', { pet_id: 'p' });
  assert.equal(before.data.growth.status, 'new');
  assert.equal(before.data.pet.innatePersonality, env.rows.pets[0].personality);
  const first = await app('petChatChange', { pet_id: 'p', action: 'growth_start', generation: 1, from_hatch: true, address: '妈妈' });
  assert.equal(first.data.growth.newborn, true);
  assert.equal(first.data.settings.address, '妈妈');
  assert.equal(first.data.growth.spoken, false);
  assert.equal(env.rows.users[0].total_xp, 10);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 10);
});

test('manual goal and first task commit together and identical retries return the same ID', async t => {
  let fail = true;
  const { env, app } = fixture(t, seed(), { serialTransactions: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'tasks') throw Error('offline write failure');
  } });
  const data = { title: 'fixture', request_id: 'request-1' };
  assert.equal((await app('createGoal', data)).code, -1);
  assert.equal(env.rows.goals.length, 0);
  fail = false;
  const first = await app('createGoal', data);
  const retry = await app('createGoal', data);
  assert.equal(first.success, true);
  assert.equal(retry.id, first.id);
  assert.equal(retry.already_created, true);
  assert.equal((await app('createGoal', { ...data, title: 'changed' })).code, -1);
  assert.equal(env.rows.goals.length, 1);
  assert.equal(env.rows.tasks.length, 1);
  assert.equal(env.rows.tasks[0].goal_id, first.id);
  const scoped = { ...data, start_date: date };
  fail = true;
  assert.equal((await app('createGoalOnce', scoped, 'u')).code, -1);
  assert.equal(env.rows.goals.length, 1);
  fail = false;
  const scopedReceipt = await app('createGoalOnce', scoped, 'u');
  assert.equal(scopedReceipt.success, true);
  assert.notEqual(scopedReceipt.id, first.id);
  assert.equal((await app('createGoalOnce', scoped, 'u')).id, scopedReceipt.id);
  assert.equal((await app('createGoalOnce', { ...scoped, start_date: undefined }, 'u')).rejected, true);
  assert.equal((await app('createGoalOnce', { ...scoped, title: 'changed' }, 'u')).rejected, true);
  assert.equal((await app('createGoalOnce', scoped, 'old-user')).reason, 'ACCOUNT_REQUIRED');
  assert.equal(env.rows.goals.length, 2);
  assert.equal(env.rows.tasks.length, 2);
});

test('feeding commits stock and growth together and makeup keeps stock when task is already complete', async t => {
  let fail = true;
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', is_hatched: true, experience: 100, growth_value: 610, stage: 'ADULT' });
  initial.goals.push({ _id: 'g', _openid: 'owner', status: 'active' });
  initial.tasks.push({ _id: 't', _openid: 'owner', date, goal_id: 'g', title: 'fixture', xp_reward: 10 });
  const { env, app } = fixture(t, initial, { serialTransactions: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline write failure');
  } });
  const data = { itemName: '普通饲料', pet_id: 'p', request_id: 'feed-1' };
  assert.equal((await app('useBackpackItem', data)).code, -1);
  assert.equal(env.rows.pets[0].experience, 100);
  assert.equal(env.rows.user_growth_pool.length, 0);
  fail = false;
  assert.equal((await app('useBackpackItem', data)).xp_added, 10);
  assert.equal((await app('useBackpackItem', data)).already_used, true);
  assert.equal(env.rows.pets[0].experience, 110);
  assert.equal(env.rows.pets[0].growth_value, 620);
  assert.equal(env.rows.pets[0].stage, 'ADULT');
  assert.equal(env.rows.user_growth_pool[0].backpack[0].count, 2);
  assert.equal(env.rows.growth_logs.length, 1);
  const makeup = { itemName: '补签卡', task_id: 't' };
  assert.equal((await app('useBackpackItem', makeup)).xp_earned, 10);
  assert.equal((await app('useBackpackItem', makeup)).already_completed, true);
  assert.equal(env.rows.user_growth_pool[0].backpack.find(item => item.name === '补签卡').count, 0);
  assert.equal((await app('updatePet', { id: 'p', growth_value: 9999 })).code, -1);
});

test('concurrent egg claims preserve the one-egg rule and the three-pet limit', async t => {
  const initial = seed();
  initial.pets.push(
    { _id: 'adult', _openid: 'owner', is_hatched: true },
    { _id: 'released', _openid: 'owner', is_hatched: false, deleted_at: now },
    { _id: 'other', _openid: 'someone-else', is_hatched: false },
  );
  const { env, app } = fixture(t, initial, { snapshotIsolation: true });
  const claim = () => app('createEgg', { egg_type: 'forest_egg' });
  for (const expected of ['已有正在孵化的蛋', '最多拥有3只宠物']) {
    const results = await Promise.all([claim(), claim()]);
    const created = results.filter(result => result.success);
    assert.equal(created.length, 1);
    assert.equal(created[0].egg_type, 'forest_egg');
    assert.equal(results.find(result => !result.success).message, expected);
    const eggs = env.rows.pets.filter(pet => pet._openid === 'owner' && !pet.deleted_at && pet.is_hatched === false);
    assert.equal(eggs.length, 1);
    assert.equal(eggs[0]._id, created[0].id);
    // Use the real growth path to remove the one-egg restriction for the next claim.
    if (expected === '已有正在孵化的蛋') {
      await app('claimStarterXp');
      assert.equal((await app('allocatePool', { pet_id: eggs[0]._id, amount: 100 })).hatched, true);
    }
  }
  assert.equal(env.rows.pets.filter(pet => pet._openid === 'owner' && !pet.deleted_at).length, 3);
  assert.equal(env.rows.users[0].pet_claim_revision, 2);
});

test('egg claim fails closed on reads and rolls back a failed insert', async t => {
  let failure = 'database.getDocument';
  const { env, app } = fixture(t, seed(), { snapshotIsolation: true, beforeRequest(command, args) {
    if (command === failure && args.collectionName === 'pets') throw Error('offline pet operation failed');
  } });
  assert.equal((await app('createEgg')).code, -1);
  failure = 'database.insertDocument';
  assert.equal((await app('createEgg')).code, -1);
  assert.equal(env.rows.pets.length, 0);
  assert.equal(env.rows.users[0].pet_claim_revision, undefined);
  failure = '';
  const egg = await app('createEgg', { egg_type: 'constructor' });
  assert.equal(egg.success, true);
  assert.ok(['forest_egg', 'home_egg', 'wild_egg'].includes(egg.egg_type));
});

test('pet history is paginated and both collections only unlock species evidenced by the owner’s pets', async t => {
  const initial = seed();
  for (let index = 0; index < 100; index++) {
    initial.pets.push({ _id: 'released-' + index, _openid: 'owner', is_hatched: false, deleted_at: now, species: 'hamster' });
  }
  initial.pets.push(
    { _id: 'released-later', _openid: 'owner', is_hatched: false, deleted_at: now, species: 'lynx' },
    { _id: 'living', _openid: 'owner', is_hatched: true, species: 'shiba' },
    { _id: 'other', _openid: 'someone-else', is_hatched: true, species: 'wolf' },
  );
  initial.user_growth_pool.push({ _id: 'legacy', _openid: 'owner', all_ever_owned_species: ['wolf', 'fox'] });
  const { env, app } = fixture(t, initial);
  const forged = { speciesList: ['wolf', 'fox', 'constructor'], _openid: 'someone-else' };
  const forestDex = await app('syncEverOwnedSpecies', forged);
  const collection = await app('petCollection');
  assert.deepEqual(Array.from(forestDex.all_ever_owned_species), ['lynx', 'shiba', 'hamster']);
  assert.deepEqual(Array.from(collection.data.dex.collected_species), ['lynx', 'shiba', 'hamster']);
  assert.equal(collection.data.released.length, 101);
  assert.deepEqual(Array.from((await app('listPets')).data, pet => pet.id), ['living']);
  assert.deepEqual(env.rows.user_growth_pool[0].all_ever_owned_species, ['wolf', 'fox']);
});

test('sign-in and task growth still find an active egg after a full page of release history', async t => {
  const initial = seed();
  for (let index = 0; index < 100; index++) {
    initial.pets.push({ _id: 'released-' + index, _openid: 'owner', is_hatched: false, deleted_at: now });
  }
  initial.pets.push({ _id: 'egg', _openid: 'owner', is_hatched: false, growth_value: 0 });
  initial.tasks.push({ _id: 't', _openid: 'owner', title: 'fixture', date, xp_reward: 10 });
  const { env, app } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true });
  assert.equal((await app('dailyCheckin')).success, true);
  assert.equal(env.rows.pets.at(-1).growth_value, 5);
  assert.equal((await app('taskCheckin', { task_id: 't', pet_growth: true })).xp_earned, 10);
  assert.equal(env.rows.pets.at(-1).growth_value, 15);
  assert.equal(env.rows.pets[0].growth_value, undefined);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 10);
  assert.equal((await app('petDetail', { petId: 'egg' })).success, true);
  assert.equal((await app('petDetail', { petId: 'released-0' })).code, -1);
});

test('pet release rolls back when the log fails and preserves the same pet history on retry', async t => {
  let fail = true;
  const initial = seed();
  initial.pets.push(
    { _id: 'p', _openid: 'owner', name: '小栗', is_hatched: true, species: 'lynx' },
    { _id: 'other', _openid: 'someone-else', is_hatched: true },
  );
  const { env, app } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline release log failed');
  } });
  assert.equal((await app('deletePet', { pet_id: 'other' })).code, -1);
  const release = () => app('deletePet', { pet_id: 'p' });
  assert.equal((await release()).code, -1);
  assert.equal(env.rows.pets[0].is_hatched, true);
  assert.equal(env.rows.pets[0].deleted_at, undefined);
  fail = false;
  const results = await Promise.all([release(), release()]);
  assert.equal(results.filter(result => result.success).length, 2);
  assert.equal(results.filter(result => result.already_released).length, 1);
  assert.equal(env.rows.pets[0].deleted_at, now);
  assert.equal(env.rows.pets[1].deleted_at, undefined);
  assert.equal(env.rows.growth_logs.filter(log => log.source === 'release').length, 1);
  const collection = (await app('petCollection')).data;
  assert.equal(collection.current.length, 0);
  assert.equal(collection.released[0].id, 'p');
  assert.deepEqual(Array.from(collection.dex.collected_species), ['lynx']);
});

test('egg refresh preserves progress and cannot modify a pet that hatches mid-request', async t => {
  let hatchBeforeWrite = false;
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', is_hatched: false, egg_type: 'forest_egg', growth_value: 45 });
  const { env, app } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args, state) {
    if (hatchBeforeWrite && command === 'database.modifyDocument' && args.collectionName === 'pets') {
      hatchBeforeWrite = false;
      state.mutate('pets', 'p', { is_hatched: true, growth_value: 100, species: 'shiba' });
    }
  } });
  const change = target_egg_type => app('refreshEgg', { pet_id: 'p', target_egg_type });
  assert.equal((await change('home_egg')).new_egg_type, 'home_egg');
  assert.equal(env.rows.pets[0].growth_value, 45);
  hatchBeforeWrite = true;
  assert.equal((await change('forest_egg')).message, '已孵化的宠物不能更换蛋类型哦');
  assert.equal(env.rows.pets[0].growth_value, 100);
  assert.equal(env.rows.pets[0].egg_type, 'home_egg');
});

test('starter gift rolls back with its log and concurrent claims preserve sign-in growth', async t => {
  let fail = true;
  const initial = seed();
  initial.user_growth_pool.push({ _id: 'legacy', _openid: 'owner', growth_pool: 40, total_earned: 100 });
  const { env, app } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline write failure');
  } });
  assert.equal((await app('claimStarterXp')).code, -1);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 40);
  assert.equal((await app('getGrowthPool')).starter_claimed, false);
  fail = false;

  const [first, second, checkin] = await Promise.all([
    app('claimStarterXp'), app('claimStarterXp'), app('dailyCheckin'),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(checkin.success, true);
  assert.deepEqual([first.claimed_amount, second.claimed_amount].sort((a, b) => a - b), [0, 800]);
  assert.ok([840, 845].includes([first, second].find(result => result.claimed_amount === 800).total_pool));
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 845);
  assert.equal(env.rows.user_growth_pool[0].total_earned, 905);
  assert.equal(env.rows.growth_logs.filter(log => log.source === 'starter_bonus').length, 1);
  assert.equal((await app('getGrowthPool')).starter_claimed, true);
  assert.equal((await app('claimStarterXp')).already_claimed, true);
});

test('starter gift and fountain allocation preserve both changes to the same balance', async t => {
  const initial = seed();
  initial.user_growth_pool.push({ _id: 'legacy', _openid: 'owner', growth_pool: 40, total_earned: 40 });
  initial.pets.push({ _id: 'egg', _openid: 'owner', is_hatched: false, growth_value: 0 });
  const { env, app } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true });
  const [gift, fountain] = await Promise.all([
    app('claimStarterXp'), app('allocatePool', { pet_id: 'egg', amount: 20, request_id: 'gift-fountain' }),
  ]);
  assert.equal(gift.claimed_amount, 800);
  assert.equal(fountain.allocated, 20);
  assert.equal(env.rows.pets[0].growth_value, 20);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 820);
  assert.equal(env.rows.user_growth_pool[0].total_earned, 840);
});

test('children’s gift preserves default inventory and concurrent feeding on a fresh account', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', is_hatched: true, experience: 100, growth_value: 610 });
  const { env, app } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true });
  assert.equal((await app('getBackpack')).data, null);
  assert.equal((await app('getBackpack', { includeGiftStatus: true })).data.children_day_claimed, false);
  const [first, second, feed] = await Promise.all([
    app('claimChildrenDayGift'), app('claimChildrenDayGift'),
    app('useBackpackItem', { itemName: '普通饲料', pet_id: 'p', request_id: 'gift-feed-1' }),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal([first, second].filter(result => result.already_claimed).length, 1);
  assert.equal(feed.xp_added, 10);
  assert.equal(env.rows.pets[0].experience, 110);
  assert.equal(env.rows.user_growth_pool.length, 1);
  const status = (await app('getBackpack', { includeGiftStatus: true })).data;
  assert.equal(status.children_day_claimed, true);
  assert.deepEqual(Array.from(status.backpack, item => item.count), [22, 21, 20, 21]);
  assert.deepEqual((await app('getBackpack')).data, status.backpack);
});

test('gift status honors legacy timestamps and explicit empty inventory', async t => {
  const initial = seed();
  initial.user_growth_pool.push({
    _id: 'legacy', _openid: 'owner', growth_pool: 0, total_earned: 800, starter_claimed_at: now, backpack: [],
  });
  const { env, app } = fixture(t, initial, { serialTransactions: true });
  assert.equal((await app('getGrowthPool')).starter_claimed, true);
  assert.equal((await app('claimStarterXp')).already_claimed, true);
  assert.equal((await app('getBackpack', { includeGiftStatus: true })).data.children_day_claimed, false);
  assert.equal((await app('claimChildrenDayGift')).success, true);
  const pool = env.rows.user_growth_pool[0];
  assert.deepEqual(Array.from(pool.backpack, item => item.count), [20, 20, 20, 20]);
  delete pool.children_day_claimed;
  assert.equal((await app('getBackpack', { includeGiftStatus: true })).data.children_day_claimed, true);
  assert.equal((await app('claimChildrenDayGift')).already_claimed, true);
  assert.equal(env.rows.growth_logs.length, 0);
});

test('closed goal tasks stay in history but cannot earn new rewards', async t => {
  const initial = seed();
  for (const status of ['active', 'done', 'abandoned', 'deleted']) {
    initial.goals.push({ _id: status, _openid: 'owner', status });
    initial.tasks.push({ _id: 'task-' + status, _openid: 'owner', title: status, goal_id: status, date, xp_reward: 10 });
  }
  initial.tasks.push(
    { _id: 'history', _openid: 'owner', goal_id: 'abandoned', date, xp_reward: 10, completed: true },
    { _id: 'orphan', _openid: 'owner', goal_id: 'missing', date, xp_reward: 10 },
  );
  initial.user_growth_pool.push({ _id: 'pool', _openid: 'owner', growth_pool: 0, backpack: [{ name: '补签卡', count: 1 }] });
  const { env, app } = fixture(t, initial, { serialTransactions: true });
  assert.deepEqual(Array.from((await app('getDashboard')).data.todayTasks, task => task.id), ['task-active', 'history']);
  assert.deepEqual(Array.from((await app('listTasks', { date })).data, task => task.id), ['task-active', 'history']);
  assert.deepEqual(Array.from((await app('listTasks', { date, goal_id: 'abandoned' })).data, task => task.id), ['task-abandoned', 'history']);
  for (const goal_id of ['done', 'abandoned', 'deleted']) {
    assert.equal((await app('createTask', { title: '新增任务', goal_id, date })).code, -1);
    assert.equal((await app('taskCheckin', { task_id: 'task-' + goal_id, pet_growth: true })).code, -1);
  }
  assert.equal((await app('taskCheckin', { task_id: 'orphan' })).code, -1);
  assert.equal((await app('useBackpackItem', { itemName: '补签卡', task_id: 'task-abandoned' })).code, -1);
  assert.equal((await app('taskCheckin', { task_id: 'history' })).already_completed, true);
  assert.equal(env.rows.user_growth_pool[0].backpack[0].count, 1);
  assert.equal(env.rows.users[0].total_xp, 0);
  assert.equal(env.rows.growth_logs.length, 0);
  assert.equal((await app('createTask', { title: '可添加任务', goal_id: 'active', date })).success, true);
  assert.equal((await app('taskCheckin', { task_id: 'task-active' })).xp_earned, 10);
  assert.equal((await app('updateGoal', { id: 'active', status: 'done' })).success, true);
  assert.equal((await app('updateGoal', { id: 'active', status: 'abandoned' })).code, -1);
});

test('a goal closed during settlement prevents the stale task reward', async t => {
  const initial = seed();
  initial.goals.push({ _id: 'g', _openid: 'owner', status: 'active' });
  initial.tasks.push({ _id: 't', _openid: 'owner', goal_id: 'g', date, xp_reward: 10 });
  let closed = false;
  const { env, app } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args, state) {
    if (command === 'database.commitTransaction' && !closed) {
      closed = true;
      state.mutate('goals', 'g', { status: 'abandoned' });
    }
  } });
  assert.equal((await app('taskCheckin', { task_id: 't' })).code, -1);
  assert.equal(env.stats.conflicts, 1);
  assert.equal(env.rows.tasks[0].completed, undefined);
  assert.equal(env.rows.users[0].total_xp, 0);
  assert.equal(env.rows.growth_logs.length, 0);
});

test('manual task rewards are bounded and zero completes without granting growth', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', is_hatched: true, growth_value: 100 });
  initial.tasks.push(
    { _id: 'legacy-default', _openid: 'owner', date, title: '旧任务' },
    { _id: 'legacy-string', _openid: 'owner', date, title: '旧字符串', xp_reward: '25' },
    { _id: 'legacy-excess', _openid: 'owner', date, title: '越界奖励', xp_reward: 1001 },
  );
  const { env, app } = fixture(t, initial, { serialTransactions: true });
  for (const xp_reward of [1001, -1, 0.5, true, '', '1e3']) {
    assert.equal((await app('createTask', { title: '无效奖励', xp_reward })).code, -1);
  }
  assert.equal(env.rows.tasks.length, 3);
  const zero = await app('createTask', { title: '无经验任务', xp_reward: 0 });
  assert.equal(zero.success, true);
  const receipt = await app('taskCheckin', { task_id: zero.id, pet_growth: true });
  assert.equal(receipt.xp_earned, 0);
  assert.equal((await app('taskCheckin', { task_id: zero.id, pet_growth: true })).already_completed, true);
  assert.equal(env.rows.users[0].total_xp, 0);
  assert.equal(env.rows.user_growth_pool.length, 0);
  assert.equal(env.rows.pets[0].growth_value, 100);
  assert.equal(env.rows.growth_logs[0].xp_change, 0);
  assert.equal((await app('getDashboard')).data.todayGrowth.xp, 0);
  assert.equal((await app('listTasks', { date })).data.find(task => task.id === zero.id).xp_reward, 0);
  assert.equal((await app('taskCheckin', { task_id: 'legacy-excess' })).code, -1);
  assert.equal((await app('taskCheckin', { task_id: 'legacy-default' })).xp_earned, 10);
  assert.equal((await app('taskCheckin', { task_id: 'legacy-string' })).xp_earned, 25);
  assert.equal((await app('getDashboard')).data.todayGrowth.xp, 35);
  const maximum = await app('createTask', { title: '最高经验任务', xp_reward: '1000' });
  assert.equal(maximum.success, true);
  assert.equal(env.rows.tasks.find(task => task._id === maximum.id).xp_reward, 1000);
  assert.equal(env.rows.tasks.find(task => task._id === 'legacy-excess').completed, undefined);
});

test('manual goal task creation replays the original receipt across concurrent requests and goal closure', async t => {
  const initial = seed();
  initial.goals.push({ _id: 'g', _openid: 'owner', status: 'active' });
  const { env, app } = fixture(t, initial, { snapshotIsolation: true });
  const payload = { request_id: 'task-retry', goal_id: 'g', title: '复习笔记', date, xp_reward: 20 };
  const replies = await Promise.all(Array.from({ length: 5 }, () => app('createTaskOnce', payload, 'u')));
  assert.ok(replies.every(reply => reply.success));
  assert.equal(new Set(replies.map(reply => reply.id)).size, 1);
  assert.equal(replies.filter(reply => !reply.already_created).length, 1);
  assert.equal(env.rows.tasks.length, 1);
  assert.equal(env.rows.goals[0].task_activity_version, 1);
  assert.equal((await app('createTaskOnce', { ...payload, title: '其他任务' }, 'u')).rejected, true);
  assert.equal((await app('createTaskOnce', { ...payload, request_id: undefined }, 'u')).rejected, true);
  assert.equal((await app('createTaskOnce', payload, 'old-account')).reason, 'ACCOUNT_REQUIRED');
  await app('updateGoal', { id: 'g', status: 'done' });
  const recovered = await app('createTaskOnce', payload, 'u');
  assert.equal(recovered.id, replies[0].id);
  assert.equal(recovered.already_created, true);
  assert.equal((await app('createTaskOnce', { ...payload, request_id: 'fresh' }, 'u')).rejected, true);
  assert.equal(env.rows.tasks.length, 1);
});

test('fountain preserves hatch surplus and a retried confirmation never allocates twice', async t => {
  const initial = seed();
  initial.user_growth_pool.push({ _id: 'legacy-pool', _openid: 'owner', growth_pool: 800, total_earned: 800 });
  initial.pets.push(
    { _id: 'egg', _openid: 'owner', is_hatched: false, growth_value: 25, attributes: null },
    { _id: 'released', _openid: 'owner', is_hatched: false, growth_value: 0, deleted_at: now },
    { _id: 'other', _openid: 'other-owner', is_hatched: false, growth_value: 0 },
  );
  let fail = true;
  const { env, app } = fixture(t, initial, { serialTransactions: true, snapshotIsolation: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline receipt failure');
  } });
  const request = { pet_id: 'egg', amount: 800, request_id: 'allocation-1' };
  assert.equal((await app('allocatePool', request)).code, -1);
  assert.equal(env.rows.pets[0].growth_value, 25);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 800);
  fail = false;
  for (const pet_id of ['other', 'released']) {
    assert.equal((await app('allocatePool', { pet_id, amount: 100 })).code, -1);
  }
  assert.equal((await app('allocatePool', { pet_id: 'egg', amount: -1 })).code, -1);
  const first = await app('allocatePool', request);
  assert.equal(first.hatched, true);
  assert.equal(first.allocated, 75);
  assert.equal(first.pool_remaining, 725);
  assert.equal(env.rows.pets[0].growth_value, 100);
  assert.equal(env.rows.pets[0].stage, 'BABY');
  assert.equal(env.rows.pets[1].growth_value, 0);
  assert.equal(env.rows.pets[2].growth_value, 0);
  assert.equal(env.rows.user_growth_pool[0].total_earned, 800);
  assert.equal((await app('allocatePool', request)).pet.name, first.pet.name);
  assert.equal((await app('allocatePool', { ...request, amount: 100 })).code, -1);
  assert.equal(env.rows.growth_logs.length, 1);
  const results = await Promise.all([
    app('allocatePool', { ...request, request_id: 'allocation-2', amount: 110 }),
    app('allocatePool', { ...request, request_id: 'allocation-3', amount: 110 }),
  ]);
  assert.ok(results.every(result => result.success));
  assert.equal(results.filter(result => result.stage_up?.to === 'YOUTH').length, 1);
  assert.equal(env.rows.pets[0].growth_value, 320);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 505);
});

test('awakening follows growth and records one result across concurrent confirmations', async t => {
  const initial = seed();
  initial.pets.push(
    { _id: 'perfect', _openid: 'owner', name: '白雪', species: 'lynx', growth_value: 1200, stage: 'BABY', is_hatched: true },
    { _id: 'baby', _openid: 'owner', name: '小雪', growth_value: 150, stage: 'ADULT', is_hatched: true },
  );
  let fail = true;
  const { env, app } = fixture(t, initial, { serialTransactions: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline awakening log failure');
  } });
  const awaken = pet_id => app('awakenPet', { pet_id });
  assert.equal((await awaken('baby')).code, -1);
  assert.equal((await awaken('perfect')).code, -1);
  assert.equal(env.rows.pets[0].name, '白雪');
  assert.equal(env.rows.pets[0].awakened, undefined);
  fail = false;
  const results = await Promise.all([awaken('perfect'), awaken('perfect')]);
  assert.equal(results.filter(result => result.already_awakened).length, 1);
  assert.equal(results[0].awakened_name, results[1].awakened_name);
  assert.equal(env.rows.growth_logs.filter(log => log.source === 'awaken').length, 1);
});

test('pet interactions settle concurrent rewards without changing the growth stage', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', name: '小雪', species: 'lynx', is_hatched: true,
    growth_value: 100, experience: 297, stage: 'BABY', level: 1, bond: 995 });
  let fail = true;
  const { env, app } = fixture(t, initial, { serialTransactions: true, beforeRequest(command, args) {
    if (fail && command === 'database.insertDocument' && args.collectionName === 'growth_logs') throw Error('offline interaction log failure');
  } });
  const interact = action => app('petInteract', { pet_id: 'p', action });
  assert.equal((await interact('pat')).code, -1);
  assert.equal(env.rows.pets[0].experience, 297);
  fail = false;
  const results = await Promise.all([interact('pat'), interact('play')]);
  assert.ok(results.every(result => result.success));
  assert.equal(results.reduce((total, result) => total + result.bond_added, 0), 5);
  assert.equal(env.rows.pets[0].experience, 317);
  assert.equal(env.rows.pets[0].bond, 1000);
  assert.equal(env.rows.pets[0].stage, 'BABY');
  assert.equal(env.rows.pets[0].level, 2);
  assert.deepEqual(env.rows.growth_logs.map(log => log.source).sort(), ['interact_pet', 'interact_play']);
});

test('admin pet edits preserve progress and the hatch boundary', async t => {
  const initial = seed();
  initial.pets.push(
    { _id: 'p', _openid: 'owner', name: '小雪', is_hatched: true, growth_value: 670, stage: 'BABY', mood: 'sad' },
    { _id: 'egg', _openid: 'owner', is_hatched: false, growth_value: 90 },
    { _id: 'released', _openid: 'owner', deleted_at: now },
    { _id: 'legacy', _openid: 'owner', is_hatched: true, stage: 'ADULT', name: '旧伙伴' },
  );
  const { env, app } = fixture(t, initial, { serialTransactions: true });
  assert.equal((await app('adminEditPet', { petId: 'p', mood: 'happy' })).code, -1);
  env.mutate('users', 'u', { role: 'admin' });
  const list = (await app('adminListPets', {})).data.list;
  assert.equal(list.find(pet => pet.id === 'p').stage, 'ADULT');
  assert.equal(list.find(pet => pet.id === 'p').mood, 'sad');
  const edit = (petId, fields) => app('adminEditPet', { petId, ...fields });
  assert.equal((await edit('p', { stage: 'ADULT', mood: 'happy' })).success, true);
  assert.equal(env.rows.pets[0].growth_value, 670);
  assert.equal(env.rows.pets[0].mood, 'happy');
  assert.ok(env.rows.pets[0].mood_message);
  assert.equal((await edit('p', { stage: 'PERFECT' })).success, true);
  assert.equal(env.rows.pets[0].growth_value, 1200);
  assert.equal((await edit('p', { stage: 'EGG' })).code, -1);
  assert.equal((await edit('egg', { stage: 'BABY' })).code, -1);
  assert.equal((await edit('released', { mood: 'happy' })).code, -1);
  assert.equal((await edit('unknown', { mood: 'happy' })).code, -1);
  assert.equal((await app('awakenPet', { pet_id: 'legacy' })).success, true);
});

test('forest recovers the original allocation and last-item receipts after restart without charging twice', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'p', _openid: 'owner', name: '栗子', is_hatched: true, growth_value: 150 });
  initial.user_growth_pool.push({ _id: 'pool', _openid: 'owner', growth_pool: 20, total_earned: 20,
    backpack: [{ name: '普通饲料', count: 1 }, { name: '补签卡', count: 1 }] });
  initial.goals.push({ _id: 'g', _openid: 'owner', status: 'active' });
  initial.tasks.push({ _id: 't', _openid: 'owner', goal_id: 'g', title: '阅读', date, xp_reward: 0 });
  const { env, app, advance } = fixture(t, initial, { snapshotIsolation: true });
  const storage = new Map(), calls = [], toasts = [];
  let drop = true, storageFailure = false;
  let beforeReply;
  function page(id = 'u') {
    const application = { globalData: { currentOpenid: 'owner', userInfo: { id, openid: 'owner' } } };
    const filename = resolve(__dirname, '../miniprogram/pages/pets/pets.js');
    const req = createRequire(filename);
    let definition;
    const settle = action => async data => {
      calls.push({ action, data: structuredClone(data) });
      const result = await app(action, data, id);
      assert.equal(result.success, true);
      if (beforeReply) await beforeReply();
      if (drop) throw Error('lost response after commit');
      return result;
    };
    const api = { allocatePoolOnce: settle('allocatePoolOnce'), useBackpackItemOnce: settle('useBackpackItemOnce'),
      tasks: async () => [{ id: 't', goal_id: 'g', title: '阅读' }] };
    const wx = { getStorageSync: key => storage.get(key),
      setStorageSync(key, value) { if (storageFailure) throw Error('storage unavailable'); storage.set(key, structuredClone(value)); },
      removeStorageSync: key => storage.delete(key), showToast: value => toasts.push(value.title),
      showLoading() {}, hideLoading() {} };
    runInNewContext(readFileSync(filename, 'utf8'), {
      require: name => name === '../../utils/cloudApi' ? api : req(name),
      Page: value => { definition = value; }, getApp: () => application, wx, console: { log() {}, warn() {}, error() {} },
      setTimeout() {},
    });
    definition.setData = patch => Object.assign(definition.data, patch);
    definition.loadData = () => {};
    definition.loadGrowthPool = () => {};
    definition.onShow();
    return { page: definition, application };
  }
  const first = page().page;
  first.setData({ allocateTargetId: 'p', allocateTargetName: '栗子', allocateAmount: '20', allocateMaxPool: 20 });
  storageFailure = true;
  await first.confirmAllocate();
  assert.equal(calls.length, 0);
  storageFailure = false;
  await first.confirmAllocate();
  assert.equal(first.data.allocationPending.request.amount, 20);
  assert.equal(env.rows.user_growth_pool[0].growth_pool, 0);
  const other = page('recreated').page;
  assert.equal(other.data.allocationPending, null);
  const reopened = page().page;
  assert.equal(reopened.data.allocationPending.label, '栗子');
  reopened.openAllocateModal();
  assert.equal(reopened.data.showAllocateModal, true);
  drop = false;
  await reopened.confirmAllocate();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(reopened.data.allocationPending, null);
  assert.equal(env.rows.pets[0].growth_value, 170);
  assert.equal(env.rows.growth_logs.length, 1);

  drop = true;
  const bag = page().page;
  bag.setData({ activePet: { _id: 'p', name: '栗子' }, backpack: [{ name: '普通饲料', count: 1 }] });
  await bag.useItem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(bag.data.itemPending.request.itemName, '普通饲料');
  assert.equal(page('recreated').page.data.itemPending, null);
  assert.equal(env.rows.user_growth_pool[0].backpack.find(item => item.name === '普通饲料').count, 0);
  const emptyBag = page().page;
  assert.equal(emptyBag.data.itemPending.label, '栗子');
  drop = false;
  await emptyBag.resumeBackpackItem();
  assert.deepEqual(calls[3], calls[2]);
  assert.equal(emptyBag.data.itemPending, null);
  assert.equal(env.rows.pets[0].growth_value, 180);
  assert.equal(env.rows.growth_logs.length, 2);

  drop = true;
  const makeup = page().page;
  makeup.setData({ backpack: [{ name: '补签卡', count: 1 }] });
  await makeup.useItem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(makeup.data.itemPending.request.task_id, 't');
  assert.equal(env.rows.tasks[0].completed, true);
  advance(24 * 60 * 60 * 1000);
  drop = false;
  const nextDay = page().page;
  await nextDay.resumeBackpackItem();
  assert.deepEqual(calls[5], calls[4]);
  assert.equal(nextDay.data.itemPending, null);
  assert.equal(env.rows.growth_logs.length, 3);
  assert.equal(storage.size, 0);
  assert.equal(toasts.at(-1), '这项任务已完成');

  env.mutate('user_growth_pool', 'pool', { growth_pool: 10 });
  const switching = page();
  switching.page.setData({ allocateTargetId: 'p', allocateTargetName: '栗子', allocateAmount: '10', allocateMaxPool: 10 });
  let reachReply, releaseReply;
  const waiting = new Promise(resolve => { reachReply = resolve; });
  const held = new Promise(resolve => { releaseReply = resolve; });
  beforeReply = () => { reachReply(); return held; };
  const pending = switching.page.confirmAllocate();
  await waiting;
  const notifications = toasts.length;
  switching.application.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  switching.page.onShow();
  releaseReply();
  await pending;
  assert.equal(switching.page.data.allocationPending, null);
  assert.equal(switching.page.data.rewardBusy, false);
  assert.equal(toasts.length, notifications);
  assert.equal(page().page.data.allocationPending.request.amount, 10);
});

test('forest gift claims and backpack reads ignore old account responses and stale snapshots', async () => {
  const { page } = require('./adjustment-client.cjs');
  let finishStarter, finishOldBackpack, finishChild;
  let starterCalls = 0, childCalls = 0, backpackCalls = 0;
  const c = page({
    claimStarterXp: () => { starterCalls++; return new Promise(resolve => { finishStarter = resolve; }); },
    claimChildrenDayGift: () => { childCalls++; return new Promise(resolve => { finishChild = resolve; }); },
    getBackpack: async options => {
      assert.equal(options.includeGiftStatus, true);
      if (++backpackCalls === 1) return new Promise(resolve => { finishOldBackpack = resolve; });
      return { children_day_claimed: true, backpack: [{ name: '普通饲料', count: 23 }] };
    },
    getGrowthPool: async () => ({ success: true, growth_pool: 800, starter_claimed: true }),
  }, new Map(), 'pets/pets');
  c.wx.showLoading = () => {};
  c.wx.hideLoading = () => {};
  const { p } = c;
  p.syncRewardSession();
  p.setData({ campVisible: true, showStarterGift: true, showChildrenDayGift: true, activeSection: 'backpack' });
  const starter = p.claimStarterXp();
  await p.claimStarterXp();
  assert.equal(starterCalls, 1);
  c.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  p.syncRewardSession();
  p.setData({ showStarterGift: true, showChildrenDayGift: true });
  finishStarter({ success: true, message: '旧账号礼包' });
  await starter;
  assert.equal(p.data.showStarterGift, true);
  assert.equal(p.data.starterClaimed, false);
  assert.equal(c.options.toasts.length, 0);

  const oldRead = p.loadBackpack();
  const claiming = p.claimChildrenDayGift();
  await p.claimChildrenDayGift();
  assert.equal(childCalls, 1);
  finishChild({ success: true, backpack: [{ name: '普通饲料', count: 20 }] });
  await claiming;
  finishOldBackpack({ children_day_claimed: false, backpack: [{ name: '普通饲料', count: 3 }] });
  await oldRead;
  assert.equal(p.data.showChildrenDayGift, false);
  assert.equal(p.data.backpack[0].count, 23);
  assert.equal(p.data.activeSection, 'backpack');
  assert.equal(p.data.rewardBusy, false);

  p.setData({ showStarterGift: true });
  const confirmed = p.claimStarterXp();
  finishStarter({ success: true, already_claimed: true });
  await confirmed;
  assert.equal(p.data.showStarterGift, false);
  assert.equal(p.data.fountainPoolValue, 800);
  assert.equal(c.options.toasts.at(-1).icon, 'none');
});

test('collection View selects the clicked forest pet and ignores an unavailable or different-account target', async () => {
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'account' } } };
  const toasts = [];
  let switchOptions;
  const wx = { switchTab(options) { switchOptions = options; }, showLoading() {}, hideLoading() {},
    showToast(options) { toasts.push(options.title); } };
  const first = { id: 'first', name: '第一只', is_hatched: false };
  const second = { id: 'second', name: '第二只', is_hatched: false };
  let pets = [first, second];
  const api = { getBackpack: async () => [], petOverview: async () => pets,
    syncEverOwnedSpecies: async () => ({}), getGrowthPool: async () => ({}) };
  const loadPage = name => {
    const filename = resolve(__dirname, '../miniprogram/pages', name, name + '.js');
    const req = createRequire(filename);
    let page;
    runInNewContext(readFileSync(filename, 'utf8'), {
      require: id => id === '../../utils/cloudApi' ? api : req(id),
      Page: options => { page = options; }, getApp: () => app, wx, console: { log() {}, warn() {}, error() {} },
    }, { filename });
    page.setData = patch => Object.assign(page.data, patch);
    return page;
  };
  const mine = loadPage('mine');
  const forest = loadPage('pets');
  forest.resolvePetImageUrls = async () => {};
  const view = id => mine.goPetDetail({ currentTarget: { dataset: { id } } });
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'first');
  view('second');
  assert.equal(switchOptions.url, '/pages/pets/pets');
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'second');
  assert.equal(forest.data.currentSwiperIndex, 1);
  assert.equal(forest.data.activePet.name, '第二只');
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'second');

  view('released');
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'second');
  assert.equal(toasts.pop(), '这只宠物已不在森林里');
  view('first');
  switchOptions.fail();
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'second');
  assert.equal(toasts.pop(), '暂时无法打开森林，请重试');

  view('second');
  app.globalData.userInfo = { id: 'recreated' };
  pets = [{ id: 'other-pet', is_hatched: false }];
  await forest.onShow();
  assert.equal(forest.data.activePetId, 'other-pet');
  assert.deepEqual(toasts, []);

  view('other-pet');
  let finishImages;
  forest.resolvePetImageUrls = () => new Promise(resolve => { finishImages = resolve; });
  pets = [{ id: 'should-not-appear', is_hatched: false }];
  const loading = forest.onShow();
  await new Promise(resolve => setImmediate(resolve));
  app.globalData.userInfo = { id: 'account' };
  finishImages();
  await loading;
  assert.equal(forest.data.activePetId, 'other-pet');
  assert.deepEqual(toasts, []);
});

test('collection read failures are retryable and late reads or releases cannot reopen an old collection', async () => {
  const app = { globalData: { currentOpenid: 'owner' } };
  const filename = resolve(__dirname, '../miniprogram/pages/mine/mine.js');
  const req = createRequire(filename);
  const api = { petCollection: async () => { throw Error('offline collection'); } };
  let page, notices = 0;
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: id => id === '../../utils/cloudApi' ? api : req(id), Page: options => { page = options; },
    getApp: () => app, wx: { showToast() { notices++; } },
  }, { filename });
  page.setData = patch => Object.assign(page.data, patch);
  await page.openCollection();
  assert.equal(page.data.collectionStatus, 'error');
  api.petCollection = async () => ({ current: [], released: [], stats: {} });
  await page.openCollection();
  assert.equal(page.data.collectionStatus, 'ready');
  assert.equal(page.data.currentPets.length, 0);

  let firstReply;
  api.petCollection = () => new Promise(resolve => { firstReply = resolve; });
  const oldLoad = page.openCollection();
  page.onHide();
  app.globalData.currentOpenid = 'other';
  api.petCollection = async () => ({ current: [{ id: 'current' }], released: [] });
  await page.openCollection();
  firstReply({ current: [{ id: 'old-account' }], released: [] });
  await oldLoad;
  assert.equal(page.data.currentPets[0].id, 'current');

  let releaseReply, releases = 0;
  api.deletePet = () => { releases++; return new Promise(resolve => { releaseReply = resolve; }); };
  page.confirmDeletePet({ currentTarget: { dataset: { id: 'current', name: '小栗' } } });
  const releasing = page.doDeletePet();
  await page.doDeletePet();
  assert.equal(releases, 1);
  page.onHide();
  releaseReply({ success: true });
  await releasing;
  assert.equal(page.data.showCollection, false);
  assert.equal(page.data.showDeleteConfirm, false);
  assert.equal(notices, 0);
});

test('profile update confirms an actual write to exactly one owned user', async t => {
  const initial = seed();
  initial.users.push({ _id: 'other', _openid: 'someone-else', avatar: 'existing' });
  const { env, app } = fixture(t, initial);
  const data = { avatar: 'cloud://new-avatar' };
  assert.equal((await app('updateUser', data)).success, true);
  assert.equal(env.rows.users[0].avatar, data.avatar);
  assert.equal(env.rows.users[1].avatar, 'existing');
  env.rows.users.push({ _id: 'duplicate', _openid: 'owner' });
  assert.equal((await app('updateUser', { avatar: 'cloud://wrong' })).code, -1);
  assert.equal(env.rows.users[0].avatar, data.avatar);
  env.rows.users.splice(0, 1);
  env.rows.users.pop();
  assert.equal((await app('updateUser', data)).code, -1);
  assert.equal(env.rows.users[0].avatar, 'existing');
});

test('Mine profile and avatar writes are isolated from late replies after a session switch', async () => {
  const filename = resolve(__dirname, '../miniprogram/pages/mine/mine.js');
  const req = createRequire(filename);
  const old = { openid: 'old', role: 'admin', nickname: '旧账号' };
  const current = { openid: 'new', role: 'user', nickname: '新账号' };
  const app = { globalData: { currentOpenid: 'old', userInfo: old } };
  let page, cached = old, reply, choose, finishUpload, finishSave, writes = 0, visits = 0;
  const api = {
    dashboard: () => new Promise(resolve => { reply = resolve; }),
    pets: async () => [],
    updateMe: () => { writes++; return new Promise(resolve => { finishSave = resolve; }); },
  };
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: id => id === '../../utils/cloudApi' ? api : req(id), Page: options => { page = options; },
    getApp: () => app, console: { warn() {}, error() {} }, wx: {
      showLoading() {}, hideLoading() {}, showToast() {}, navigateTo() { visits++; },
      getStorageSync: () => cached, setStorageSync: (_, value) => { cached = value; },
      chooseMedia(options) { choose = options.success; },
      cloud: { uploadFile: () => new Promise(resolve => { finishUpload = resolve; }) },
    },
  }, { filename });
  page.setData = patch => Object.assign(page.data, patch);
  const signIn = user => { app.globalData.currentOpenid = user.openid; app.globalData.userInfo = user; };

  const previous = page.loadUserData();
  signIn(current);
  api.dashboard = async () => ({ user: { ...current, total_xp: 5 } });
  await page.loadUserData();
  reply({ user: { ...old, total_xp: 700 } });
  await previous;
  assert.equal(page.data.userInfo.nickname, '新账号');
  assert.equal(page.data.totalXp, 5);
  assert.equal(page.data.myOpenid, 'new');
  assert.equal(page.data.isAdmin, false);

  api.dashboard = async () => { throw Error('offline dashboard'); };
  signIn(old);
  cached = current;
  await page.loadUserData();
  assert.equal(page.data.userInfo.nickname, undefined);
  cached = old;
  await page.loadUserData();
  assert.equal(page.data.userInfo.nickname, '旧账号');
  assert.equal(page.data.isAdmin, false);
  api.dashboard = async () => ({ user: old });
  await page.loadUserData();
  page.goAdmin();
  assert.equal(visits, 1);
  signIn({ ...old });
  page.goAdmin();
  assert.equal(visits, 1);

  const files = { tempFiles: [{ tempFilePath: 'avatar.jpg' }] };
  page.chooseAvatar();
  const pendingUpload = choose(files);
  signIn(current);
  finishUpload({ fileID: 'cloud://old-avatar' });
  await pendingUpload;
  assert.equal(writes, 0);
  page.chooseAvatar();
  const pendingSave = choose(files);
  finishUpload({ fileID: 'cloud://new-avatar' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  signIn(old);
  cached = old;
  finishSave({ success: true });
  await pendingSave;
  assert.equal(cached.avatar, undefined);
  assert.equal(page.data['userInfo.avatar'], undefined);
});

test('admin deletion fails before changing data on discovery errors and rolls back late remove errors', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'target', _openid: 'target-owner', role: 'user' });
  for (const name of ['pets', 'goals', 'tasks', 'ai_plans', 'api_keys', 'growth_logs']) {
    initial[name] = [{ _id: name + '-target', _openid: 'target-owner' }, { _id: name + '-admin', _openid: 'owner' }];
  }
  let failure = 'database.getDocument';
  const { env, app, advance } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args) {
    if (command === failure && args.collectionName === (command === 'database.getDocument' ? 'pets' : 'users')) {
      throw Error('offline deletion failure');
    }
  } });
  const remove = id => app('adminDeleteUser', { userId: id });
  assert.equal((await remove('target')).code, -1);
  assert.equal(env.stats.starts, 0);
  assert.equal(env.rows.users.length, 2);
  failure = '';
  assert.equal((await remove('target')).reason, 'ACCOUNT_CLEANUP_PENDING');
  advance(60_000);
  failure = 'database.removeDocument';
  assert.equal((await remove('target')).code, -1);
  assert.equal(env.rows.users.length, 2);
  assert.equal(env.rows.pets.length, 2);
  assert.equal(env.rows.goals.length, 2);
  assert.equal(env.rows.ai_plans.length, 2);
  failure = '';
  assert.equal((await remove('u')).code, -1);
  const result = await remove('target');
  assert.equal(result.data?.deletedUsers, 1);
  assert.equal(result.data.deletedAiRecords, 1);
  assert.equal(result.data.deletedApiKeys, 1);
  for (const name of ['users', 'pets', 'goals', 'tasks', 'ai_plans', 'api_keys', 'growth_logs']) {
    assert.deepEqual(env.rows[name].map(row => row._openid), ['owner']);
  }
});

test('bulk account cleanup is all-or-nothing and refuses duplicate ownership or oversized batches', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'a', _openid: 'a-owner', role: 'user' }, { _id: 'b', _openid: 'b-owner', role: 'user' });
  initial.pets.push({ _id: 'pet', _openid: 'a-owner' }, { _id: 'admin-pet', _openid: 'owner' });
  const { env, app, advance } = fixture(t, initial, { snapshotIsolation: true });
  const cleanup = (phase, batchId) => app('adminCleanupNonAdmin', { phase, batchId });
  assert.equal((await cleanup('status')).data.status, 'idle');
  assert.equal((await app('adminCleanupNonAdmin')).code, -1);
  env.rows.users.push({ _id: 'duplicate', _openid: 'a-owner', role: 'user' });
  assert.equal((await cleanup('prepare', null)).code, -1);
  env.rows.users.pop();
  const originalTasks = env.rows.tasks.length;
  env.rows.tasks.push(...Array.from({ length: 51 }, (_, index) => ({ _id: 'task-' + index, _openid: 'b-owner' })));
  assert.equal((await cleanup('prepare', null)).code, -1);
  assert.equal(env.stats.starts, 0);
  assert.equal(env.rows.users.length, 3);
  assert.equal(env.rows.pets.length, 2);
  assert.equal(env.rows.tasks.length, 51);
  env.rows.tasks.length = originalTasks;
  const batch = (await cleanup('prepare', null)).data;
  assert.equal(batch.status, 'pending');
  assert.equal(batch.targetCount, 2);
  assert.equal((await cleanup('status')).data.batchId, batch.batchId);
  assert.equal((await cleanup('finish', batch.batchId)).data.status, 'pending');
  env.rows.users.push({ _id: 'new', _openid: 'new-owner', role: 'user', status: 'active' });
  assert.equal((await app('adminDeleteUser', { userId: 'a' })).code, -1);
  advance(60_000);
  const [result, sameReceipt] = await Promise.all([cleanup('finish', batch.batchId), cleanup('finish', batch.batchId)]);
  assert.equal(result.data?.deletedUsers, 2);
  assert.equal(result.data.status, 'done');
  assert.equal(sameReceipt.data?.deletedUsers, 2);
  assert.equal((await cleanup('finish', batch.batchId)).data.deletedUsers, 2);
  assert.equal((await cleanup('prepare', null)).code, -1);
  assert.deepEqual(Array.from(result.data.keptUsers), ['owner-user']);
  assert.deepEqual(env.rows.pets.map(row => row._id), ['admin-pet']);
  assert.deepEqual(env.rows.users.map(row => [row._id, row.status]), [['u', undefined], ['new', 'active']]);
});

test('cancelling a cleanup batch restores prior status and stale confirmations never touch a later batch', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'a', _openid: 'a-owner', role: 'user', status: 'active' },
    { _id: 'b', _openid: 'b-owner', role: 'user', status: 'banned' });
  const { env, app, advance } = fixture(t, initial, { snapshotIsolation: true });
  const cleanup = (phase, batchId) => app('adminCleanupNonAdmin', { phase, batchId });
  const prepared = await Promise.all([cleanup('prepare', null), cleanup('prepare', null)]);
  assert.equal(prepared.filter(result => result.code === 0).length, 1);
  const id = prepared.find(result => result.data).data.batchId;
  assert.equal((await app('adminSetUserStatus', { userId: 'a', status: 'cancelCleanup' })).code, -1);
  assert.equal((await cleanup('cancel', id)).data.status, 'cancelled');
  assert.deepEqual(env.rows.users.slice(1).map(user => [user.status, user.cleanup_pending]), [['active', null], ['banned', null]]);
  const next = (await cleanup('prepare', id)).data;
  advance(60_000);
  assert.equal((await cleanup('finish', id)).code, -1);
  assert.equal((await cleanup('status')).data.batchId, next.batchId);
  assert.equal(env.rows.users.length, 3);
});

test('account cleanup drains admitted writes, blocks login, and binds new requests to the recreated account', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'target', _openid: 'target-owner', role: 'user', status: 'active' });
  let enterWrite, allowWrite;
  const admitted = new Promise(resolve => { enterWrite = resolve; });
  const gate = new Promise(resolve => { allowWrite = resolve; });
  const { env, app, login, advance } = fixture(t, initial, { snapshotIsolation: true, async beforeRequest(command, args) {
    if (command === 'database.insertDocument' && args.collectionName === 'capsules') {
      enterWrite();
      await gate;
    }
  } });
  const as = openid => { env.cloud.getWXContext = () => ({ OPENID: openid }); };
  const remove = () => app('adminDeleteUser', { userId: 'target' });
  as('target-owner');
  const old = app('saveCapsule', { text: '已开始的请求' }, 'target');
  await admitted;
  as('owner');
  assert.equal((await remove()).reason, 'ACCOUNT_CLEANUP_PENDING');
  as('target-owner');
  assert.equal((await app('saveCapsule', { text: '新的请求' })).reason, 'ACCOUNT_BANNED');
  assert.equal((await login('authLogin')).reason, 'ACCOUNT_BANNED');
  as('owner');
  assert.equal((await app('adminSetUserStatus', { userId: 'target', status: 'active' })).code, -1);
  assert.equal((await app('adminSetRole', { userId: 'target', role: 'admin' })).code, -1);
  advance(59_999);
  assert.equal((await remove()).reason, 'ACCOUNT_CLEANUP_PENDING');
  allowWrite();
  assert.equal((await old).code, 0);
  advance(1);
  assert.equal((await remove()).data.deletedCapsules, 1);
  as('target-owner');
  assert.equal((await app('saveCapsule', { text: '账号已删' }, 'target')).reason, 'ACCOUNT_REQUIRED');
  const fresh = await login('authLogin');
  assert.notEqual(fresh.data.id, 'target');
  assert.equal((await app('saveCapsule', { text: '旧会话' }, 'target')).reason, 'ACCOUNT_REQUIRED');
  assert.equal((await app('saveCapsule', { text: '旧客户端' })).reason, 'ACCOUNT_REQUIRED');
  assert.equal((await app('saveCapsule', { text: '新账号' }, fresh.data.id)).code, 0);
  assert.equal(env.rows.capsules.length, 1);
  assert.equal(env.rows.capsules[0].text, '新账号');
});

test('cancelling a pending cleanup restores the exact previous access state', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'target', _openid: 'target-owner', role: 'user', status: 'banned' });
  const { env, app, advance } = fixture(t, initial);
  const remove = () => app('adminDeleteUser', { userId: 'target' });
  assert.equal((await remove()).reason, 'ACCOUNT_CLEANUP_PENDING');
  assert.equal((await app('adminSetUserStatus', { userId: 'target', status: 'cancelCleanup' })).status, 'banned');
  advance(60_000);
  assert.equal(env.rows.users[1].cleanup_pending, null);
  assert.equal(env.rows.users[1].status, 'banned');
  assert.equal((await remove()).reason, 'ACCOUNT_CLEANUP_PENDING');
  assert.equal(env.rows.users.length, 2);
});

test('an administrator cannot remove their own access', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  const { env, app } = fixture(t, initial, { snapshotIsolation: true });
  assert.match((await app('adminSetRole', { userId: 'u', role: 'user' })).message, /不能降级自己/);
  assert.match((await app('adminSetUserStatus', { userId: 'u', status: 'banned' })).message, /不能封禁自己/);
  assert.equal(env.rows.users[0].role, 'admin');
  assert.notEqual(env.rows.users[0].status, 'banned');
  assert.equal((await app('adminListUsers')).code, 0);
});

test('concurrent role and status changes keep at least one administrator able to sign in', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'other-admin', _openid: 'other', role: 'admin' });
  const { env, app } = fixture(t, initial, { snapshotIsolation: true });
  const as = (openid, action, data) => {
    env.cloud.getWXContext = () => ({ OPENID: openid });
    return app(action, data);
  };
  for (const action of ['adminSetRole', 'adminSetUserStatus']) {
    const conflicts = env.stats.conflicts;
    const first = as('owner', 'adminSetRole', { userId: 'other-admin', role: 'user' });
    const second = as('other', action, { userId: 'u', role: 'user', status: 'banned' });
    const results = await Promise.all([first, second]);
    assert.equal(results.filter(result => result.success === true).length, 1);
    assert.equal(results.filter(result => result.code === -1).length, 1);
    assert.ok(env.stats.conflicts > conflicts);
    assert.equal(env.rows.users.filter(user => user.role === 'admin' && user.status !== 'banned').length, 1);
    env.mutate('users', 'u', { role: 'admin', status: 'active' });
    env.mutate('users', 'other-admin', { role: 'admin', status: 'active' });
  }
});

test('a password reset cannot commit after the caller loses administrator access', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'target', _openid: 'target-owner', role: 'user', password: 'old-password' });
  let demote = true;
  const { env, app } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args, state) {
    if (demote && command === 'database.modifyDocument' && args.collectionName === 'users' && args.data.includes('scrypt-v1:')) {
      demote = false;
      state.mutate('users', 'u', { role: 'user' });
    }
  } });
  const result = await app('adminResetPassword', { userId: 'target', newPassword: 'new-password' });
  assert.equal(result.code, -1);
  assert.equal(env.rows.users[1].password, 'old-password');
});

test('account cleanup cannot pause or delete a user after the caller loses administrator access', async t => {
  const initial = seed();
  initial.users[0].role = 'admin';
  initial.users.push({ _id: 'target', _openid: 'target-owner', role: 'user' });
  initial.pets.push({ _id: 'pet', _openid: 'target-owner' });
  let demoteOn = 'database.modifyDocument';
  const { env, app, advance } = fixture(t, initial, { snapshotIsolation: true, beforeRequest(command, args, state) {
    if (command === demoteOn && args.collectionName === 'users' && args.query.includes('"target"')) {
      demoteOn = '';
      state.mutate('users', 'u', { role: 'user' });
    }
  } });
  const remove = () => app('adminDeleteUser', { userId: 'target' });
  assert.equal((await remove()).message, '无管理员权限');
  assert.equal(env.rows.users[1].cleanup_pending, undefined);
  env.mutate('users', 'u', { role: 'admin' });
  assert.equal((await remove()).reason, 'ACCOUNT_CLEANUP_PENDING');
  advance(60_000);
  demoteOn = 'database.removeDocument';
  assert.equal((await remove()).message, '无管理员权限');
  assert.equal(env.rows.users.length, 2);
  assert.equal(env.rows.pets.length, 1);
});

test('admin console uses verified data and reads already-unwrapped receipts', async () => {
  const filename = resolve(__dirname, '../miniprogram/pages/admin/admin.js');
  let page, listReads = 0, edit, toast;
  const cleanupPhases = [];
  const api = {
    adminDashboard: async () => { throw new Error('offline dashboard'); },
    adminListUsers: async () => { listReads++; return { list: [], total: 0 }; },
    adminListPets: async () => ({ list: [{ id: 'p', stage: 'ADULT', is_hatched: true, mood: 'happy' }], total: 1 }),
    adminListFeedbacks: async () => [],
    adminGetUserDetail: async () => ({ user: { id: 'u', created_at: now }, goalCount: 2 }),
    adminEditPet: async data => { edit = data; return { success: true }; },
    adminSetRole: async ({ role }) => ({ success: true, role }),
    adminCleanupNonAdmin: async ({ phase, batchId }) => {
      cleanupPhases.push([phase, batchId]);
      return { status: 'done', batchId: 'original', deletedUsers: 2, keptUsers: ['admin'], errors: ['offline partial failure'] };
    },
  };
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: () => api, Page: value => { page = value; }, console,
    wx: { getStorageSync: () => ({ role: 'admin' }), showLoading() {}, hideLoading() {}, showToast(options) { toast = options; },
      showModal: ({ success }) => success({ confirm: true }) },
  });
  page.setData = patch => Object.assign(page.data, patch);
  assert.equal(await page.loadAdminData(), false);
  assert.equal(page.data.isAdmin, false);
  assert.equal(page.data.adminLoadError, 'offline dashboard');
  assert.equal(listReads, 0);
  api.adminDashboard = async () => ({ stats: { totalPlatformXp: 12000 } });
  assert.equal(await page.loadAdminData(), true);
  assert.equal(page.data.totalPlatformXpText, '1.2万');
  assert.equal(page.data.petList[0].stageLabel, '成年');
  const tap = id => ({ currentTarget: { dataset: { id } } });
  await page.showUserDetail(tap('u'));
  assert.equal(page.data.detailUser.goalCount, 2);
  page.editPetStage(tap('p'));
  page.onPetStageChange({ detail: { value: '3' } });
  await page.savePetEdit();
  assert.equal(JSON.stringify(edit), JSON.stringify({ petId: 'p', stage: 'PERFECT' }));
  page.setData({ userList: [{ id: 'target', role: 'user' }] });
  const roleTap = role => ({ currentTarget: { dataset: { userId: 'target', role } } });
  await page.toggleUserRole(roleTap('user'));
  assert.equal(page.data.userList[0].role, 'admin');
  assert.equal(toast.icon, 'success');
  api.adminSetRole = async () => { throw '无管理员权限'; };
  await page.toggleUserRole(roleTap('admin'));
  assert.equal(page.data.userList[0].role, 'admin');
  assert.equal(toast.title, '无管理员权限');
  page.refreshData = () => {};
  await page.cleanupNonAdmin();
  assert.match(page.data.cleanupResult, /删除用户: 2/);
  assert.match(page.data.cleanupResult, /offline partial failure/);
  assert.deepEqual(cleanupPhases, [['status', undefined]]);
  assert.equal(page.data.cleanupCanStartNext, true);
  await page.cleanupNonAdmin({ currentTarget: { dataset: { newBatch: true } } });
  assert.deepEqual(cleanupPhases.slice(1), [['status', undefined], ['prepare', 'original']]);
});

test('concurrent first emotion saves settle one row and a quick mood change preserves its note', async t => {
  const { env, app } = fixture(t, seed(), { snapshotIsolation: true });
  const [first, second] = await Promise.all([
    app('recordEmotion', { mood_index: 0, mood_label: '开心', note: '保持原备注' }),
    app('recordEmotion', { mood_index: '2', mood_label: '低落' }),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(env.rows.emotions.length, 1);
  assert.equal(env.rows.emotions[0].note, '保持原备注');
  assert.equal(env.rows.emotions[0].date, date);
  const changed = await app('recordEmotion', { mood_index: 1, mood_label: '😐 平静' });
  assert.equal(changed.mood.note, '保持原备注');
  assert.equal((await app('recordEmotion', { mood_index: 9, mood_label: '无效' })).code, -1);
  assert.equal((await app('recordEmotion', { mood_index: 1, note: '长'.repeat(141) })).code, -1);
  const dashboard = await app('getDashboard');
  assert.equal(dashboard.data.todayEmotion.mood_label, '😐 平静');
  assert.equal('note' in dashboard.data.todayEmotion, false);
});

test('dashboard and weekly report pick the same latest legacy emotion and edits reuse that row', async t => {
  const initial = seed();
  initial.emotions.push(
    { _id: 'z-tied', _openid: 'owner', date, mood_label: '低落', note: '旧备注', created_at: now - 1000 },
    { _id: 'a-tied', _openid: 'owner', date, mood_label: '开心', created_at: now - 1000 },
    { _id: 'other', _openid: 'other', date, mood_label: '无关', created_at: now },
  );
  const { env, app } = fixture(t, initial, { snapshotIsolation: true });
  assert.equal((await app('getDashboard')).data.todayEmotion.mood_label, '低落');
  assert.equal((await app('getGrowthReport')).data.moods[0].label, '低落');
  assert.equal((await app('recordEmotion', { mood_index: 2, mood_label: '一般' })).mood.note, '旧备注');
  assert.equal(env.rows.emotions.length, 3);
  assert.equal(env.rows.emotions.find(row => row._id === 'z-tied').mood_label, '一般');
  assert.equal((await app('getGrowthReport')).data.moods[0].label, '一般');
});

test('emotion page preserves unconfirmed notes and Home does not replace the login session', async () => {
  const session = { id: 'session-id', openid: 'owner' };
  const app = { globalData: { currentOpenid: 'owner', userInfo: session } };
  const toasts = [];
  let received, respond;
  const api = {
    dashboard: async () => ({ user: { nickname: '当前资料' }, todayEmotion: { mood_label: '平静' } }),
    pets: async () => [],
    emotions: async data => { received = data; return { success: true }; },
  };
  const load = name => {
    const filename = resolve(__dirname, '../miniprogram/pages', name, name + '.js');
    const req = createRequire(filename);
    let page;
    runInNewContext(readFileSync(filename, 'utf8'), {
      require: id => id === '../../utils/cloudApi' ? api : req(id),
      Page: options => { page = options; }, getApp: () => app, console,
      wx: { showToast: options => toasts.push(options.title), getStorageSync() {} },
    }, { filename });
    page.setData = patch => Object.assign(page.data, patch);
    return page;
  };
  const home = load('home');
  await home.loadDashboard();
  assert.equal(app.globalData.userInfo, session);
  assert.equal(home.data.moodRecorded, '平静');
  assert.equal(home.data.selectedMood, 1);
  api.emotions = () => new Promise(resolve => { respond = resolve; });
  const saving = home.selectMood({ currentTarget: { dataset: { mood: 2 } } });
  app.globalData.currentOpenid = 'new';
  app.globalData.userInfo = { id: 'new-session', openid: 'new' };
  await home.loadDashboard();
  respond({ success: true, mood: { mood_label: '低落' } });
  await saving;
  assert.equal(home.data.moodRecorded, '平静');
  assert.deepEqual(toasts, []);
  const emotion = load('emotion');
  emotion.setData({ selectedMood: 0, note: '私人备注' });
  api.emotions = async data => { received = data; return { success: true }; };
  await emotion.submitEmotion();
  assert.equal(received.note, '私人备注');
  assert.equal(emotion.data.note, '私人备注');
  assert.match(toasts.pop(), /备注未确认/);
  api.emotions = async ({ note }) => ({ success: true, mood: { note } });
  await emotion.submitEmotion();
  assert.equal(emotion.data.note, '');
  assert.match(toasts.pop(), /已记录/);
});

test('Home ignores old reward replies and reconciles refreshes without counting XP twice', async () => {
  const filename = resolve(__dirname, '../miniprogram/pages/home/home.js');
  const req = createRequire(filename);
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'old' } } };
  const toasts = [];
  const signIns = [], taskSaves = [];
  let homeDate = '2026-11-10';
  const view = ({ xp = 0, signedIn = false, completed = false } = {}) => ({
    user: { streak_days: signedIn ? 1 : 0 }, todayGrowth: { xp },
    signedIn, todayTasks: [{ id: 't', completed }],
  });
  const api = { dashboard: async () => view(), pets: async () => [],
    dailyCheckin: () => new Promise(resolve => signIns.push(resolve)),
    taskCheckin: () => new Promise(resolve => taskSaves.push(resolve)),
  };
  let page;
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: id => id === '../../utils/cloudApi' ? api : id === '../../utils/planSchedule' ? { today: () => homeDate } : req(id),
    Page: options => { page = options; }, getApp: () => app,
    wx: { getStorageSync() {}, showToast: options => toasts.push(options.title) }, console: { log() {}, error() {} },
  }, { filename });
  page.setData = patch => Object.assign(page.data, patch);
  const check = () => page.quickCheckin({ currentTarget: { dataset: { id: 't' } } });
  await page.loadDashboard();
  const oldSignIn = page.dailySignIn();
  const oldTask = check();
  await page.dailySignIn();
  await check();
  assert.equal(signIns.length, 1);
  assert.equal(taskSaves.length, 1);

  // Same WeChat identity, different account record after re-registration.
  app.globalData.userInfo = { id: 'new' };
  await page.loadDashboard();
  const newSignIn = page.dailySignIn();
  const newTask = check();
  signIns[0]({ success: true, xp_earned: 10, streak_days: 5 });
  taskSaves[0]({ success: true, xp_earned: 20 });
  await Promise.all([oldSignIn, oldTask]);
  assert.equal(page.data.signingIn, true);
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.todayTasks[0].completed, false);
  assert.equal(page.data.todayGrowth.xp, 0);
  assert.deepEqual(toasts, []);

  api.dashboard = async () => view({ xp: 30, signedIn: true, completed: true });
  await page.loadDashboard();
  signIns[1]({ success: true, xp_earned: 10, streak_days: 1 });
  taskSaves[1]({ success: true, xp_earned: 20 });
  await Promise.all([newSignIn, newTask]);
  assert.equal(page.data.todayGrowth.xp, 30);
  assert.equal(page.data.signingIn, false);

  api.dashboard = async () => view();
  await page.loadDashboard();
  let reply;
  api.dashboard = () => new Promise(resolve => { reply = resolve; });
  const staleRefresh = page.loadDashboard();
  const finalTask = check();
  taskSaves[2]({ success: true, xp_earned: 20 });
  await finalTask;
  reply(view());
  await staleRefresh;
  assert.equal(page.data.todayTasks[0].completed, true);
  assert.equal(page.data.todayGrowth.xp, 20);

  api.dashboard = async () => view();
  await page.loadDashboard();
  const priorDay = page.dailySignIn();
  homeDate = '2026-11-11';
  signIns[2]({ success: true, xp_earned: 10, streak_days: 2 });
  await priorDay;
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.signingIn, false);
});

test('API provider saves cannot report success after a competing clear and first saves do not duplicate', async t => {
  const initial = seed();
  initial.api_keys = [
    { _id: 'old', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-existing-key', updated_at: 1 },
    { _id: 'legacy-duplicate', _openid: 'owner', provider: 'deepseek', api_key: 'synthetic-old-duplicate', updated_at: 0 },
    { _id: 'other', _openid: 'other', provider: 'deepseek', api_key: 'synthetic-foreign-key' },
  ];
  let block = true, fail = false, reached, resume;
  const writing = new Promise(resolve => { reached = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  const { env, app, logs } = fixture(t, initial, { snapshotIsolation: true, async beforeRequest(command, args) {
    if (block && command === 'database.modifyDocument' && args.collectionName === 'api_keys') {
      block = false;
      reached();
      await paused;
    }
    if (fail && command === 'database.modifyDocument' && args.collectionName === 'api_keys') {
      throw Error('offline storage rejected synthetic-replacement-key');
    }
  } });
  const save = options => app('saveApiKey', { provider: 'deepseek', ...options });
  const list = async () => (await app('listApiKeys')).data;
  const version = (await list())[0].version;
  const stale = save({ expected_version: version, model: 'deepseek-flash' });
  await writing;
  assert.equal((await save({ clear: true, expected_version: version })).cleared, true);
  resume();
  assert.equal((await stale).code, -1);
  assert.deepEqual(env.rows.api_keys.map(row => row._id), ['other']);
  const first = await Promise.all([
    save({ api_key: 'synthetic-first-new-key' }), save({ api_key: 'synthetic-second-new-key' }),
  ]);
  assert.equal(first.filter(result => result.success).length, 2);
  assert.equal(env.rows.api_keys.filter(row => row._openid === 'owner').length, 1);
  assert.equal((await save({ clear: true, expected_version: version })).code, -1);
  const [current] = await list();
  assert.notEqual(current.version, version);
  assert.ok(first.some(result => result.version === current.version));
  assert.equal('api_key' in current, false);
  const owner = env.rows.users[0];
  const prior = owner.ai_config_revision;
  fail = true;
  const rejected = await save({ api_key: 'synthetic-replacement-key' });
  assert.equal(rejected.code, -1);
  assert.equal(env.rows.users[0].ai_config_revision, prior);
  assert.equal(JSON.stringify({ rejected, logs }).includes('synthetic-replacement-key'), false);
});

test('growth logs and pet detail sort before limiting and expose query failures', async t => {
  const initial = seed();
  initial.pets.push({ _id: 'pet', _openid: 'owner', is_hatched: true });
  initial.growth_logs = Array.from({ length: 105 }, (_, index) => ({
    _id: 'log-' + index, _openid: 'owner', created_at: now + index, source: 'task',
  }));
  initial.growth_logs.push(
    { _id: 'latest-a', _openid: 'owner', created_at: now + 200, source: 'hatch' },
    { _id: 'latest-b', _openid: 'owner', created_at: now + 200, source: 'hatch' },
    { _id: 'other', _openid: 'other', created_at: now + 300, source: 'hatch' },
  );
  let fail = false;
  const { app } = fixture(t, initial, { beforeRequest(command, args) {
    if (fail && command === 'database.getDocument' && args.collectionName === 'growth_logs') throw Error('offline logs unavailable');
  } });
  const latest = await app('listGrowthLogs', { limit: '2' });
  assert.deepEqual(Array.from(latest.data, row => row._id), ['latest-b', 'latest-a']);
  assert.equal((await app('listGrowthLogs', { source: 'task', limit: 1 })).data[0]._id, 'log-104');
  assert.equal((await app('listGrowthLogs', { limit: 1000 })).data.length, 100);
  const detail = (await app('petDetail', { petId: 'pet' })).data;
  assert.equal(detail.growth_logs.length, 50);
  assert.equal(detail.growth_logs[0].id, 'latest-b');
  fail = true;
  assert.equal((await app('listGrowthLogs')).code, -1);
  assert.equal((await app('petDetail', { petId: 'pet' })).code, -1);
});

test('growth page distinguishes retry from empty data and keeps Beijing dates and XP values', async () => {
  const filename = resolve(__dirname, '../miniprogram/pages/growth/growth.js');
  const req = createRequire(filename);
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'old' } } };
  const api = { growthLogs: async () => { throw '离线读取失败'; } };
  let page;
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: id => id === '../../utils/cloudApi' ? api : req(id),
    Page: options => { page = options; }, getApp: () => app,
  }, { filename });
  page.setData = (patch, done) => { Object.assign(page.data, patch); done?.(); };
  await page.onShow();
  assert.equal(page.data.loadError, '离线读取失败');
  api.growthLogs = async () => [
    { _id: 'task', source: 'task', xp_change: '10', created_at: now },
    { _id: 'feed', source: 'item_use', xp_change: 0, xp_amount: 100, created_at: String(now) },
    { _id: 'hatch', source: 'hatch_pool', reason: '升级', created_at: 'invalid' },
  ];
  await page.loadLogs();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.logs[0].createdDate, date);
  assert.equal(page.data.logs[1].createdDate, date);
  assert.equal(page.data.logs[2].createdDate, '');
  assert.equal(page.data.stats.totalXp, 10);
  assert.equal(page.data.stats.levelUps, 0);
  const filter = value => page.setFilter({ currentTarget: { dataset: { filter: value } } });
  filter('xp');
  assert.deepEqual(Array.from(page.data.filteredLogs, row => row.id), ['task']);
  filter('pet_stage');
  assert.deepEqual(Array.from(page.data.filteredLogs, row => row.id), ['feed', 'hatch']);

  let reply;
  api.growthLogs = () => new Promise(resolve => { reply = resolve; });
  const old = page.loadLogs();
  app.globalData.userInfo = { id: 'new' };
  api.growthLogs = async () => [];
  await page.onShow();
  reply([{ _id: 'private-log', source: 'task' }]);
  await old;
  assert.equal(page.data.logs.length, 0);
  assert.equal(page.data.loadError, '');
});

test('failed reads stay errors and the report uses Beijing-week records only', async t => {
  let fail = false;
  const initial = seed();
  initial.goals.push({ _id: 'g', _openid: 'owner', title: 'fixture' });
  initial.tasks.push({ _openid: 'owner', date, goal_id: 'g', completed: true },
    { _openid: 'owner', date: '2026-11-08', completed: true },
    { _openid: 'owner', date: '2026-11-10', completed: false },
    { _openid: 'other', date, completed: true });
  initial.growth_logs.push({ _openid: 'owner', created_at: now - 200, xp_change: 8 },
    { _openid: 'owner', created_at: now - 3600000, xp_change: 99 });
  initial.emotions.push({ _openid: 'owner', date, mood_label: '平静' });
  const { app } = fixture(t, initial, { beforeRequest(command, args) {
    if (fail && command === 'database.getDocument' && args.collectionName === 'goals') throw Error('offline read failure');
  } });
  const report = (await app('getGrowthReport')).data;
  assert.equal(report.weekLabel, '2026-11-09 ~ 2026-11-15');
  assert.equal(report.totalTasks, 1);
  assert.equal(report.completedTasks, 1);
  assert.equal(report.xpEarned, 8);
  assert.equal(report.topGoal.title, 'fixture');
  assert.equal(report.moods[0].label, '平静');
  assert.equal(report.moods[1].label, '未到');
  fail = true;
  assert.equal((await app('listGoals')).code, -1);
  assert.equal((await app('getGrowthReport')).code, -1);
});
