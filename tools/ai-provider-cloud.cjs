// Single-file Node24 AI configuration hotfix. prepare is read-only in the cloud.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process')
const hash = value => createHash('sha256').update(value).digest('hex')
const name = 'app-node24', envId = 'cloud1-d5gz9j6zh654f4b36'
const fields = ['FunctionName', 'Runtime', 'Handler', 'Timeout', 'MemorySize', 'InstallDependency', 'Role', 'VpcConfig', 'Environment', 'Triggers', 'Type']
function fingerprint(detail) { return hash(JSON.stringify(fields.map(key => [key, detail[key]]))) }
function hashes(folder) {
  const result = {}
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Unexpected symlink')
      const relative = prefix + entry.name, full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, relative + '/'); else result[relative] = hash(fs.readFileSync(full))
    }
  }
  walk(folder); return result
}
async function main() {
  const command = process.argv[2]
  assert(['prepare', 'apply'].includes(command))
  if (command === 'apply') assert(process.argv.includes('--approved-app-node24-index'), 'Requires explicit stage approval')
  const s = require('./lib/node24-cloud-session.cjs')()
  assert.equal(s.journal.envId, envId)
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:12001'
  const folder = path.join(s.root, '.migration/ai-provider-fix-20261106'), baseline = path.join(folder, 'baseline')
  const patch = path.join(folder, 'patch/functions', name)
  const manifestPath = path.join(folder, 'manifest.json')
  fs.mkdirSync(folder, { recursive: true })
  const detail = await s.manager.functions.getFunctionDetail(name)
  assert.equal(detail.Runtime, 'Nodejs24.11'); assert.equal(detail.Status, 'Active')
  const source = fs.readFileSync(path.join(s.root, 'cloudfunctions/app/index.js'))
  if (command === 'prepare' && !fs.existsSync(manifestPath)) {
    assert(!fs.existsSync(baseline), 'Prior partial download exists; inspect before reuse')
    fs.mkdirSync(baseline)
    await s.manager.functions.downloadFunctionCode({ envId, functionName: name, destPath: baseline })
    const head = execFileSync('git', ['show', 'HEAD:cloudfunctions/app/index.js'], { cwd: s.root })
    const before = fs.readFileSync(path.join(baseline, 'index.js'))
    assert.equal(before.toString().replace(/\r\n/g, '\n'), head.toString().replace(/\r\n/g, '\n'), 'Cloud source differs from reviewed Git baseline; rebase before preparing')
    fs.mkdirSync(patch, { recursive: true }); fs.writeFileSync(path.join(patch, 'index.js'), source)
    const rollback = path.join(folder, 'rollback/functions', name)
    fs.mkdirSync(rollback, { recursive: true }); fs.writeFileSync(path.join(rollback, 'index.js'), before)
    fs.writeFileSync(manifestPath, JSON.stringify({ status: 'prepared-not-deployed', envId, function: name, runtime: detail.Runtime,
      modified: detail.ModTime, configHash: fingerprint(detail), baselineFiles: hashes(baseline), patchedIndex: hash(source),
      changedFiles: ['index.js'], databaseWrites: false, modelCalls: false, miniProgramPublish: false }, null, 2) + '\n')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  assert.equal(detail.ModTime, manifest.modified, 'Function changed since preparation')
  assert.equal(fingerprint(detail), manifest.configHash, 'Function configuration changed')
  assert.equal(hash(source), manifest.patchedIndex, 'Local patch changed; prepare a reviewed version')
  assert.deepEqual(hashes(baseline), manifest.baselineFiles)
  const { FunctionPacker, CodeType } = require(path.join(s.root, '.migration/node24-cloud-ops/node_modules/@cloudbase/manager-node/lib/function/packer'))
  const packer = new FunctionPacker({ codeType: CodeType.File, name, root: path.join(folder, 'patch/functions'), ignore: [], incrementalPath: 'index.js' })
  const temp = path.resolve(require('node:os').tmpdir(), '.cloudbase_temp_' + name)
  assert.equal(path.resolve(packer.tmpPath), temp)
  if (fs.existsSync(temp)) { assert(!fs.lstatSync(temp).isSymbolicLink()); assert(fs.readdirSync(temp).every(file => file === name + '.zip')) }
  await packer.build()
  const zip = Buffer.from(await packer.getBase64Code(), 'base64'), names = []
  for (let offset = 0; offset + 46 <= zip.length; offset++) if (zip.readUInt32LE(offset) === 0x02014b50) {
    const length = zip.readUInt16LE(offset + 28); names.push(zip.subarray(offset + 46, offset + 46 + length).toString())
    offset += 45 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32)
  }
  assert.deepEqual(names, ['index.js'])
  if (command === 'apply') {
    await s.manager.functions.updateFunctionIncrementalCode({ func: { name, runtime: detail.Runtime },
      functionRootPath: path.join(folder, 'patch/functions'), addFiles: 'index.js' })
    let after
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await s.manager.functions.getFunctionDetail(name)
      if (after.Status === 'Active') break
      assert(!/Failed/.test(after.Status), 'Function update failed')
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    assert.equal(after.Status, 'Active'); assert.equal(fingerprint(after), manifest.configHash)
    const afterDir = path.join(folder, 'after-' + Date.now()); fs.mkdirSync(afterDir)
    await s.manager.functions.downloadFunctionCode({ envId, functionName: name, destPath: afterDir })
    const afterHashes = hashes(afterDir), expected = { ...manifest.baselineFiles, 'index.js': manifest.patchedIndex }
    assert.deepEqual(afterHashes, expected, 'Downloaded code changed beyond approved index.js')
    manifest.status = 'deployed-and-source-verified'; manifest.verifiedAt = new Date().toISOString()
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  const result = { status: manifest.status, envId, function: name, runtime: detail.Runtime, changedFiles: ['index.js'],
    preservedFiles: Object.keys(manifest.baselineFiles).length - 1, incrementalZipFiles: names, databaseWrites: false, modelCalls: false, miniProgramPublish: false }
  fs.mkdirSync(path.join(s.root, 'docs/audit'), { recursive: true })
  fs.writeFileSync(path.join(s.root, 'docs/audit/ai-provider-fix-20261106.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message || 'Operation failed') })); process.exitCode = 1 })
