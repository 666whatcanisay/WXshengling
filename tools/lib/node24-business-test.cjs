// Management-side bounded test cleanup. No cloud SDK initialization or credentials here.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const dateAt = milliseconds => new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 10);
const number = value => { assert(Number.isFinite(value) && value >= 0, 'Invalid balance'); return value; };

function createManifest(user, pool, now = Date.now()) {
  assert.equal(user.username, 'lzk'); assert.equal(user.role, 'admin');
  assert(user._id && user._openid);
  if (pool) assert.equal(pool._openid, user._openid);
  const today = dateAt(now), tomorrow = dateAt(now + 86400000);
  const publication_id = 'node24-check-' + today + '-' + randomBytes(6).toString('hex');
  const request = { publication_id, source_plan_id: '',
    goal: { title: 'Node24联调（待清理）', target_days: 2, start_date: today, stages: [] },
    tasks: [
      { title: '联调今日A', date: today, stage: 1, estimated_minutes: 1, xp_reward: 10 },
      { title: '联调今日B', date: today, stage: 1, estimated_minutes: 1, xp_reward: 20 },
      { title: '联调明日拒绝检查', date: tomorrow, stage: 2, estimated_minutes: 1, xp_reward: 5 },
    ] };
  const publicationId = 'pub_' + hash(JSON.stringify([user._openid, 'draft', publication_id]));
  return { version: 1, envId: 'cloud1-d5gz9j6zh654f4b36', date: today, createdAt: now, request,
    owner: user._openid, userId: user._id, poolId: pool?._id || 'pool:' + user._openid, poolExisted: !!pool,
    before: { xp: number(user.total_xp), pool: pool ? number(pool.growth_pool) : 0,
      earned: pool ? number(pool.total_earned) : 0 },
    publicationId, goalId: 'pg_' + hash(publicationId),
    taskIds: request.tasks.map((_, i) => 'pt_' + hash(publicationId + ':' + i)) };
}

function validateManifest(m) {
  assert.equal(m.version, 1); assert.equal(m.envId, 'cloud1-d5gz9j6zh654f4b36');
  assert(m.owner && m.userId && m.poolId);
  assert(/^node24-check-\d{4}-\d{2}-\d{2}-[a-f0-9]{12}$/.test(m.request.publication_id));
  assert.equal(m.request.source_plan_id, '');
  assert.equal(m.request.goal.start_date, m.date); assert.equal(m.request.goal.target_days, 2);
  assert.equal(m.request.tasks.length, 3);
  assert.deepEqual(m.request.tasks.map(t => t.xp_reward), [10, 20, 5]);
  assert.deepEqual(m.request.tasks.map(t => t.date), [m.date, m.date, dateAt(Date.parse(m.date + 'T00:00:00+08:00') + 86400000)]);
  assert.equal(m.publicationId, 'pub_' + hash(JSON.stringify([m.owner, 'draft', m.request.publication_id])));
  assert.equal(m.goalId, 'pg_' + hash(m.publicationId));
  assert.deepEqual(m.taskIds, [0, 1, 2].map(i => 'pt_' + hash(m.publicationId + ':' + i)));
  Object.values(m.before).forEach(number);
}

