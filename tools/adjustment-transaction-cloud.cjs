// Cloud read-only prepare. apply requires this stage's explicit deployment approval.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const hash = value => createHash('sha256').update(value).digest('hex')
const name = 'app-node24', envId = 'cloud1-d5gz9j6zh654f4b36'
const files = ['lib/adjustmentApplication.js']
const pattern = files.length === 1 ? files[0] : '{' + files.join(',') + '}' // Installed packer expects one glob string.
const fields = ['FunctionName', 'Runtime', 'Handler', 'Timeout', 'MemorySize', 'InstallDependency', 'Role', 'VpcConfig', 'Environment', 'Triggers', 'Type']
const fingerprint = detail => hash(JSON.stringify(fields.map(key => [key, detail[key]])))
function hashes(folder) {
  const result = {}
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = prefix + entry.name
      assert(!entry.isSymbolicLink(), 'Unexpected symlink')
      if (entry.isDirectory()) walk(full, relative + '/'); else result[relative] = hash(fs.readFileSync(full))
    }
  }
  walk(folder); return result
}
async function main() {
  const command = process.argv[2]
  assert(['prepare', 'apply'].includes(command))
  if (command === 'apply') assert(process.argv.includes('--approved-adjustment-stage5b'), 'Requires the existing stage 5B five-file deployment approval; this file is within that scope')
  const s = require('./lib/node24-cloud-session.cjs')()
  assert.equal(s.journal.envId, envId)
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:12001'
  const runName = 'adjustment-stage5b-txfix-20261106'
  const folder = path.join(s.root, '.migration', runName), baseline = path.join(folder, 'baseline')
  const patch = path.join(folder, 'patch/functions', name), manifestPath = path.join(folder, 'manifest.json')
  const detail = await s.manager.functions.getFunctionDetail(name)
  assert.equal(detail.Runtime, 'Nodejs24.11'); assert.equal(detail.Status, 'Active'); assert.equal(detail.Timeout, 30); assert.equal(detail.MemorySize, 256)
  const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(s.root, 'cloudfunctions/app', file))]))
  if (command === 'prepare' && !fs.existsSync(manifestPath)) {
    assert(!fs.existsSync(baseline), 'Inspect prior partial download before reuse')
    fs.mkdirSync(baseline, { recursive: true })
    await s.manager.functions.downloadFunctionCode({ envId, functionName: name, destPath: baseline })
    const previous = JSON.parse(fs.readFileSync(path.join(s.root, '.migration/adjustment-stage5b-20261106/manifest.json')))
    assert.equal(previous.status, 'deployed-and-source-verified')
    const baselineFiles = hashes(baseline)
    assert.deepEqual(baselineFiles, { ...previous.baselineFiles, ...previous.patchFiles }, 'Cloud differs from verified preceding deployment')
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(patch, file)), { recursive: true }); fs.writeFileSync(path.join(patch, file), sources[file]) }
    const rollback = path.join(folder, 'rollback/functions', name)
    for (const file of files.filter(file => baselineFiles[file])) { fs.mkdirSync(path.dirname(path.join(rollback, file)), { recursive: true }); fs.copyFileSync(path.join(baseline, file), path.join(rollback, file)) }
    fs.writeFileSync(manifestPath, JSON.stringify({ status: 'prepared-not-deployed', envId, function: name, runtime: detail.Runtime,
      modified: detail.ModTime, configHash: fingerprint(detail), baselineFiles,
      patchFiles: Object.fromEntries(files.map(file => [file, hash(sources[file])])), changedFiles: files,
      databaseWrites: false, modelCalls: false, miniProgramPublish: false }, null, 2) + '\n')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  assert.equal(detail.ModTime, manifest.modified, 'Function changed since preparation')
  assert.equal(fingerprint(detail), manifest.configHash, 'Function configuration changed')
  assert.deepEqual(hashes(baseline), manifest.baselineFiles)
  assert.deepEqual(hashes(patch), manifest.patchFiles, 'Patch package changed')
  if (command === 'prepare' && process.argv.includes('--refresh-reviewed-local')) {
    for (const file of files) fs.writeFileSync(path.join(patch, file), sources[file])
    manifest.patchFiles = Object.fromEntries(files.map(file => [file, hash(sources[file])]))
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  for (const file of files) assert.equal(hash(sources[file]), manifest.patchFiles[file], 'Local source changed after preparing')
  const { FunctionPacker, CodeType } = require(path.join(s.root, '.migration/node24-cloud-ops/node_modules/@cloudbase/manager-node/lib/function/packer'))
  const packer = new FunctionPacker({ codeType: CodeType.File, name, root: path.join(folder, 'patch/functions'), ignore: [], incrementalPath: pattern })
  const temp = path.resolve(require('node:os').tmpdir(), '.cloudbase_temp_' + name)
  assert.equal(path.resolve(packer.tmpPath), temp)
  if (fs.existsSync(temp)) { assert(!fs.lstatSync(temp).isSymbolicLink()); assert(fs.readdirSync(temp).every(file => file === name + '.zip')) }
  await packer.build()
  const zip = Buffer.from(await packer.getBase64Code(), 'base64'), names = []
  for (let offset = 0; offset + 46 <= zip.length; offset++) if (zip.readUInt32LE(offset) === 0x02014b50) {
    const length = zip.readUInt16LE(offset + 28); names.push(zip.subarray(offset + 46, offset + 46 + length).toString())
    offset += 45 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32)
  }
  assert.deepEqual(names.sort(), [...files].sort())
  if (command === 'apply') {
    await s.manager.functions.updateFunctionIncrementalCode({ func: { name, runtime: detail.Runtime }, functionRootPath: path.join(folder, 'patch/functions'), addFiles: pattern })
    let after
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await s.manager.functions.getFunctionDetail(name)
      if (after.Status === 'Active') break
      assert(!/Failed/.test(after.Status), 'Function update failed')
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    assert.equal(after.Status, 'Active'); assert.equal(fingerprint(after), manifest.configHash)
    const dest = path.join(folder, 'after-' + Date.now()); fs.mkdirSync(dest)
    await s.manager.functions.downloadFunctionCode({ envId, functionName: name, destPath: dest })
    assert.deepEqual(hashes(dest), { ...manifest.baselineFiles, ...manifest.patchFiles }, 'Unexpected file changes')
    manifest.status = 'deployed-and-source-verified'; manifest.verifiedAt = new Date().toISOString()
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  const result = { status: manifest.status, envId, function: name, runtime: detail.Runtime, changedFiles: files,
    preservedFiles: Object.keys(manifest.baselineFiles).filter(file => !files.includes(file)).length, expectedTotalFiles: Object.keys({ ...manifest.baselineFiles, ...manifest.patchFiles }).length, incrementalZipFiles: names, databaseWrites: false, modelCalls: false, miniProgramPublish: false }
  fs.writeFileSync(path.join(s.root, 'docs/audit', runName + '.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message || 'Operation failed') })); process.exitCode = 1 })
