import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { BaseCheckpointSaver, WRITES_IDX_MAP, writesSortKey, compareWritesSortKeys,
  type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions, type PendingWrite } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

type Encoded = { type: string; data: string };
export type Write = { task: string; channel: string; index: number; path: string; value: Encoded };
export type Saved = { checkpoint: Encoded; metadata: Encoded; parent: string };
export interface Persistence {
  read(id?: string): Promise<{ id: string; saved: Saved; writes: Write[] } | null>;
  put(id: string, saved: Saved): Promise<void>;
  writes(id: string, entries: Write[]): Promise<void>;
}

// Bounded, single-namespace graph. Native SDK persistence is injected by the service.
// No RAM-only saver, database queries/indexes or third-party SDK client in the bundle.
export class ForestSaver extends BaseCheckpointSaver {
  constructor(private port: Persistence, private thread: string) { super(); }
  private validate(config: RunnableConfig) {
    if (config.configurable?.thread_id !== this.thread || (config.configurable?.checkpoint_ns ?? '') !== '') throw Error('检查点归属或命名空间不正确');
  }
  private config(id: string): RunnableConfig { return { configurable: { thread_id: this.thread, checkpoint_ns: '', checkpoint_id: id } }; }
  private async encode(value: unknown): Promise<Encoded> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return { type, data: Buffer.from(bytes).toString('base64') };
  }
  private decode(value: Encoded): Promise<unknown> { return this.serde.loadsTyped(value.type, Buffer.from(value.data, 'base64')); }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.validate(config);
    const row = await this.port.read(config.configurable?.checkpoint_id);
    if (!row) return undefined;
    const checkpoint = await this.decode(row.saved.checkpoint) as Checkpoint;
    if (checkpoint.id !== row.id) throw Error('检查点内容不一致');
    const entries = [...row.writes].sort((a, b) => compareWritesSortKeys(writesSortKey(a.path, a.task, a.index), writesSortKey(b.path, b.task, b.index)));
    return { config: this.config(row.id), checkpoint, metadata: await this.decode(row.saved.metadata) as CheckpointMetadata,
      pendingWrites: await Promise.all(entries.map(async e => [e.task, e.channel, await this.decode(e.value)] as [string, string, unknown])),
      ...(row.saved.parent ? { parentConfig: this.config(row.saved.parent) } : {}) };
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    this.validate(config);
    await this.port.put(checkpoint.id, { checkpoint: await this.encode(checkpoint), metadata: await this.encode(metadata), parent: config.configurable?.checkpoint_id || '' });
    return this.config(checkpoint.id);
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = ''): Promise<void> {
    this.validate(config);
    const id = config.configurable?.checkpoint_id;
    if (!id) throw Error('写入缺少检查点');
    await this.port.writes(id, await Promise.all(writes.map(async ([channel, value], i) => ({ task: taskId, channel,
      index: WRITES_IDX_MAP[channel] ?? i, path: taskPath, value: await this.encode(value) }))));
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    this.validate(config);
    if (options.filter) throw Error('首版不支持检查点元数据筛选');
    let tuple = await this.getTuple(options.before || config), count = 0;
    if (options.before && tuple?.parentConfig) tuple = await this.getTuple(tuple.parentConfig);
    else if (options.before) return;
    while (tuple && count++ < Math.min(options.limit ?? 100, 100)) {
      yield tuple;
      tuple = tuple.parentConfig ? await this.getTuple(tuple.parentConfig) : undefined;
    }
  }
  async deleteThread(): Promise<void> { throw Error('协作记录不在用户运行接口中删除，请使用取消'); }
}

export const State = Annotation.Root({
  mode: Annotation<string>(), demand: Annotation<string>(), base_revision: Annotation<number>(),
  route: Annotation<string>(), draft_id: Annotation<string>(), revision: Annotation<number>(), fingerprint: Annotation<string>(),
  requirements_revision: Annotation<number>(), rules_version: Annotation<string>(), note: Annotation<string>(), rule_errors: Annotation<number>()
});
export type ForestState = typeof State.State;
export type Update = Partial<ForestState>;
export interface Roles {
  node(name: string, state: ForestState, work: () => Promise<Update>): Promise<Update>;
  manage(state: ForestState): Promise<Update>;
  plan(state: ForestState): Promise<Update>;
  review(state: ForestState, mode: 'rules' | 'ai'): Promise<Update>;
}
export function createGraph(port: Persistence, thread: string, roles: Roles) {
  return new StateGraph(State)
    .addNode('manager', s => roles.node('manager', s, () => roles.manage(s)))
    .addNode('planner', s => roles.node('planner', s, () => roles.plan(s)))
    .addNode('rules', s => roles.node('rules', s, () => roles.review(s, 'rules')))
    .addNode('review', s => roles.node('review', s, () => roles.review(s, 'ai')))
    .addNode('wait_user', s => { interrupt({ kind: 'confirm_draft', draft_id: s.draft_id, revision: s.revision }); return {}; })
    .addEdge(START, 'manager')
    .addConditionalEdges('manager', s => s.route === 'planner' ? 'planner' : 'rules', ['planner', 'rules'])
    .addEdge('planner', 'rules').addConditionalEdges('rules', s => s.rule_errors > 0 ? 'wait_user' : 'review', ['wait_user', 'review'])
    .addEdge('review', 'wait_user').addEdge('wait_user', END)
    .compile({ checkpointer: new ForestSaver(port, thread), interruptAfter: ['manager', 'planner', 'rules'] });
}

// Separate graph contract/threads: existing planning checkpoints retain their meaning.
const AdjustmentState = Annotation.Root({ mode: Annotation<string>(), revision: Annotation<number>(), rule_errors: Annotation<number>(), has_changes: Annotation<boolean>() });
type AdjustmentValue = typeof AdjustmentState.State;
type AdjustmentUpdate = Partial<AdjustmentValue>;
export interface AdjustmentRoles {
  node(name: string, work: () => Promise<AdjustmentUpdate>): Promise<AdjustmentUpdate>;
  plan(): Promise<AdjustmentUpdate>;
  review(mode: 'rules' | 'ai'): Promise<AdjustmentUpdate>;
}
export function createAdjustmentGraph(port: Persistence, thread: string, roles: AdjustmentRoles) {
  return new StateGraph(AdjustmentState)
    .addNode('manager', () => roles.node('manager', async () => ({})))
    .addNode('planner', () => roles.node('planner', () => roles.plan()))
    .addNode('rules', () => roles.node('rules', () => roles.review('rules')))
    .addNode('review', () => roles.node('review', () => roles.review('ai')))
    .addNode('wait_user', s => { interrupt({ kind: 'preview_adjustment_only', revision: s.revision }); return {}; })
    .addEdge(START, 'manager')
    .addConditionalEdges('manager', s => s.mode === 'edited' ? 'rules' : 'planner', ['planner', 'rules'])
    .addEdge('planner', 'rules')
    .addConditionalEdges('rules', s => s.rule_errors > 0 || !s.has_changes ? 'wait_user' : 'review', ['wait_user', 'review'])
    .addEdge('review', 'wait_user').addEdge('wait_user', END)
    .compile({ checkpointer: new ForestSaver(port, thread), interruptAfter: ['manager', 'planner', 'rules'] });
}
