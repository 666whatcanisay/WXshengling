// Read-only management adapter. No model/function invocation or database writes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
async function main() {
  const s = require('./lib/node24-cloud-session.cjs')()
  assert.equal(s.journal.envId, 'cloud1-d5gz9j6zh654f4b36'); assert(s.journal.nativeReadonly.passed)
  const original = JSON.parse(fs.readFileSync(path.join(s.folder, 'business-test.json'))), owner = original.owner
  assert.equal(original.envId, s.journal.envId); assert(owner)
  const c = s.credentials, sdk = require(path.join(s.root, 'cloudfunctions/app/node_modules/@cloudbase/node-sdk'))
  const db = sdk.init({ env: s.journal.envId, secretId: c.secretId, secretKey: c.secretKey, sessionToken: c.token, proxy: 'http://127.0.0.1:12001' }).database()
  const readonly = { command: db.command, collection: name => ({
    where: filter => db.collection(name).where(filter),
    doc: id => ({ get: async () => {
      const r = await db.collection(name).doc(id).get()
      assert(!r.code && Array.isArray(r.data) && r.data.length <= 1, 'Read failed')
      return { data: r.data[0] || null }
    } })
  }) }
  const coach = require('../cloudfunctions/app/lib/coachService').createService({ cloud: { database: () => readonly } })
  const service = require('../cloudfunctions/app/lib/adjustmentService').createService({ cloud: { database: () => readonly }, coach })
  const goals = await coach.listGoals(owner)
  const latest = await db.collection('ai_plans').where({ _openid: owner, kind: 'coach_report' }).orderBy('updated_at', 'desc').limit(1).get()
  assert(!latest.code && Array.isArray(latest.data), 'Report lookup failed')
  const report = latest.data[0] || null
  const at = process.argv.indexOf('--goal-id'), selectedGoal = at >= 0 ? process.argv[at + 1] : ''
  if (at >= 0) assert(typeof selectedGoal === 'string' && /^[\w:.-]{1,128}$/.test(selectedGoal), 'Invalid goal selector')
  const goalId = selectedGoal || (report ? report.goal_id : goals.goals[0] && goals.goals[0]._id)
  const date = selectedGoal ? require('../cloudfunctions/app/lib/taskRules').businessDate() : report ? report.date : require('../cloudfunctions/app/lib/taskRules').businessDate()
  const workspace = goalId ? await service.get(owner, { goal_id: goalId, date }) : null
  if (goalId) {
    const probe = await db.collection('tasks').where({ _openid: owner, goal_id: goalId, date, _id: db.command.gt('') }).orderBy('_id', 'asc').limit(1).get()
    assert(!probe.code && Array.isArray(probe.data), 'Cursor query failed')
  }
  const summary = { inspectedAt: new Date().toISOString(), readOnly: true, goalsRead: goals.goals.length,
    hasGoal: !!workspace, adjustmentPeriod: workspace ? [workspace.snapshot.start, workspace.snapshot.end] : null,
    complete: workspace ? workspace.snapshot.complete : null, futureTasks: workspace ? workspace.snapshot.tasks.length : null,
    eligible: workspace ? workspace.snapshot.eligible : null, blockedReason: workspace ? workspace.snapshot.blocked_reason : '',
    sourceHasCurrentCoachReport: !!(workspace && workspace.snapshot.report), hasRun: !!(workspace && workspace.run),
    status: workspace && workspace.run ? workspace.run.status : '', isCurrent: workspace && workspace.run ? workspace.run.is_current : null,
    revision: workspace && workspace.run ? workspace.run.revision : null,
    changedTasks: workspace && workspace.run && workspace.run.changes ? workspace.run.changes.length : null,
    ruleErrors: workspace && workspace.run && workspace.run.rules ? workspace.run.rules.error_count : null,
    aiDone: !!(workspace && workspace.run && workspace.run.review),
    dailyBudget: workspace && workspace.run ? workspace.run.requirements.daily_minutes : null,
    changeMinutes: workspace && workspace.run ? workspace.run.diff.map(d => ({ before: d.before.estimated_minutes, after: d.after.estimated_minutes })) : [],
    reviewModel: workspace && workspace.run && workspace.run.review ? workspace.run.review.model : null,
    steps: workspace && workspace.run ? Object.entries(workspace.run.steps).map(([name, value]) => ({ name, status: value.status })) : [],
    functionInvocations: false, modelCalls: false, businessWrites: false }
  fs.writeFileSync(path.join(s.root, 'docs/audit', selectedGoal ? 'adjustment-goal-' + goalId + '-20261106.json' : 'adjustment-cloud-readonly-20261106.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message || 'Read-only inspection failed') })); process.exitCode = 1 })
