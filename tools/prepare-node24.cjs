// Local artifact builder only. Never calls CloudBase or invokes business handlers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const projectRoot = path.resolve(__dirname, '..');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function main() {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node.js 24.x to prepare migration artifacts');
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'Usage: npm run prepare:node24 -- --source-dir <downloaded-production-directory>');
  assert.equal(args[0], '--source-dir', 'Only --source-dir is supported; output stays in .migration/node24');
  const sourceRoot = fs.realpathSync(path.resolve(args[1]));
  const outputRoot = path.join(projectRoot, '.migration', 'node24');
  const outputParent = path.dirname(outputRoot);
  if (fs.existsSync(outputParent)) assert(!fs.lstatSync(outputParent).isSymbolicLink(), 'Migration parent must not be a symlink');
  const plan = readJson(path.join(projectRoot, 'migration/node24/plan.json'));
  assert.deepEqual(plan.functions.map(item => item.sourceName), ['app', 'login', 'init']);
  assert.equal(plan.runtime, 'Nodejs24.11');
  const files = new Map();
  const config = { envId: plan.envId, functionRoot: './functions', functions: [] };

  for (const entry of plan.functions) {
    assert.equal(entry.targetName, `${entry.sourceName}-node24`, 'Only new suffixed function names are allowed');
    const sourceDir = fs.realpathSync(path.join(sourceRoot, entry.sourceName));
    const relative = path.relative(sourceRoot, sourceDir);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Source directory escapes baseline');
    const index = fs.readFileSync(path.join(sourceDir, 'index.js'));
    assert.equal(hash(index), entry.sourceIndexSha256, `${entry.sourceName}: source differs from approved production baseline`);
    const pkg = readJson(path.join(sourceDir, 'package.json'));
    const lock = readJson(path.join(sourceDir, 'package-lock.json'));
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'Source package and lock dependencies must match');
    pkg.engines = { ...pkg.engines, node: '24.x' };
    lock.packages[''].engines = { ...lock.packages[''].engines, node: '24.x' };
    const prefix = `functions/${entry.targetName}/`;
    files.set(prefix + 'index.js', index);
    files.set(prefix + 'package.json', json(pkg));
    files.set(prefix + 'package-lock.json', json(lock));
    const sourceConfig = path.join(sourceDir, 'config.json');
    if (fs.existsSync(sourceConfig)) files.set(prefix + 'config.json', fs.readFileSync(sourceConfig));
    config.functions.push({ name: entry.targetName, runtime: plan.runtime, timeout: entry.timeout,
      memorySize: entry.memorySize, handler: entry.handler, installDependency: true,
      ignore: ['node_modules/**', '.env*', '*.pem', '*.p12', '*.pfx'] });
  }
  files.set('cloudbaserc.json', json(config));
  const manifest = { version: 1, source: plan.source, envId: plan.envId, runtime: plan.runtime,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };
  files.set('manifest.json', json(manifest));

  // Never delete/overwrite an existing directory. Exact reruns validate and reuse it.
  if (fs.existsSync(outputRoot)) {
    assert(!fs.lstatSync(outputRoot).isSymbolicLink(), 'Output must not be a symlink');
    const actualFiles = [];
    function walk(dir, prefix = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + item.name;
        assert(!item.isSymbolicLink(), 'Generated artifacts must not contain symlinks');
        if (item.isDirectory()) walk(path.join(dir, item.name), name + '/');
        else actualFiles.push(name);
      }
    }
    walk(outputRoot);
    assert.deepEqual(actualFiles.sort(), [...files.keys()].sort(), 'Existing output has unexpected files; nothing overwritten');
    for (const [name, bytes] of files) assert.equal(hash(fs.readFileSync(path.join(outputRoot, name))), hash(bytes), `Existing artifact modified: ${name}; nothing overwritten`);
  } else {
    for (const [name, bytes] of files) {
      const dest = path.join(outputRoot, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes, { flag: 'wx' });
    }
  }
  console.log(JSON.stringify({ status: 'prepared-and-verified', output: outputRoot, files: files.size,
    targets: config.functions.map(item => item.name), runtime: plan.runtime, deployed: false }, null, 2));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
