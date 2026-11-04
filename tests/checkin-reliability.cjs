// Checks checkAdmin + transactional taskCheckin with a database stub that
// simulates per-row versioning, mutual exclusion and automatic transaction
// retries. No cloud, no model; production handler code via vm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const clone = v => JSON.parse(JSON.stringify(v));

let _rows;
function reset(seed) {
  _rows = clone(seed);
  for (const name of Object.keys(_rows)) {
    for (const r of _rows[name] || []) {
      r._version = r._version || 0;
    }
  }
}

let lockQueue = Promise.resolve();
async function withLock(fn) {
  const prev = lockQueue;
  let done;
  lockQueue = prev.then(() => new Promise(r => { done = r; }));
  await prev;
  try {
    return await fn();
  } finally {
    done();
  }
}

function makeDb(hooks = {}) {
  const matches = (row, filter) => Object.entries(filter || {}).every(([k, v]) => {
    if (v && v.kind === 'neq') return row[k] !== v.value;
    if (v && v.kind === 'eq') return row[k] === v.value;
    if (v && v.kind === 'in')  return v.value.includes(row[k]);
    if (v && v.__kind === 'neq') return row[k] !== v.value;
    if (v && v.__kind === 'eq')  return row[k] === v.value;
    if (v && v.__kind === 'in')  return v.value.includes(row[k]);
    return row[k] === v;
  });
  const applyUpdate = (row, data) => {
    for (const [k, v] of Object.entries(data || {})) {
      if (v && (v.kind === 'inc' || v.__kind === 'inc')) row[k] = (row[k] || 0) + v.value;
      else row[k] = clone(v);
    }
    row._version = (row._version || 0) + 1;
    row.updated_at = Date.now();
  };

  const docOps = (name, id) => ({
    async get() {
      const row = (_rows[name] || []).find(r => r._id === id);
      return { data: row ? clone(row) : null };
    },
    async update({ data }) {
      if (hooks.beforeUpdate) {
        const r = hooks.beforeUpdate(name, id, data);
        if (r === false) throw new Error('HOOK_UPDATE_REJECTED:' + name + ':' + id);
        if (r instanceof Error) throw r;
      }
      const row = (_rows[name] || []).find(r => r._id === id);
      if (!row) return { stats: { updated: 0 }, updated: 0 };
      applyUpdate(row, data);
      return { stats: { updated: 1 }, updated: 1 };
    },
    async remove() {
      const before = (_rows[name] || []).length;
      _rows[name] = (_rows[name] || []).filter(r => r._id !== id);
      return { removed: before - (_rows[name] || []).length };
    },
    async add({ data }, optId) {
      if (hooks.beforeAdd) {
        const r = hooks.beforeAdd(name, data, optId);
        if (r === false) throw new Error('HOOK_ADD_REJECTED:' + name);
        if (r instanceof Error) throw r;
      }
      const id = optId || 'row-' + Math.random().toString(36).slice(2);
      _rows[name] ||= [];
      const row = { _id: id, _version: 1, created_at: Date.now(), ...clone(data) };
      _rows[name].push(row);
      return { _id: id };
    },
  });
  const query = (name, filter = {}) => ({
    where: next => query(name, next),
    doc: id => docOps(name, id),
    async get() {
      return { data: clone((_rows[name] || []).filter(r => matches(r, filter))) };
    },
    async count() {
      return { total: (_rows[name] || []).filter(r => matches(r, filter)).length };
    },
    async add({ data }, optId) { return docOps(name, null).add({ data }, optId); },
    async update({ data }) {
      let updated = 0;
      for (const row of _rows[name] || []) {
        if (!matches(row, filter)) continue;
        applyUpdate(row, data); updated++;
      }
      return { stats: { updated }, updated };
    },
  });

  return {
    collection: name => query(name),
    command: {
      inc: v => ({ kind: 'inc', value: v }),
      neq: v => ({ kind: 'neq', value: v }),
      eq:  v => ({ kind: 'eq',  value: v }),
      in:  v => ({ kind: 'in',  value: v }),
    },
    async runTransaction(callback) {
      // Realistic transaction stub with rollback-on-failure.
      // Before running the callback we snapshot every row that will be
      // touched via tx.doc/get/update/add. If the callback throws we
      // restore the snapshots; otherwise we leave the writes.
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await withLock(async () => {
            const snapshots = new Map();          // collection|id → cloned row (pre-tx)
            const createdRows = [];               // rows added inside tx, removed on rollback
            const snapshotOf = (name, id) => {
              const key = name + '|' + id;
              if (!snapshots.has(key)) {
                const row = (_rows[name] || []).find(r => r._id === id);
                snapshots.set(key, row ? clone(row) : null);
              }
            };
            const restoreSnapshots = () => {
              for (const [key, snap] of snapshots.entries()) {
                const [name, id] = key.split('|');
                const idx = (_rows[name] || []).findIndex(r => r._id === id);
                if (snap === null) { if (idx >= 0) _rows[name].splice(idx, 1); }
                else {
                  if (idx >= 0) _rows[name][idx] = clone(snap);
                  else (_rows[name] ||= []).push(clone(snap));
                }
              }
              for (const [name, id] of createdRows) {
                _rows[name] = (_rows[name] || []).filter(r => r._id !== id);
              }
            };
            const tx = {
              collection(name) {
                return {
                  doc(id) {
                    snapshotOf(name, id);
                    return docOps(name, id);
                  },
                  async add({ data }, optId) {
                    const row = await docOps(name, null).add({ data }, optId);
                    createdRows.push([name, row._id]);
                    return row;
                  },
                };
              },
            };
            try {
              return await callback(tx);
            } catch (e) {
              restoreSnapshots();
              throw e;
            }
          });
        } catch (e) {
          lastErr = e;
          // Only retry on transaction commit conflict; business / DB errors
          // are propagated directly (matching real SDK semantics).
          if (e.code !== 'DB_TRANSACTION_CONFLICT') throw e;
          await new Promise(r => setImmediate(r));
        }
      }
      throw lastErr;
    },
  };
}

