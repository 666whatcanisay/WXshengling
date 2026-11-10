// Local-only file/registration/compiler checks. No SDK, network or upload.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawnSync } = require('node:child_process')
const TARGETS = ['pages/ai/ai', 'pages/forest-steward/forest-steward']
function inside(root, file) {
  const target = path.resolve(file), relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Path leaves project: ' + file)
  return target
}
function inspectProject(root) {
  root = path.resolve(root)
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
  const project = json(path.join(root, 'project.config.json'))
  const mini = inside(root, path.resolve(root, project.miniprogramRoot || 'miniprogram'))
  const app = json(path.join(mini, 'app.json')), registered = [...(app.pages || [])]
  for (const pack of app.subPackages || app.subpackages || []) for (const page of pack.pages || []) registered.push(path.posix.join(pack.root, page))
  const required = file => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error('Missing file: ' + path.relative(root, file)); return file }
  const basePath = name => inside(mini, path.resolve(mini, name))
  for (const name of registered) {
    const base = basePath(name)
    for (const ext of ['.js', '.wxml']) required(base + ext)
    if (fs.existsSync(base + '.json')) json(base + '.json')
  }
  for (const item of app.tabBar && app.tabBar.list || []) if (!registered.includes(item.pagePath)) throw Error('Unregistered tabBar page: ' + item.pagePath)
  for (const target of TARGETS) if (!registered.includes(target)) throw Error('Unregistered AI page: ' + target)
  const templates = new Set(), styles = new Set(), dependencies = new Set(), visited = new Set(), externalComponents = []
  function relativeFile(from, value) {
    if (value.includes('{{')) throw Error('Dynamic file reference requires manual verification: ' + value)
    return inside(mini, value.startsWith('/') ? path.join(mini, value.slice(1)) : path.resolve(path.dirname(from), value))
  }
  function template(file) {
    required(file)
    if (templates.has(file)) return
    templates.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<(?:include|import|wxs)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
      const dep = required(relativeFile(file, match[1])); dependencies.add(dep)
      if (path.extname(dep) === '.wxml') template(dep)
    }
  }
  function style(file) {
    required(file)
    if (styles.has(file)) return
    styles.add(file)
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/@import\s+["']([^"']+)["']/g)) style(relativeFile(file, match[1]))
  }
  function components(config, file) {
    for (const value of Object.values(config.usingComponents || {})) {
      if (/^(plugin|wxcomponents):\/\//.test(value)) { externalComponents.push(value); continue }
      visit(relativeFile(file, value), true)
    }
  }
  function visit(base, component = false) {
    if (visited.has(base)) return
    visited.add(base)
    required(base + '.js'); template(base + '.wxml')
    const configFile = base + '.json'
    if (component) required(configFile)
    const config = fs.existsSync(configFile) ? json(configFile) : {}
    if (component && config.component !== true) throw Error('Component must declare component:true: ' + configFile)
    components(config, configFile)
    if (fs.existsSync(base + '.wxss')) style(base + '.wxss')
  }
  components(app, path.join(mini, 'app.json'))
  for (const target of TARGETS) visit(basePath(target))
  if (app.tabBar && app.tabBar.custom) visit(path.join(mini, 'custom-tab-bar/index'), true)
  if (fs.existsSync(path.join(mini, 'app.wxss'))) style(path.join(mini, 'app.wxss'))
  return { root, mini, registeredPages: registered.length, templates: [...templates], styles: [...styles], dependencies: [...dependencies], externalComponents }
}
function resolveCompiler(explicit, name, env = process.env) {
  const variable = name === 'wcc' ? 'WECHAT_WCC' : 'WECHAT_WCSC'
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const selected = explicit || env[variable]
  if (selected) {
    const file = path.resolve(selected)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(variable + ' compiler not found: ' + file)
    return file
  }
  if (env.WECHAT_DEVTOOLS_DIR) return resolveCompiler(path.join(env.WECHAT_DEVTOOLS_DIR, 'code/package.nw/node_modules/wcc-exec', name + suffix), name, {})
  for (const folder of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(folder, name + suffix)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  throw Error('Missing ' + name + ' compiler; set ' + variable + ', --' + name + ' <path>, or WECHAT_DEVTOOLS_DIR. No compiler was installed.')
}
function compileProject(report, compilers, run = spawnSync) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-forest-ui-'))
  try {
    for (const [kind, files] of [['wcc', report.templates], ['wcsc', report.styles]]) {
      if (!files.length) continue
      const output = path.join(folder, kind + '.out')
      const result = run(compilers[kind], ['-o', output, ...files.map(f => path.relative(report.mini, f).replaceAll('\\', '/'))],
        { cwd: report.mini, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false })
      if (result.error || result.status !== 0 || !fs.existsSync(output) || !fs.statSync(output).size) {
        throw Error(kind + ' failed: ' + String(result.error && result.error.message || result.stderr || result.stdout || 'exit ' + result.status).slice(0, 2000))
      }
    }
  } finally {
    // Delete only the unique scratch directory created above, never the repo.
    inside(path.resolve(os.tmpdir()), folder)
    if (!path.basename(folder).startsWith('ai-forest-ui-')) throw Error('Unexpected compiler scratch path')
    fs.rmSync(folder, { recursive: true, force: true })
  }
}
function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (!['--wcc', '--wcsc'].includes(args[i]) || !args[i + 1]) throw Error('Usage: npm run verify:ui -- [--wcc <path>] [--wcsc <path>]')
    options[args[i].slice(2)] = args[++i]
  }
  const report = inspectProject(path.resolve(__dirname, '..'))
  const compilers = Object.fromEntries(['wcc', 'wcsc'].map(name => [name, resolveCompiler(options[name], name)]))
  compileProject(report, compilers)
  console.log(JSON.stringify({ ok: true, registeredPages: report.registeredPages, compiledTemplates: report.templates.length, compiledStyles: report.styles.length,
    externalComponents: report.externalComponents, compilerCheckOnly: true, nativeUIVerified: false, cloudWrites: false }, null, 2))
}
if (require.main === module) { try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 1 } }
module.exports = { inspectProject, resolveCompiler, compileProject }
