const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..'), folder = path.join(root, 'agents/forest-steward')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
async function main() {
  const inputs = ['src/index.ts', 'package.json', 'package-lock.json', 'tsconfig.json']
  const sourceHash = hash(inputs.map(file => file + ':' + hash(fs.readFileSync(path.join(folder, file)))).join('\n'))
  const file = path.join(root, 'cloudfunctions/app/lib/stewardGraph.cjs'), manifestFile = path.join(folder, 'build.json')
  if (!process.argv.includes('--check')) {
    const req = createRequire(path.join(folder, 'package.json'))
    const built = await req('esbuild').build({ entryPoints: [path.join(folder, 'src/index.ts')], outfile: file, bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'inline', metafile: true })
    const builtins = require('node:module').builtinModules
    const externalDependencies = [...new Set(Object.values(built.metafile.outputs).flatMap(output => output.imports.filter(item => item.external && !item.path.startsWith('node:') && !builtins.includes(item.path)).map(item => item.path)))]
    if (externalDependencies.length) throw Error('管家产物仍需额外包：' + externalDependencies.join(','))
    fs.writeFileSync(manifestFile, JSON.stringify({ sourceHash, bundleHash: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size,
      langgraph: '1.6.1', checkpoint: '1.2.2', runtime: 'node24', externalDependencies }, null, 2) + '\n')
  }
  const report = JSON.parse(fs.readFileSync(manifestFile))
  if (sourceHash !== report.sourceHash || hash(fs.readFileSync(file)) !== report.bundleHash) throw Error('管家图源码/依赖或产物有变化，请重新构建并验证')
  console.log(JSON.stringify(report))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
