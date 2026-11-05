// Local-only, single-file artifact preparation. Never connects to the cloud.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { buildLegacyPatch, hash, plan } = require('./lib/legacy-app-patch.cjs');
const root = path.resolve(__dirname, '..');
function prepare(baselineFile) {
  const baseline = fs.readFileSync(baselineFile);
  const canonical = execFileSync('git', ['show', plan.canonicalCommit + ':' + plan.canonicalPath], { cwd: root });
  const patch = buildLegacyPatch(baseline, canonical);
  const folder = path.join(root, '.migration/legacy-app-reliability-20261105');
  const files = new Map([
    ['patch/functions/app/index.js', patch.code],
    ['rollback/functions/app/index.js', baseline],
  ]);
  // Write only known files; reruns verify rather than overwrite any changes.
  for (const [relative, bytes] of files) {
    const file = path.join(folder, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) assert.equal(hash(fs.readFileSync(file)), hash(bytes), 'Existing artifact changed');
    else fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  const manifest = { ...plan, preparedAt: new Date().toISOString(), baselineHash: patch.baselineHash,
    patchedHash: patch.patchedHash, preservedOutsideFunctions: true, cloudDeployed: false };
  const file = path.join(folder, 'manifest.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  else assert.equal(JSON.parse(fs.readFileSync(file)).patchedHash, patch.patchedHash);
  console.log(JSON.stringify({ folder, baselineHash: patch.baselineHash, patchedHash: patch.patchedHash,
    changedFiles: ['index.js'], changedFunctions: patch.changedFunctions, cloudDeployed: false }));
}
if (require.main === module) {
  try { assert.equal(process.argv.length, 3, 'Usage: node tools/prepare-legacy-app.cjs <verified baseline index.js>'); prepare(path.resolve(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
