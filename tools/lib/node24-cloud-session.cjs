// Management-only helper. Never logs or persists credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
module.exports = function cloudSession() {
  const root = path.resolve(__dirname, '../..');
  const folder = fs.realpathSync(JSON.parse(fs.readFileSync(path.join(root, '.migration/active-cloud-run.json'))).folder);
  assert(folder.startsWith(fs.realpathSync(path.join(root, '.migration')) + path.sep));
  const file = path.join(folder, 'run.json'), journal = JSON.parse(fs.readFileSync(file));
  assert.equal(journal.envId, 'cloud1-d5gz9j6zh654f4b36');
  assert(journal.approval);
  const proxy = 'http://127.0.0.1:12001';
  const r = spawnSync('C:/Program Files/nodejs/node.exe', [
    'C:/Program Files/nodejs/node_modules/@cloudbase/cli/bin/tcb', 'secrets', 'get', '-e', journal.envId, '--json',
  ], { encoding: 'utf8', env: { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy } });
  assert.equal(r.status, 0, 'Temporary credential retrieval failed');
  const c = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).data;
  assert(c?.secretId && c?.secretKey && c?.token, 'Temporary credentials unavailable');
  const imported = require(path.join(root, '.migration/node24-cloud-ops/node_modules/@cloudbase/manager-node'));
  const CloudBase = imported.default || imported;
  const manager = new CloudBase({ secretId: c.secretId, secretKey: c.secretKey, token: c.token,
    envId: journal.envId, region: 'ap-shanghai', proxy });
  return { root, folder, journal, manager, credentials: c,
    save: () => fs.writeFileSync(file, JSON.stringify(journal, null, 2) + '\n') };
};
