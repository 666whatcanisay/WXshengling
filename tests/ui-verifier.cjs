const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { inspectProject, resolveCompiler, compileProject } = require('../tools/verify-ui.cjs')
let checks = 0
const eq = (a, b) => { assert.deepEqual(a, b); checks++ }
const reject = (f, pattern) => { assert.throws(f, pattern); checks++ }
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-forest-check-test-'))
const write = (file, data) => { const p = path.join(folder, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p }
const app = { pages: ['pages/ai/ai', 'pages/forest-steward/forest-steward'], tabBar: { custom: true, list: [{ pagePath: 'pages/ai/ai' }] } }
try {
  write('project.config.json', { miniprogramRoot: 'mini/' }); write('mini/app.json', app); write('mini/app.wxss', 'page{}')
  for (const base of ['pages/ai/ai', 'pages/forest-steward/forest-steward', 'custom-tab-bar/index']) {
    write('mini/' + base + '.js', ''); write('mini/' + base + '.wxml', '<view/>')
  }
  write('mini/custom-tab-bar/index.json', { component: true })
  let report = inspectProject(folder)
  eq(report.registeredPages, 2); eq(report.templates.length, 3); eq(report.styles.length, 1)
  fs.unlinkSync(path.join(folder, 'mini/pages/ai/ai.wxml'))
  reject(() => inspectProject(folder), /Missing file:.*ai.wxml/)
  write('mini/pages/ai/ai.wxml', '<include src="./part.wxml"/><wxs src="./util.wxs" module="m"/>')
  reject(() => inspectProject(folder), /part.wxml/)
  write('mini/pages/ai/part.wxml', '<view/>'); write('mini/pages/ai/util.wxs', 'module.exports = {}')
  write('mini/pages/ai/ai.wxss', '@import "./shared.wxss";')
  reject(() => inspectProject(folder), /shared.wxss/)
  write('mini/pages/ai/shared.wxss', '.card{}')
  write('mini/pages/ai/ai.json', { usingComponents: { card: '/components/card/index' } })
  reject(() => inspectProject(folder), /Missing file/)
  for (const ext of ['js', 'wxml']) write('mini/components/card/index.' + ext, '')
  write('mini/components/card/index.json', {})
  reject(() => inspectProject(folder), /component:true/)
  write('mini/components/card/index.json', { component: true, usingComponents: { self: './index' } })
  report = inspectProject(folder)
  eq(report.templates.length, 5); eq(report.styles.length, 3); eq(report.dependencies.length, 2)
  write('mini/app.json', { ...app, tabBar: { list: [{ pagePath: 'missing' }] } })
  reject(() => inspectProject(folder), /Unregistered tabBar/)
  write('mini/app.json', { ...app, pages: ['pages/ai/ai'] })
  reject(() => inspectProject(folder), /Unregistered AI page/)
  write('mini/app.json', { pages: ['../outside'] })
  reject(() => inspectProject(folder), /Path leaves project/)
  write('mini/app.json', app)
  write('mini/pages/ai/ai.json', '{')
  reject(() => inspectProject(folder), /JSON|property name/i)
  write('mini/pages/ai/ai.json', { usingComponents: { remote: 'plugin://provider/card' } })
  eq(inspectProject(folder).externalComponents, ['plugin://provider/card'])
  write('mini/pages/ai/ai.json', {})
  report = inspectProject(folder)
  const wcc = write('compiler with spaces/wcc.fake', 'test fixture')
  eq(resolveCompiler(wcc, 'wcc', {}), wcc)
  eq(resolveCompiler(undefined, 'wcc', { WECHAT_WCC: wcc }), wcc)
  reject(() => resolveCompiler(undefined, 'wcc', {}), /Missing wcc/)
  reject(() => resolveCompiler(wcc + '.missing', 'wcc', {}), /compiler not found/)
  const calls = []
  compileProject(report, { wcc, wcsc: wcc }, (file, args, options) => {
    calls.push({ file, args, options }); fs.writeFileSync(args[1], 'compiled output'); return { status: 0 }
  })
  eq(calls.length, 2); eq(calls[0].options.shell, false); eq(calls[0].options.cwd, report.mini)
  eq(calls[0].args.includes('pages/ai/part.wxml'), true)
  eq(fs.existsSync(path.dirname(calls[0].args[1])), false)
  reject(() => compileProject(report, { wcc, wcsc: wcc }, () => ({ status: 0 })), /wcc failed/)
  reject(() => compileProject(report, { wcc, wcsc: wcc }, () => ({ status: 1, stderr: 'invalid template' })), /invalid template/)
  reject(() => compileProject(report, { wcc, wcsc: wcc }, () => ({ status: null, error: Error('timeout') })), /timeout/)
  console.log('ui-verifier: ' + checks + ' assertions passed (local fixture files and compiler process contract)')
} finally {
  const relative = path.relative(path.resolve(os.tmpdir()), folder)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(folder).startsWith('ai-forest-check-test-')) throw Error('Unsafe test cleanup path')
  fs.rmSync(folder, { recursive: true, force: true })
}