// Works with the installed raw @cloudbase/database API. Unlike wx-server-sdk,
// its update/remove return updated/deleted directly and may return errors as data.
async function runCleanup(db, m, apply = false) {
  validateManifest(m);
  return db.runTransaction(async tx => {
    const get = async (name, id) => {
      const result = await tx.collection(name).doc(id).get();
      assert(!result.code, 'Database read failed: ' + name); return result.data;
    };
    const own = row => { if (row) assert.equal(row._openid, m.owner, 'Ownership changed'); return row; };
    const record = own(await get('ai_plans', m.publicationId));
    const goal = own(await get('goals', m.goalId));
    const tasks = [], logs = [];
    for (const id of m.taskIds) {
      tasks.push(own(await get('tasks', id)));
      logs.push(own(await get('growth_logs', 'checkin-log:' + id)));
    }
    const user = own(await get('users', m.userId)), pool = own(await get('user_growth_pool', m.poolId));
    assert(user, 'User missing'); assert.equal(user.username, 'lzk'); assert.equal(user.role, 'admin');
    const empty = !goal && tasks.every(t => !t) && logs.every(l => !l);
    if (record?.status === 'publication_cleaned') {
      assert(empty, 'Data reappeared after cleanup');
      return { alreadyCleaned: true, removed: 0, reversedXp: 0 };
    }
    if (!record) {
      assert(empty, 'Test rows exist without receipt');
      return { noTestData: true, removed: 0, reversedXp: 0 };
    }
    assert.equal(record.kind, 'plan_publication');
    assert(['publication_done', 'publication_pending'].includes(record.status));
    assert.equal(record.goal_id, m.goalId); assert.deepEqual(record.task_ids, m.taskIds);
    const draft = { goal: { title: m.request.goal.title, target_days: 2, start_date: m.date,
      end_date: m.request.tasks[2].date, stages: m.request.goal.stages }, tasks: m.request.tasks };
    assert.deepEqual(record.draft, draft, 'Confirmed draft changed');
    assert.equal(record.fingerprint, hash(JSON.stringify(draft)), 'Fingerprint changed');
    if (record.status === 'publication_pending') assert(empty, 'Pending receipt has partial business data');
    else {
      assert(goal && tasks.every(Boolean), 'Published batch is incomplete');
      assert.equal(goal.publication_id, m.publicationId);
      for (const [key, value] of Object.entries(draft.goal)) assert.deepEqual(goal[key], value);
    }
    let delta = 0;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i], log = logs[i];
      if (!task) { assert(!log); continue; }
      assert.equal(task.goal_id, m.goalId); assert.equal(task.publication_id, m.publicationId);
      for (const [key, value] of Object.entries(m.request.tasks[i])) assert.deepEqual(task[key], value);
      assert.equal(typeof task.completed, 'boolean');
      if (i === 2) assert.equal(task.completed, false, 'Future task was completed');
      assert.equal(!!log, task.completed, 'Completion/log mismatch');
      if (log) {
        assert.equal(log.source, 'task'); assert.equal(log.xp_change, task.xp_reward);
        assert.equal(log.reason, '完成任务: ' + task.title); delta += log.xp_change;
      }
    }
    assert(delta <= 30);
    assert.equal(number(user.total_xp), m.before.xp + delta, 'XP has unrelated changes; stop cleanup');
    if (m.poolExisted || delta) assert(pool, 'Pool missing');
    if (pool) {
      assert.equal(number(pool.growth_pool), m.before.pool + delta, 'Pool has unrelated changes; stop cleanup');
      assert.equal(number(pool.total_earned), m.before.earned + delta, 'Earned total changed; stop cleanup');
      if (!m.poolExisted) {
        assert(delta > 0, 'Unexpected pool created outside settlement');
        assert.equal(pool._id, 'pool:' + m.owner);
        assert(Object.keys(pool).every(k => ['_id', '_openid', 'growth_pool', 'total_earned', 'created_at', 'updated_at'].includes(k)), 'New pool was used outside test');
      }
    }
    const removed = (goal ? 1 : 0) + tasks.filter(Boolean).length + logs.filter(Boolean).length + (!m.poolExisted && pool ? 1 : 0);
    const result = { dryRun: !apply, removed, reversedXp: delta, completedTasks: logs.filter(Boolean).length,
      futureTaskUntouched: true, publicationMarkerRetained: true };
    if (!apply) return result;
    const update = async (name, id, patch) => {
      const r = await tx.collection(name).doc(id).update(patch);
      assert(!r.code && r.updated === 1, 'Update failed: ' + name);
    };
    const remove = async (name, id) => {
      const r = await tx.collection(name).doc(id).remove();
      assert(!r.code && r.deleted === 1, 'Delete failed: ' + name);
    };
    if (delta) {
      await update('users', m.userId, { total_xp: db.command.inc(-delta), updated_at: Date.now() });
      if (m.poolExisted) await update('user_growth_pool', m.poolId, {
        growth_pool: db.command.inc(-delta), total_earned: db.command.inc(-delta), updated_at: Date.now() });
    }
    if (!m.poolExisted && pool) await remove('user_growth_pool', m.poolId);
    for (let i = 0; i < tasks.length; i++) {
      if (logs[i]) await remove('growth_logs', 'checkin-log:' + m.taskIds[i]);
      if (tasks[i]) await remove('tasks', m.taskIds[i]);
    }
    if (goal) await remove('goals', m.goalId);
    // Preserve one inert receipt so accidentally rerunning the old Console script
    // cannot recreate the same batch or award it again after cleanup.
    await update('ai_plans', m.publicationId, { status: 'publication_cleaned', draft: null,
      cleanedAt: Date.now(), updatedAt: Date.now(), reversed_test_xp: delta });
    return result;
  });
}
module.exports = { createManifest, validateManifest, runCleanup };
