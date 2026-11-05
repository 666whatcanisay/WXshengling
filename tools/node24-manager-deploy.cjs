// Alternate deployment transport for the approved copies. Credentials stay in memory.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const name = process.argv[2];
  assert(['login-node24', 'init-node24'].includes(name), 'Only the remaining approved copies');
  const { folder, journal, manager } = require('./lib/node24-cloud-session.cjs')();
  const file = path.join(folder, 'run.json');
  assert.equal(journal.envId, 'cloud1-d5gz9j6zh654f4b36');
  assert(journal.approval);
  if (name === 'init-node24') assert(journal.steps.some(s => s.name === 'block-client-init' && s.status === 'verified'));
  const config = JSON.parse(fs.readFileSync(path.join(root, '.migration/node24-bundled-0545996/cloudbaserc.json')));
  const func = config.functions.find(f => f.name === name);
  const step = { name: 'proxy-manager-deploy:' + name, status: 'started', at: new Date().toISOString() };
  journal.steps.push(step); fs.writeFileSync(file, JSON.stringify(journal, null, 2) + '\n');
  try {
    await manager.functions.createFunction({ func: { ...func, isWaitInstall: true },
      functionRootPath: path.join(root, '.migration/node24-bundled-0545996/functions'), force: false, deployMode: 'cos' });
    const d = await manager.functions.getFunctionDetail(name);
    assert.equal(d.Runtime, 'Nodejs24.11'); assert.equal(d.Status, 'Active');
    step.status = 'verified'; step.result = { name: d.FunctionName, runtime: d.Runtime,
      status: d.Status, installDependency: d.InstallDependency, codeSize: d.CodeSize };
    console.log(JSON.stringify(step.result));
  } catch (error) {
    step.status = 'failed';
    step.error = { code: error.code || '', message: typeof error.message === 'string' ? error.message
      : error.message?.Message || error.message?.message || 'Non-string manager error' };
    console.error(JSON.stringify(step.error)); process.exitCode = 1;
  } finally { fs.writeFileSync(file, JSON.stringify(journal, null, 2) + '\n'); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
