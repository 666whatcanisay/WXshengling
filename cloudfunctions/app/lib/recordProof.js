// Private, server-side read set. JSON normalization preserves SDK Date values.
const { createHash } = require('crypto')
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v
const digest = row => createHash('sha256').update(JSON.stringify(stable(JSON.parse(JSON.stringify(row))))).digest('hex')
const capture = (collection, id, row) => ({ collection, id, digest: digest(row) })
module.exports = { digest, capture }
