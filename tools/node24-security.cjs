// Apply only the user's approved collection / init-copy restrictions via native APIs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const session = require('./lib/node24-cloud-session.cjs')();
  const { manager, folder, journal, save } = session;
  const before = JSON.parse(fs.readFileSync(path.join(folder, 'native-security-before.json')));
  const api = (Action, Param) => manager.commonService().call({ Action, Param: { EnvId: journal.envId, ...Param } });
  const step = async (name, operation) => {
    const row = { name, status: 'started', at: new Date().toISOString() }; journal.steps.push(row); save();
    try { row.result = await operation(); row.status = 'verified'; save(); console.log(JSON.stringify(row)); }
    catch (error) { row.status = 'failed'; row.error = { code: error.code || '', message: String(error.message) }; save(); throw error; }
  };
  if (process.argv[2] === 'block-init') {
    await step('block-client-init', async () => {
      const current = await api('DescribeSecurityRule', { ResourceType: 'FUNCTION' });
      assert.equal(current.AclTag, 'CUSTOM');
      const rules = JSON.parse(current.Rule), original = JSON.parse(before.functions.Rule);
      assert.deepEqual(rules['*'], original['*'], 'Wildcard rule changed; inspect before merging');
      if (rules['init-node24']) assert.equal(rules['init-node24'].invoke, false);
      const desired = { ...rules, 'init-node24': { invoke: false } };
      await api('ModifySecurityRule', { ResourceType: 'FUNCTION', AclTag: 'CUSTOM', Rule: JSON.stringify(desired) });
      const after = await api('DescribeSecurityRule', { ResourceType: 'FUNCTION' });
      assert.deepEqual(JSON.parse(after.Rule), desired);
      return { initClientInvocation: false, existingRulesPreserved: true };
    });
  } else if (process.argv[2] === 'harden-collections') {
    for (const CollectionName of ['users', 'goals', 'tasks', 'ai_plans', 'growth_logs', 'user_growth_pool']) {
      await step('native-acl:' + CollectionName, async () => {
        const current = await api('DescribeSafeRule', { CollectionName });
        assert(['PRIVATE', 'ADMINONLY'].includes(current.AclTag), 'Unexpected rule; inspect before modifying');
        if (current.AclTag !== 'ADMINONLY') {
          assert.equal(current.AclTag, before.collections[CollectionName].AclTag);
          assert.equal(current.Rule, before.collections[CollectionName].Rule);
          await api('ModifyDatabaseACL', { CollectionName, AclTag: 'ADMINONLY' });
        }
        const after = await api('DescribeSafeRule', { CollectionName });
        assert.equal(after.AclTag, 'ADMINONLY');
        return { collection: CollectionName, permission: after.AclTag };
      });
    }
  } else throw new Error('Use block-init or harden-collections');
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message) })); process.exitCode = 1; });
