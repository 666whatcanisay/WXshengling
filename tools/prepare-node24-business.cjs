// Build a pinned Git revision, not working files. No CloudBase calls or deployment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
function main() {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node.js 24.x');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'migration/node24/business-plan.json'), 'utf8'));
  assert(/^[a-f0-9]{40}$/.test(plan.sourceCommit), 'Plan must pin a full Git commit');
  assert.deepEqual(process.argv.slice(2), ['--source-commit', plan.sourceCommit], 'Pass the exact source commit from business-plan.json');
  assert.equal(git(['rev-parse', '--verify', plan.sourceCommit + '^{commit}']).toString().trim(), plan.sourceCommit);
  assert.equal(plan.runtime, 'Nodejs24.11');
  assert.equal(plan.envId, 'cloud1-d5gz9j6zh654f4b36');
  assert.deepEqual(plan.functions.map(f => f.sourceName), ['app', 'login', 'init']);
  const files = new Map(), config = { envId: plan.envId, functionRoot: './functions', functions: [] };
  for (const entry of plan.functions) {
    assert.equal(entry.targetName, entry.sourceName + '-node24');
    const prefix = 'cloudfunctions/' + entry.sourceName + '/';
    const entries = git(['ls-tree', '-r', '-z', plan.sourceCommit, '--', prefix]).toString().split('\0').filter(Boolean);
    assert.deepEqual(entries.map(line => line.split('\t')[1].slice(prefix.length)).sort(), Object.keys(entry.files).sort(), 'Tracked source files differ from allowlist');
    for (const file of Object.keys(entry.files)) {
      assert(/^(index\.js|config\.json|package(?:-lock)?\.json|lib\/[A-Za-z]+\.js)$/.test(file), 'Unexpected source path');
      const treeEntry = entries.find(line => line.endsWith('\t' + prefix + file));
      assert(/^(100644|100755) blob /.test(treeEntry), 'Symlinks/submodules are not source files');
      const bytes = git(['show', plan.sourceCommit + ':' + prefix + file]);
      assert.equal(hash(bytes), entry.files[file], 'Source hash differs from plan: ' + prefix + file);
      files.set('functions/' + entry.targetName + '/' + file, bytes);
    }
    const base = 'functions/' + entry.targetName + '/';
    const pkg = JSON.parse(files.get(base + 'package.json'));
    const lock = JSON.parse(files.get(base + 'package-lock.json'));
    assert.equal(pkg.engines.node, '24.x');
    assert.equal(lock.packages[''].engines.node, '24.x');
    assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
    config.functions.push({ name: entry.targetName, runtime: plan.runtime, handler: entry.handler,
      timeout: entry.timeout, memorySize: entry.memorySize, installDependency: true,
      ignore: ['node_modules/**', '.env*', '*.pem', '*.p12', '*.pfx'] });
  }
  files.set('cloudbaserc.json', json(config));
  files.set('manifest.json', json({ version: 1, purpose: plan.purpose, sourceCommit: plan.sourceCommit,
    envId: plan.envId, runtime: plan.runtime, planSha256: hash(fs.readFileSync(path.join(root, 'migration/node24/business-plan.json'))),
    files: Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)])) }));
  const parent = path.join(root, '.migration');
  const output = path.join(parent, 'node24-business-' + plan.sourceCommit.slice(0, 7));
  if (fs.existsSync(parent)) assert(!fs.lstatSync(parent).isSymbolicLink(), 'Migration parent must not be a symlink');
  if (fs.existsSync(output)) {
    assert(!fs.lstatSync(output).isSymbolicLink(), 'Output must not be a symlink');
    const actual = [];
    const walk = (dir, prefix = '') => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        assert(!item.isSymbolicLink(), 'Output must not contain symlinks');
        if (item.isDirectory()) walk(path.join(dir, item.name), prefix + item.name + '/');
        else actual.push(prefix + item.name);
      }
    };
    walk(output);
    assert.deepEqual(actual.sort(), [...files.keys()].sort(), 'Output file list changed; nothing overwritten');
    for (const [file, bytes] of files) assert.equal(hash(fs.readFileSync(path.join(output, file))), hash(bytes), 'Output changed: ' + file + '; nothing overwritten');
  } else {
    for (const [file, bytes] of files) {
      const destination = path.join(output, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
    }
  }
  console.log(JSON.stringify({ status: 'prepared-and-verified', sourceCommit: plan.sourceCommit, output,
    files: files.size, targets: config.functions.map(f => f.name), deployed: false }, null, 2));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
