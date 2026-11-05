// Read-only cloud configuration evidence. Never emits account IDs or credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
async function main() {
  const { root, manager, journal } = require('./lib/node24-cloud-session.cjs')();
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'migration/node24/business-plan.json')));
  let sourceFilesVerified = 0;
  for (const f of plan.functions) for (const [name, expected] of Object.entries(f.files)) {
    const bytes = fs.readFileSync(path.join(root, '.migration/node24-bundled-0545996/functions', f.targetName, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Bundled source changed: ' + name);
    sourceFilesVerified++;
  }
  const functions = [];
  for (const name of ['app', 'login', 'init', 'app-node24', 'login-node24', 'init-node24']) {
    const d = await manager.functions.getFunctionDetail(name);
    if (name.endsWith('-node24')) { assert.equal(d.Runtime, 'Nodejs24.11'); assert.equal(d.Status, 'Active'); }
    functions.push({ name, runtime: d.Runtime, status: d.Status, codeSize: d.CodeSize,
      timeout: d.Timeout, memory: d.MemorySize, installDependency: d.InstallDependency });
  }
  const api = (Action, Param) => manager.commonService().call({ Action, Param: { EnvId: journal.envId, ...Param } });
  const collections = {};
  for (const name of ['users', 'goals', 'tasks', 'ai_plans', 'growth_logs', 'user_growth_pool']) {
    collections[name] = (await api('DescribeSafeRule', { CollectionName: name })).AclTag;
    assert.equal(collections[name], 'ADMINONLY');
  }
  const rules = JSON.parse((await api('DescribeSecurityRule', { ResourceType: 'FUNCTION' })).Rule);
  assert.equal(rules['init-node24'].invoke, false);
  const result = { observedAt: new Date().toISOString(), envId: journal.envId, sourceCommit: journal.sourceCommit,
    functions, collections, functionRules: rules, bundledSourceFilesVerified: sourceFilesVerified,
    packaging: { installDependency: false, bundledSdk: 'wx-server-sdk@2.4.0',
      reason: 'Node24 online dependency build failed; bundled original locked runtime dependencies' },
    nativeReadonly: journal.nativeReadonly || { passed: false },
    normalFrontendMappingChanged: false, initInvoked: false,
    businessTest: journal.businessTest ? { prepared: journal.businessTest.prepared,
      userReported: journal.businessTest.userReported || null,
      cleaned: journal.businessTest.cleaned || false, cleanup: journal.businessTest.cleanup || null,
      postCleanup: journal.businessTest.postCleanup || null } : null };
  fs.writeFileSync(path.join(root, 'docs/audit/node24-cloud-rollout-20261105.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ functions: functions.length, activeNode24Copies: 3, restrictedCollections: 6,
    nativeReadonlyPassed: result.nativeReadonly.passed, initClientInvocation: false }));
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message) })); process.exitCode = 1; });
