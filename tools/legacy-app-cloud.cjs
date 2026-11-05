// Scoped single-file update of the published legacy app. No database writes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { plan, hash } = require('./lib/legacy-app-patch.cjs');
const fields = ['FunctionName', 'Runtime', 'Namespace', 'Handler', 'Timeout', 'MemorySize',
  'InstallDependency', 'Role', 'VpcConfig', 'Environment', 'Triggers', 'Type'];
const versions = folder => Object.fromEntries(['wx-server-sdk', '@cloudbase/database', '@cloudbase/node-sdk']
  .map(name => [name, JSON.parse(fs.readFileSync(path.join(folder, 'node_modules', name, 'package.json'))).version]));
function fileHashes(folder) {
  const result = {};
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Unexpected symlink in downloaded package');
      const relative = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, relative + '/'); else result[relative] = hash(fs.readFileSync(file));
    }
  }
  walk(folder); return result;
}
async function main() {
  const command = process.argv[2]; assert(['preflight', 'apply'].includes(command));
  const s = require('./lib/node24-cloud-session.cjs')();
  assert.equal(s.journal.envId, plan.envId);
  // Download helper honors process proxy variables; no OS proxy changes.
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:12001';
  const folder = path.join(s.root, '.migration/legacy-app-reliability-20261105');
  const backup = path.join(s.root, '.migration/legacy-app-cloud-backup-20261105');
  const original = JSON.parse(fs.readFileSync(path.join(backup, 'metadata-before.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
  assert.equal(hash(fs.readFileSync(path.join(backup, 'source/index.js'))), plan.baselineIndexSha256);
  const patch = path.join(folder, 'patch/functions/app/index.js');
  assert.equal(hash(fs.readFileSync(patch)), manifest.patchedHash);
  assert.equal(hash(fs.readFileSync(path.join(folder, 'rollback/functions/app/index.js'))), plan.baselineIndexSha256);
  const current = await s.manager.functions.getFunctionDetail('app');
  assert.equal(current.Runtime, plan.runtime); assert.equal(current.Status, 'Active');
  assert.equal(current.ModTime, original.ModTime, 'Original app changed; stop and rebase patch');
  for (const key of fields) assert.deepEqual(current[key], original[key], 'Configuration changed: ' + key);
  const api = (Action, Param) => s.manager.commonService().call({ Action, Param: { EnvId: plan.envId, ...Param } });
  const rules = await api('DescribeSecurityRule', { ResourceType: 'FUNCTION' });
  const nativeRules = JSON.parse(rules.Rule); assert.equal(nativeRules['init-node24'].invoke, false);
  for (const CollectionName of ['users', 'goals', 'tasks', 'ai_plans', 'growth_logs', 'user_growth_pool'])
    assert.equal((await api('DescribeSafeRule', { CollectionName })).AclTag, 'ADMINONLY');
  // The SDK packer clears its own named temp directory. Validate that target
  // before build and before the SDK repeats this build during the real update.
  const { FunctionPacker, CodeType } = require(path.join(s.root, '.migration/node24-cloud-ops/node_modules/@cloudbase/manager-node/lib/function/packer'));
  const packer = new FunctionPacker({ codeType: CodeType.File, name: 'app',
    root: path.join(folder, 'patch/functions'), ignore: [], incrementalPath: 'index.js' });
  const expectedTemp = path.resolve(require('node:os').tmpdir(), '.cloudbase_temp_app');
  assert.equal(path.resolve(packer.tmpPath), expectedTemp);
  if (fs.existsSync(expectedTemp)) {
    assert(!fs.lstatSync(expectedTemp).isSymbolicLink());
    assert(fs.readdirSync(expectedTemp).every(name => name === 'app.zip'), 'Unexpected files in SDK temp directory');
  }
  await packer.build();
  const zip = Buffer.from(await packer.getBase64Code(), 'base64');
  // ZIP central directory names: only index.js may be uploaded.
  const zipNames = [];
  for (let i = 0; i + 46 <= zip.length; i++) if (zip.readUInt32LE(i) === 0x02014b50) {
    const length = zip.readUInt16LE(i + 28); zipNames.push(zip.subarray(i + 46, i + 46 + length).toString());
    i += 45 + length + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  assert.deepEqual(zipNames, ['index.js'], 'Incremental ZIP contains unexpected files');
  const preview = { observedAt: new Date().toISOString(), envId: plan.envId, functionName: 'app',
    runtime: current.Runtime, timeout: current.Timeout, memory: current.MemorySize,
    baselineHash: plan.baselineIndexSha256, patchedHash: manifest.patchedHash,
    changedFiles: ['index.js'], changedFunctions: ['checkAdmin', 'taskCheckin'],
    sdkVersions: versions(path.join(backup, 'source')), rulesUnchanged: true,
    databaseWrites: false, miniProgramPublish: false, incrementalZipFiles: zipNames, incrementalZipBytes: zip.length };
  fs.writeFileSync(path.join(folder, 'preview.json'), JSON.stringify(preview, null, 2) + '\n');
  if (command === 'preflight') { console.log(JSON.stringify({ ...preview, deployed: false })); return; }
  // Approval is written only after the user confirms this concrete original-app update.
  const approval = JSON.parse(fs.readFileSync(path.join(folder, 'approval.json')));
  assert.equal(approval.envId, plan.envId); assert.equal(approval.functionName, 'app');
  assert.equal(approval.patchedHash, manifest.patchedHash); assert.equal(approval.action, 'incremental-index-update');
  const deploymentFile = path.join(folder, 'deployment.json');
  assert(!fs.existsSync(deploymentFile), 'Previous deployment attempt exists; inspect rather than repeat');
  const deployment = { ...preview, startedAt: new Date().toISOString(), status: 'started' };
  const save = () => fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2) + '\n'); save();
  try {
    const response = await s.manager.functions.updateFunctionIncrementalCode({
      func: { name: 'app', runtime: plan.runtime }, functionRootPath: path.join(folder, 'patch/functions'), addFiles: 'index.js' });
    deployment.requestId = response.RequestId;
    let after;
    for (let i = 0; i < 20; i++) {
      after = await s.manager.functions.getFunctionDetail('app');
      if (after.Status === 'Active') break;
      assert(!/Failed/.test(after.Status), 'Cloud update failed');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    assert.equal(after.Status, 'Active');
    for (const key of fields) assert.deepEqual(after[key], original[key], 'Configuration changed: ' + key);
    const afterDir = path.join(folder, 'cloud-after'); fs.mkdirSync(afterDir);
    await s.manager.functions.downloadFunctionCode({ envId: plan.envId, functionName: 'app', destPath: afterDir });
    const beforeFiles = fileHashes(path.join(backup, 'source')), afterFiles = fileHashes(afterDir);
    assert.equal(afterFiles['index.js'], manifest.patchedHash, 'Deployed code does not match patch');
    delete beforeFiles['index.js']; delete afterFiles['index.js'];
    assert.deepEqual(afterFiles, beforeFiles, 'Files beyond index.js changed');
    const ruleAfter = await api('DescribeSecurityRule', { ResourceType: 'FUNCTION' });
    assert.equal(ruleAfter.AclTag, rules.AclTag); assert.deepEqual(JSON.parse(ruleAfter.Rule), nativeRules);
    deployment.status = 'code-and-config-verified'; deployment.verifiedAt = new Date().toISOString();
    deployment.unchangedOtherFiles = Object.keys(afterFiles).length;
    console.log(JSON.stringify({ deployed: true, indexHash: manifest.patchedHash,
      unchangedOtherFiles: deployment.unchangedOtherFiles, runtime: after.Runtime, nativeUserChecksPending: true }));
  } catch (error) {
    deployment.status = 'needs-inspection'; deployment.error = { code: error.code || '', message: String(error.message) };
    throw error;
  } finally { save(); }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message) })); process.exitCode = 1; });
