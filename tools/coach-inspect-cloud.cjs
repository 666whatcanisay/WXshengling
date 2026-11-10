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
  const service = require('../cloudfunctions/app/lib/coachService').createService({ cloud: { database: () => readonly } })
  const goals = await service.listGoals(owner)
  const latest = await db.collection('ai_plans').where({ _openid: owner, kind: 'coach_report' }).orderBy('updated_at', 'desc').limit(1).get()
  assert(!latest.code && Array.isArray(latest.data), 'Report lookup failed')
  const report = latest.data[0] || null
  const goalId = report ? report.goal_id : goals.goals[0] && goals.goals[0]._id
  const date = report ? report.date : require('../cloudfunctions/app/lib/taskRules').businessDate()
  const workspace = goalId ? await service.get(owner, { goal_id: goalId, date }) : null
  if (goalId) {
    const probe = await db.collection('tasks').where({ _openid: owner, goal_id: goalId, date, _id: db.command.gt('') }).orderBy('_id', 'asc').limit(1).get()
    assert(!probe.code && Array.isArray(probe.data), 'Cursor query failed')
  }
  const summary = { inspectedAt: new Date().toISOString(), readOnly: true, goalsRead: goals.goals.length, goalsComplete: goals.complete, hasGoal: !!workspace,
    period: workspace ? [workspace.facts.start, workspace.facts.end] : null, complete: workspace ? workspace.facts.complete : null,
    pastTasks: workspace ? workspace.facts.past.total : null, completed: workspace ? workspace.facts.past.completed : null,
    todayPending: workspace && workspace.facts.today ? workspace.facts.today.pending : null, feedbackRevision: workspace ? workspace.feedback.revision : null,
    reportStatus: workspace && workspace.report ? workspace.report.status : '',
    latestStoredReportStatus: report ? report.status : '', latestReportIsCurrent: !!(report && workspace && report.fingerprint === workspace.fingerprint),
    latestReportAttempt: report ? report.attempt : null,
    latestReportFailureKind: report && report.status === 'failed' ? /模型.*(?:引用|格式|JSON|有效复盘)/.test(report.error || '') ? 'content_validation' : 'other' : '',
    feedbackHasNote: !!(workspace && workspace.feedback.values.note),
    latestReportFeedbackRevision: report && report.snapshot && report.snapshot.feedbacks ? (report.snapshot.feedbacks.find(f => f.date === report.date) || {}).revision : null,
    observations: workspace && workspace.report && workspace.report.result ? workspace.report.result.observations.length : null,
    suggestions: workspace && workspace.report && workspace.report.result ? workspace.report.result.suggestions.length : null,
    functionInvocations: false, modelCalls: false, businessWrites: false }
  fs.writeFileSync(path.join(s.root, 'docs/audit/coach-cloud-readonly-20261106.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message || 'Read-only inspection failed') })); process.exitCode = 1 })