function buildContext(db) {
  const appFile = path.join(root, 'cloudfunctions/app/index.js');
  const appRequire = createRequire(appFile);
  const quiet = { log() {}, warn() {}, error() {} };
  const context = vm.createContext({
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'owner' }) };
      if (name === 'https') return { request() { throw new Error('network disabled'); } };
      return appRequire(name);
    },
    exports: {}, console: quiet, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(appFile, 'utf8'), context);
  return {
    call(name, data = {}, openid = 'owner') {
      context.__input__ = clone(data); context.__openid__ = openid;
      return vm.runInContext(`${name}(__openid__, __input__)`, context);
    },
  };
}

(async () => {
  let checks = 0;
  const eq = (a, b, msg) => { assert.deepEqual(clone(a), clone(b), msg); checks++; };
  const db = makeDb();
  const { call } = buildContext(db);

  // --- checkAdmin: unrelated caller rejected; legitimate admin accepted; openid empty rejected; db error rejected ---
  reset({ users: [
    { _id: 'admin-row', _openid: 'real-admin', username: 'lzk', role: 'admin' },
    { _id: 'user-row',  _openid: 'normal',    username: 'foo',  role: 'user' },
  ]});
  eq(await call('checkAdmin', {}, 'stranger'), false, 'stranger must not get admin');
  eq(await call('checkAdmin', {}, 'normal'),   false, 'normal user must not get admin');
  eq(await call('checkAdmin', {}, 'real-admin'), true, 'actual admin still passes');
  eq(await call('checkAdmin', {}, ''),          false, 'empty openid must be rejected');
  eq(await call('checkAdmin', {}, undefined),   false, 'undefined openid must be rejected');

  // --- taskCheckin: basic 10XP flow ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [{ _id: 'task-1', _openid: 'owner', completed: false, xp_reward: 10 }],
    goals: [{ _id: 'goal-1', _openid: 'owner', completed_days: 0 }],
    user_growth_pool: [],
    growth_logs: [],
  });
  const res = await call('taskCheckin', { task_id: 'task-1' });
  eq(res.success, true);
  eq(res.xp_earned, 10);
  eq(_rows.users[0].total_xp, 10, 'user total_xp increased exactly once');
  eq(_rows.tasks[0].completed, true);
  eq(_rows.user_growth_pool.length, 1, 'first checkin creates exactly one pool');
  eq(_rows.user_growth_pool[0].growth_pool, 10);
  eq(_rows.growth_logs.length, 1);
  eq(_rows.growth_logs[0].xp_change, 10);

  // --- same task attempted twice (backend short-circuit, no duplicate award) ---
  const dup = await call('taskCheckin', { task_id: 'task-1' });
  eq(dup.already_completed, true);
  eq(_rows.users[0].total_xp, 10, 'XP unchanged on retry');
  eq(_rows.user_growth_pool[0].growth_pool, 10);
  eq(_rows.growth_logs.length, 1, 'no duplicate log');

  // --- 20-way concurrent call on same 10XP task ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [{ _id: 'task-2', _openid: 'owner', completed: false, xp_reward: 10 }],
    goals: [{ _id: 'goal-2', _openid: 'owner', completed_days: 0 }],
    user_growth_pool: [],
    growth_logs: [],
  });
  const N = 20;
  const results = await Promise.all(Array.from({ length: N }, () => call('taskCheckin', { task_id: 'task-2' })));
  const oks = results.filter(r => r.success && !r.already_completed).length;
  const dups = results.filter(r => r.already_completed).length;
  eq(oks + dups, N, 'every call returned a clear outcome');
  eq(oks, 1, 'exactly one call performed the settlement');
  eq(dups, N - 1, 'all remaining calls are already_completed');
  eq(_rows.users[0].total_xp, 10, 'XP was awarded exactly once');
  eq(_rows.tasks[0].completed, true);
  eq(_rows.growth_logs.length, 1, 'exactly one growth log');
  eq(_rows.user_growth_pool.length, 1, 'exactly one growth pool row');
  eq(_rows.user_growth_pool[0].growth_pool, 10);

  // --- same user, different tasks: both settle, neither lost ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [
      { _id: 'task-a', _openid: 'owner', completed: false, xp_reward: 10 },
      { _id: 'task-b', _openid: 'owner', completed: false, xp_reward: 15 },
    ],
    user_growth_pool: [{ _id: 'pool-row', _openid: 'owner', growth_pool: 0, total_earned: 0 }],
    growth_logs: [],
  });
  const [ra, rb] = await Promise.all([
    call('taskCheckin', { task_id: 'task-a' }),
    call('taskCheckin', { task_id: 'task-b' }),
  ]);
  eq(_rows.users[0].total_xp, 25);
  eq([_rows.tasks[0].completed, _rows.tasks[1].completed], [true, true]);
  eq(_rows.user_growth_pool.length, 1, 'existing random-id pool row reused');
  eq(_rows.user_growth_pool[0].growth_pool, 25);
  eq(_rows.growth_logs.length, 2);
  eq(ra.xp_earned + rb.xp_earned, 25);

  // --- no pool row beforehand: a new pool is created with deterministic id, not duplicated by retries ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [{ _id: 'task-c', _openid: 'owner', completed: false, xp_reward: 5 }],
    user_growth_pool: [],
    growth_logs: [],
  });
  await call('taskCheckin', { task_id: 'task-c' });
  eq(_rows.user_growth_pool.length, 1);
  eq(_rows.user_growth_pool[0].growth_pool, 5);
  eq(_rows.user_growth_pool[0]._openid, 'owner');

  // --- future task remains blocked; cross-user task rejected ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [
      { _id: 'task-future', _openid: 'owner', date: '2030-01-01', completed: false, xp_reward: 10 },
      { _id: 'task-other',  _openid: 'someone', completed: false, xp_reward: 10 },
    ],
  });
  const futureRes = await call('taskCheckin', { task_id: 'task-future' });
  eq(futureRes.code, -1);
  const otherRes = await call('taskCheckin', { task_id: 'task-other' });
  eq(otherRes.code, -1);

  // --- mid-transaction failure: if users.inc throws, task must not be half-completed ---
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [{ _id: 'task-fail', _openid: 'owner', completed: false, xp_reward: 10 }],
    user_growth_pool: [],
    growth_logs: [],
  });
  // Throw on the 2nd doc.update() inside any transaction (handler order:
  // tasks.update → users.update). The 1st update goes through, so rollback
  // must restore the task row.
  let updateCount = 0;
  const failDb = makeDb({
    beforeUpdate(name, id, data) {
      updateCount++;
      if (updateCount === 2) return new Error('SIMULATED_DB_FAILURE');
    },
  });
  const { call: callFail } = buildContext(failDb);
  try { await callFail('taskCheckin', { task_id: 'task-fail' }); }
  catch (e) { eq(e.message, 'SIMULATED_DB_FAILURE'); }
  eq(_rows.tasks.find(t => t._id === 'task-fail').completed, false, 'task must not be half-completed after tx rollback');
  eq(_rows.users[0].total_xp, 0);
  eq(_rows.growth_logs.length, 0);

  // Retry succeeds from clean slate.
  const { call: callOk } = buildContext(makeDb());
  reset({
    users: [{ _id: 'u', _openid: 'owner', total_xp: 0 }],
    tasks: [{ _id: 'task-retry', _openid: 'owner', completed: false, xp_reward: 10 }],
    user_growth_pool: [], growth_logs: [],
  });
  const r = await callOk('taskCheckin', { task_id: 'task-retry' });
  eq(r.success, true);
  eq(_rows.users[0].total_xp, 10);
  eq(_rows.tasks.find(t => t._id === 'task-retry').completed, true);

  console.log(JSON.stringify({
    passed: checks,
    failed: 0,
    scope: 'checkAdmin + transactional taskCheckin with mutex-based local db stub; real cloud transaction / auto-retry / conflict detection not exercised',
  }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
