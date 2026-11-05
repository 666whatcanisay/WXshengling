// Narrow, reproducible backport from a pinned, already-tested source revision.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const plan = require('../../migration/legacy-app/plan.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Patch anchors not found');
  assert.equal(source.indexOf(start, a + start.length), -1, 'Ambiguous patch anchor');
  return source.slice(a, b);
}
function buildLegacyPatch(baseline, canonical) {
  assert.equal(hash(baseline), plan.baselineIndexSha256, 'Unexpected deployed baseline; stop');
  assert.equal(hash(canonical), plan.canonicalIndexSha256, 'Canonical source changed; stop');
  const old = baseline.toString().replace(/\r\n/g, '\n'), current = canonical.toString().replace(/\r\n/g, '\n');
  const oldAdmin = section(old, 'async function checkAdmin(', '\n// 管理员数据概览');
  const newAdmin = section(current, 'async function checkAdmin(', '\n// 管理员数据概览');
  const oldCheckin = section(old, 'async function taskCheckin(', '\n/**\n * V10.2');
  const newCore = section(current, 'async function taskCheckin(', '  // 派生统计在核心结算后');
  const derived = section(oldCheckin, '  // 【V10.2】打卡后', '  // 【V8.5修复】任务打卡经验也进入成长池');
  assert(newCore.includes('task.date > todayStr()'));
  const patchedCore = newCore.replace('task.date > todayStr()',
    "task.date > new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)");
  const newCheckin = patchedCore +
    '  // 兼容已发布旧版：仅核心结算复用新版事务，原目标天数派生逻辑保持不变。\n' +
    '  const task = { goal_id: settlement.goal_id };\n' + derived +
    '  return { success: true, xp_earned: settlement.xp_earned };\n}\n';
  let patched = old.replace(oldAdmin, newAdmin).replace(oldCheckin, newCheckin);
  // Prove every byte outside the two declared function bodies is preserved.
  const erase = (s, admin, checkin) => s.replace(admin, '<ADMIN>').replace(checkin, '<CHECKIN>');
  assert.equal(erase(patched, newAdmin, newCheckin), erase(old, oldAdmin, oldCheckin));
  new vm.Script(patched, { filename: 'legacy-app/index.js' });
  if (baseline.includes(Buffer.from('\r\n'))) patched = patched.replace(/\n/g, '\r\n');
  return { code: Buffer.from(patched), baselineHash: hash(baseline), patchedHash: hash(Buffer.from(patched)),
    preservedOutsideFunctions: true, changedFunctions: ['checkAdmin', 'taskCheckin'] };
}
module.exports = { buildLegacyPatch, hash, plan };
