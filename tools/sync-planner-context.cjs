// One pure contract source; the Cloud Function deploys a self-contained copy.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'miniprogram/utils/plannerContext.js'))
const target = path.join(root, 'cloudfunctions/app/lib/plannerContext.js')
if (process.argv.includes('--check')) assert(source.equals(fs.readFileSync(target)), 'Planner context deploy copy is out of date')
else fs.writeFileSync(target, source)
