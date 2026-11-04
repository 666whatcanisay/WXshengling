import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Annotation, StateGraph, START, END, MemorySaver, Command, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { CloudBaseSaver } from '@cloudbase/agent-adapter-langgraph';
import { FileDb } from './file-db.js';

// Deterministic roles test orchestration only; they are NOT real model agents.
const State = Annotation.Root({
  goal: Annotation<string>(),
  minutes: Annotation<number>(),
  revision: Annotation<number>({ reducer: (_, value) => value, default: () => 0 }),
  valid: Annotation<boolean>(),
  approved: Annotation<boolean>(),
  applied: Annotation<boolean>(),
  trace: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] })
});

function build(checkpointer: BaseCheckpointSaver) {
  const metrics = { plannerCalls: 0, confirmEntries: 0, applyCalls: 0 };
  const graph = new StateGraph(State)
    .addNode('plan', (state) => {
      metrics.plannerCalls++;
      if (state.goal === 'transient' && metrics.plannerCalls === 1) throw new Error('mock transient failure');
      if (state.goal === 'unavailable') throw new Error('mock permanent failure');
      return { minutes: 120, trace: ['plan'] };
    }, { retryPolicy: { maxAttempts: 2, initialInterval: 1, backoffFactor: 1, jitter: false, retryOn: () => true } })
    .addNode('critic', (state) => ({ valid: state.minutes <= 30 && state.goal !== 'impossible', trace: ['critic'] }))
    .addNode('revise', () => ({ minutes: 25, revision: 1, trace: ['revise'] }))
    .addNode('confirm', (state) => {
      metrics.confirmEntries++;
      const decision = interrupt<{ kind: string; goal: string; minutes: number }, { approved: boolean }>({ kind: 'confirm_plan', goal: state.goal, minutes: state.minutes });
      return { approved: decision.approved === true, trace: ['confirm'] };
    })
    .addNode('applyDryRun', () => {
      metrics.applyCalls++;
      return { applied: true, trace: ['apply-dry-run'] };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'critic')
    .addConditionalEdges('critic', (state) => state.valid ? 'confirm' : state.revision < 1 ? 'revise' : END, ['confirm', 'revise', END])
    .addEdge('revise', 'critic')
    .addConditionalEdges('confirm', (state) => state.approved ? 'applyDryRun' : END, ['applyDryRun', END])
    .addEdge('applyDryRun', END)
    .compile({ checkpointer });
  return { graph, metrics };
}

const config = (thread: string) => ({ configurable: { thread_id: thread }, recursionLimit: 15 });
const interruptsOf = (value: unknown) => (value as { __interrupt__?: unknown[] }).__interrupt__;
const checks: string[] = [];
function check(name: string, callback: () => void) { callback(); checks.push(name); }
const directory = fileURLToPath(new URL('../probe-data/', import.meta.url));
mkdirSync(directory, { recursive: true });

function persistentSaver(path: string, userId: string) {
  return new CloudBaseSaver({ db: new FileDb(path) as any, userId, agentId: 'compat-probe' });
}

// A separate Node process loads the installed Tencent saver and the file-backed fake DB.
if (process.argv[2] === '--resume-child') {
  const saver = persistentSaver(process.argv[3], 'test-user-A');
  const { graph, metrics } = build(saver);
  const state = await graph.invoke(new Command({ resume: { approved: true } }), config('persistent'));
  console.log(JSON.stringify({ state, metrics }));
} else {
  const memory = new MemorySaver();
  const { graph, metrics } = build(memory);
  const initial = await graph.invoke({ goal: 'learn' }, config('A'));
  check('bounded critic revision', () => {
    assert.equal(initial.revision, 1);
    assert.equal(initial.minutes, 25);
    assert.deepEqual(initial.trace, ['plan', 'critic', 'revise', 'critic']);
  });
  check('approval interrupts without applying', () => {
    assert.equal(interruptsOf(initial)?.length, 1);
    assert.equal(metrics.applyCalls, 0);
  });
  const completed = await graph.invoke(new Command({ resume: { approved: true } }), config('A'));
  check('confirmation resumes and applies dry run', () => { assert.equal(completed.applied, true); assert.equal(metrics.applyCalls, 1); });
  check('interrupt node restarts on resume', () => assert.equal(metrics.confirmEntries, 2));
  await graph.invoke(null, config('A'));
  check('completed invocation does not repeat apply', () => assert.equal(metrics.applyCalls, 1));
  await graph.invoke({ goal: 'other' }, config('B'));
  const declined = await graph.invoke(new Command({ resume: { approved: false } }), config('B'));
  check('declined confirmation does not apply', () => { assert.notEqual(declined.applied, true); assert.equal(metrics.applyCalls, 1); });
  const stateA = await graph.getState(config('A'));
  const stateB = await graph.getState(config('B'));
  check('threads hold distinct states', () => { assert.equal(stateA.values.goal, 'learn'); assert.equal(stateB.values.goal, 'other'); });
  const retry = build(new MemorySaver());
  await retry.graph.invoke({ goal: 'transient' }, config('retry'));
  check('transient planner failure retries within bound', () => assert.equal(retry.metrics.plannerCalls, 2));
  const failure = build(new MemorySaver());
  await assert.rejects(() => failure.graph.invoke({ goal: 'unavailable' }, config('failure')), /mock permanent failure/);
  check('permanent failure surfaces and does not apply', () => { assert.equal(failure.metrics.plannerCalls, 2); assert.equal(failure.metrics.applyCalls, 0); });
  const invalid = await graph.invoke({ goal: 'impossible' }, config('invalid'));
  check('invalid plan stops after one revision', () => { assert.equal(invalid.revision, 1); assert.equal(invalid.valid, false); assert.equal(interruptsOf(invalid), undefined); });

  const path = `${directory}database-${Date.now()}.json`;
  const saver = persistentSaver(path, 'test-user-A');
  await saver.setup();
  await saver.setup();
  const persisted = build(saver);
  await persisted.graph.invoke({ goal: 'persisted' }, config('persistent'));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--resume-child', path], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  check('Tencent saver restores after process restart using fake DB', () => {
    assert.equal(recovered.state.applied, true);
    assert.equal(recovered.state.goal, 'persisted');
    assert.equal(recovered.metrics.plannerCalls, 0);
    assert.equal(recovered.metrics.applyCalls, 1);
  });
  const otherUser = persistentSaver(path, 'test-user-B');
  const inaccessible = await otherUser.getTuple(config('persistent'));
  check('other user cannot read known thread', () => assert.equal(inaccessible, undefined));
  const reopened = persistentSaver(path, 'test-user-A');
  let history = 0;
  for await (const _ of reopened.list(config('persistent'), { limit: 3 })) history++;
  check('Tencent saver lists checkpoint history', () => assert.equal(history, 3));
  await reopened.deleteThread('persistent');
  const deleted = await reopened.getTuple(config('persistent'));
  check('Tencent saver removes thread', () => assert.equal(deleted, undefined));

  const cjs = spawnSync(process.execPath, ['-e', 'require("@langchain/langgraph"); require("@cloudbase/agent-adapter-langgraph"); console.log("ok")'], { encoding: 'utf8', timeout: 30000 });
  check('CommonJS package entry imports on local Node', () => assert.equal(cjs.status, 0, cjs.stderr));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const packageNames = ['@langchain/langgraph', '@langchain/core', '@cloudbase/agent-adapter-langgraph'];
  const packages = Object.fromEntries(packageNames.map((name) => {
    const pkg = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    return [name, { version: pkg.version, engines: pkg.engines ?? null }];
  }));
  const result = {
    date: '2026-11-04', runtime: process.version, platform: process.platform,
    scope: 'isolated deterministic graph + official Tencent saver with local fake DB; no cloud writes, UI, real model, auth or live database validation',
    packages,
    resolvedLockEntries: Object.keys(lock.packages).length - 1,
    presentPackageEntries: Object.keys(lock.packages).filter((key) => key && existsSync(new URL(`../${key}/package.json`, import.meta.url))).length,
    passedChecks: checks.length, checks,
    limitations: ['FileDb is a test double; it does not validate Tencent database limits, indexes or transactions.', 'Roles are deterministic stubs; model quality, latency, tokens and supervisor intelligence remain untested.', 'Replay and concurrent publish/reward require application idempotency; this probe does not implement it.', 'Cloud Node16 is unsupported by tested package engines; production Node22 availability, costs and streaming remain to verify.', 'npm emitted a transitive mem0ai/Anthropic peer version warning; install scripts were disabled.']
  };
  writeFileSync(new URL('../../../docs/audit/langgraph-compat-20261104.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

