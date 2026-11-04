const { createHash } = require('crypto');
const rules = require('./taskRules');
const MAX_TASKS = 20;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail('计划文字内容不正确');
  return value.trim();
}
function normalize(data) {
  const goal = data.goal || {};
  const days = rules.positiveInteger(goal.target_days);
  if (!days || !rules.validDate(goal.start_date)) fail('目标周期或开始日期不正确');
  let end;
  try { end = rules.addDays(goal.start_date, days - 1); } catch (_) { fail('目标周期超出日期范围'); }
  if (!rules.validDate(end)) fail('目标周期超出日期范围');
  if (!Array.isArray(data.tasks) || data.tasks.length < 1 || data.tasks.length > MAX_TASKS) fail('一次请发布1至20项任务');
  const stages = goal.stages || [];
  if (!Array.isArray(stages) || stages.length > 20) fail('阶段内容不正确');
  const draft = {
    goal: { title: text(goal.title, 200, true), target_days: days, start_date: goal.start_date, end_date: end,
      stages: stages.map(s => ({ name: text(s.name || '', 80), duration: text(s.duration || '', 80), milestone: text(s.milestone || '', 200) })) },
    tasks: data.tasks.map(task => {
      if (!task || !rules.validDate(task.date) || task.date < goal.start_date || task.date > end) fail('任务日期需在目标周期内');
      const minutes = rules.positiveInteger(task.estimated_minutes);
      const xp = rules.positiveInteger(task.xp_reward);
      if (!minutes || minutes > 1440) fail('任务时长需为1至1440分钟');
      if (!xp || xp > 1000) fail('任务经验需为1至1000的整数');
      if (!['string', 'number'].includes(typeof task.stage) || String(task.stage).length > 80 ||
          (typeof task.stage === 'number' && !rules.positiveInteger(task.stage))) fail('任务阶段不正确');
      return { title: text(task.title, 200, true), date: task.date, stage: task.stage, estimated_minutes: minutes, xp_reward: xp };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(draft)) > 65536) fail('计划内容过长，请精简后发布');
  return draft;
}

function createPublisher(cloud) {
  return async function publishAiPlan(openid, data = {}) {
    if (!openid) return { code: -1, message: '未登录' };
    const publicationId = data.publication_id;
    const sourceId = data.source_plan_id || '';
    if (typeof publicationId !== 'string' || !/^[\w:.-]{1,128}$/.test(publicationId)) return { code: -1, message: '发布标识不正确' };
    if (typeof sourceId !== 'string' || (sourceId && !/^[\w:.-]{1,128}$/.test(sourceId))) return { code: -1, message: '来源计划标识不正确' };
    let draft;
    try { draft = normalize(data); } catch (error) { return { code: -1, message: error.message }; }
    const fingerprint = hash(JSON.stringify(draft));
    const recordId = 'pub_' + hash(JSON.stringify([openid, sourceId ? 'source' : 'draft', sourceId || publicationId]));
    const goalId = 'pg_' + hash(recordId);
    const taskIds = draft.tasks.map((_, index) => 'pt_' + hash(recordId + ':' + index));
    const db = cloud.database({ throwOnNotFound: false });
    const receipt = (record, repeated) => ({ success: true, goal_id: record.goal_id, task_ids: record.task_ids,
      created_count: record.task_ids.length, already_published: repeated });
    // Persist the confirmed draft first. A crash here creates no goal or task;
    // the same request can resume without changing what the user confirmed.
    const previous = await db.runTransaction(async tx => {
      const record = (await tx.collection('ai_plans').doc(recordId).get()).data;
      if (record) {
        if (record._openid !== openid || record.kind !== 'plan_publication' || record.fingerprint !== fingerprint) fail('此发布已提交其他内容，请恢复原草稿后重试');
        if (record.status === 'publication_done') return receipt(record, true);
        if (record.status !== 'publication_pending') fail('发布状态异常，请联系管理员');
        return null;
      }
      if (sourceId) {
        const source = (await tx.collection('ai_plans').doc(sourceId).get()).data;
        if (!source || source._openid !== openid || source.kind === 'plan_publication' || source.status !== 'done' || !source.result) fail('来源计划不存在或尚未生成完成');
      }
      await tx.collection('ai_plans').add({ data: { _id: recordId, _openid: openid, kind: 'plan_publication',
        status: 'publication_pending', source_plan_id: sourceId, fingerprint, draft, goal_id: goalId,
        task_ids: taskIds, createdAt: Date.now(), updatedAt: Date.now() } });
      return null;
    });
    if (previous) return previous;
    // A bounded, model-free transaction commits goal + ALL tasks + receipt.
    return db.runTransaction(async tx => {
      const record = (await tx.collection('ai_plans').doc(recordId).get()).data;
      if (!record || record._openid !== openid || record.kind !== 'plan_publication' || record.fingerprint !== fingerprint) fail('发布记录异常');
      if (record.status === 'publication_done') return receipt(record, true);
      if (record.status !== 'publication_pending') fail('发布状态异常');
      const now = Date.now(), confirmed = record.draft;
      await tx.collection('goals').add({ data: { _id: record.goal_id, _openid: openid, ...confirmed.goal,
        description: '', emoji: '🎯', target_value: confirmed.goal.target_days, time_zone: 'Asia/Shanghai',
        progress: 0, current_value: 0, unit: '', status: 'active', publication_id: recordId, created_at: now, updated_at: now } });
      for (let index = 0; index < confirmed.tasks.length; index++) {
        await tx.collection('tasks').add({ data: { _id: record.task_ids[index], _openid: openid, goal_id: record.goal_id,
          ...confirmed.tasks[index], completed: false, publication_id: recordId, created_at: now, updated_at: now } });
      }
      const updated = await tx.collection('ai_plans').doc(recordId).update({ data: { status: 'publication_done', publishedAt: now, updatedAt: now } });
      if (!updated.stats || updated.stats.updated !== 1) fail('发布结果未保存');
      return receipt(record, false);
    });
  };
}
module.exports = { createPublisher, MAX_TASKS };
