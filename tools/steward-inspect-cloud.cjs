// Exact-ID, read-only management inspection for the previously verified test owner.
// Never invokes a function/model, changes data, or prints identity/credentials/input.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function main() {
  const session = require('./lib/node24-cloud-session.cjs')()
  assert.equal(session.journal.envId, 'cloud1-d5gz9j6zh654f4b36')
  assert(session.journal.nativeReadonly && session.journal.nativeReadonly.passed)
  const original = JSON.parse(fs.readFileSync(path.join(session.folder, 'business-test.json')))
  assert.equal(original.envId, session.journal.envId)
  const owner = original.owner; assert.equal(typeof owner, 'string'); assert(owner)
  const c = session.credentials, sdk = require(path.join(session.root, 'cloudfunctions/app/node_modules/@cloudbase/node-sdk'))
  const db = sdk.init({ env: session.journal.envId, secretId: c.secretId, secretKey: c.secretKey,
    sessionToken: c.token, proxy: 'http://127.0.0.1:12001' }).database()
  const read = async id => {
    const response = await db.collection('ai_plans').doc(id).get()
    assert(!response.code && Array.isArray(response.data) && response.data.length <= 1, 'Read failed')
    const row = response.data[0]
    if (row) assert.equal(row._openid, owner, 'Owner mismatch')
    return row || null
  }
  const state = async logicalId => {
    const row = await read('forest_' + hash([owner, logicalId]))
    if (row) { assert.equal(row.kind, 'forest_state'); assert.equal(row.logical_id, logicalId) }
    return row && row.payload
  }
  const head = await state('head'), run = head && await state('run/' + head.run_id)
  const checkpointHead = run && await state('graph/' + run.id + '/head')
  const checkpoint = checkpointHead && await state('graph/' + run.id + '/checkpoint/' + checkpointHead.id)
  const draftHead = await read('planner_head_' + hash(owner))
  if (draftHead) assert.equal(draftHead.kind, 'planner_workspace')
  const currentDraft = draftHead && draftHead.latest_draft_id ? await read(draftHead.latest_draft_id) : null
  if (currentDraft) assert.equal(currentDraft.kind, 'planner_draft_version')
  const reports = []
  if (run && run.state.draft_id) {
    const s = run.state
    for (const mode of ['rules', 'ai']) {
      const row = await read('planner_review_' + hash([owner, s.draft_id, s.revision, s.fingerprint, s.requirements_revision, s.rules_version, mode]))
      if (row) assert.equal(row.kind, 'planner_review')
      reports.push({ mode, status: row ? row.status : '', errorCount: row && row.rules ? row.rules.error_count : null,
        warningCount: row && row.rules ? row.rules.warning_count : null, semanticCount: row && row.semantic ? row.semantic.findings.length : null })
    }
  }
  const report = { envId: session.journal.envId, inspectedAt: new Date().toISOString(), readOnly: true,
    hasRun: !!run, status: run ? run.status : '', mode: run ? run.mode : '', next: run ? run.next : '',
    draftRevision: run ? run.state.revision : null, hasCheckpoint: !!checkpoint,
    hasCurrentDraft: !!currentDraft, currentDraftRevision: currentDraft ? currentDraft.revision : null,
    isCurrent: !!(run && currentDraft && currentDraft._id === run.state.draft_id && currentDraft.revision === run.state.revision &&
      currentDraft.fingerprint === run.state.fingerprint && currentDraft.context.revision === run.state.requirements_revision),
    steps: run ? Object.entries(run.steps).map(([role, step]) => ({ role, status: step.status })) : [],
    error: run ? run.error || '' : '', reports, functionInvocations: false, modelCalls: false, businessWrites: false }
  fs.writeFileSync(path.join(session.root, 'docs/audit/steward-cloud-readonly-20261106.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || '', message: String(error.message || 'Read-only inspection failed') })); process.exitCode = 1 })
