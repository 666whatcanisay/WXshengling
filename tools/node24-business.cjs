// Uses management credentials only for exact-ID verification / approved cleanup.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createManifest, runCleanup } = require('./lib/node24-business-test.cjs');
async function main() {
  const command = process.argv[2];
  assert(['prepare', 'inspect', 'cleanup', 'verify-cleaned'].includes(command), 'Use prepare, inspect, cleanup or verify-cleaned');
  const s = require('./lib/node24-cloud-session.cjs')();
  assert(s.journal.nativeReadonly?.passed, 'Native readonly check is required');
  const sdk = require(path.join(s.root, 'cloudfunctions/app/node_modules/@cloudbase/node-sdk'));
  const c = s.credentials;
  const db = sdk.init({ env: s.journal.envId, secretId: c.secretId, secretKey: c.secretKey,
    sessionToken: c.token, proxy: 'http://127.0.0.1:12001' }).database();
  const file = path.join(s.folder, 'business-test.json');
  const checkedRows = async query => {
    const result = await query.limit(2).get();
    assert(!result.code && Array.isArray(result.data), 'Query failed'); return result.data;
  };
  if (command === 'prepare') {
    assert(!s.journal.businessTest?.cleaned, 'This test was already cleaned');
    let m;
    if (fs.existsSync(file)) m = JSON.parse(fs.readFileSync(file));
    else {
      const users = await checkedRows(db.collection('users').where({ username: 'lzk' })
        .field({ _id: true, _openid: true, username: true, role: true, total_xp: true }));
      assert.equal(users.length, 1);
      const original = JSON.parse(fs.readFileSync(path.join(s.folder, 'business-before.json')));
      assert.equal(users[0]._openid, original.user._openid);
      const pools = await checkedRows(db.collection('user_growth_pool').where({ _openid: users[0]._openid })
        .field({ _id: true, _openid: true, growth_pool: true, total_earned: true }));
      assert(pools.length <= 1);
      m = createManifest(users[0], pools[0]);
      assert((await runCleanup(db, m)).noTestData);
      fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', { flag: 'wx' });
    }
    const config = { date: m.date, request: m.request, goalId: m.goalId, taskIds: m.taskIds, beforeXp: m.before.xp };
    const template = fs.readFileSync(path.join(__dirname, 'node24-manual-business.template.js'), 'utf8');
    const script = path.join(s.folder, 'manual-business.js');
    fs.writeFileSync(script, template.replace('/* NODE24_TEST_CONFIG */ null', JSON.stringify(config)));
    s.journal.businessTest = { prepared: true, createdAt: new Date().toISOString(), script,
      maxXpDelta: 30, maxGoals: 1, maxTasks: 3, cloudWritesNotYetObserved: true };
    s.save(); console.log(JSON.stringify({ prepared: true, script, cloudBusinessWrites: false }));
    return;
  }
  const m = JSON.parse(fs.readFileSync(file));
  if (command === 'verify-cleaned') {
    assert((await runCleanup(db, m)).alreadyCleaned, 'Cleanup marker missing');
    const getOne = async (name, id) => {
      const r = await db.collection(name).doc(id).get();
      assert(!r.code && Array.isArray(r.data) && r.data.length <= 1, 'Read failed'); return r.data[0];
    };
    const user = await getOne('users', m.userId), pool = await getOne('user_growth_pool', m.poolId);
    assert.equal(user._openid, m.owner); assert.equal(user.role, 'admin');
    const net = { xp: user.total_xp - m.before.xp,
      pool: (pool?.growth_pool || 0) - m.before.pool, earned: (pool?.total_earned || 0) - m.before.earned };
    assert.deepEqual(net, { xp: 0, pool: 0, earned: 0 }, 'Post-cleanup balances changed; inspect without further writes');
    const remaining = {};
    for (const name of ['goals', 'tasks']) {
      const rows = await checkedRows(db.collection(name).where({ publication_id: m.publicationId }).field({ _id: true }));
      remaining[name] = rows.length; assert.equal(rows.length, 0, 'Unexpected linked test rows');
    }
    s.journal.businessTest.postCleanup = { verifiedAt: new Date().toISOString(), netRewardDelta: net,
      linkedGoals: remaining.goals, linkedTasks: remaining.tasks, exactLogsAbsent: true, publicationMarkerRetained: true };
    s.save(); console.log(JSON.stringify(s.journal.businessTest.postCleanup)); return;
  }
  const preview = await runCleanup(db, m);
  console.log(JSON.stringify({ preview }));
  if (command === 'cleanup') {
    const result = await runCleanup(db, m, true);
    const verified = await runCleanup(db, m);
    assert(verified.alreadyCleaned || verified.noTestData);
    s.journal.businessTest = { ...s.journal.businessTest, cleanup: result, cleaned: true,
      cleanedAt: new Date().toISOString(), verified };
    s.save(); console.log(JSON.stringify({ cleanup: result, verified }));
  }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message) })); process.exitCode = 1; });
