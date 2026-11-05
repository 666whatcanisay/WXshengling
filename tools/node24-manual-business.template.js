// Generated copy has a fixed test ID; paste that copy into WeChat DevTools Console.
(async () => {
  const config = /* NODE24_TEST_CONFIG */ null;
  if (!config) throw new Error('请使用生成后的测试脚本');
  const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const call = async (name, data) => (await wx.cloud.callFunction({ name, data })).result;
  const identity = await call('login-node24', {});
  ensure(identity.code === 0 && identity.data.username === 'lzk' && identity.data.role === 'admin', '账号不符，已停止');
  ensure(identity.data.total_xp >= config.beforeXp, '经验低于测试前记录，已停止');
  ensure(today() === config.date, '已跨日期，停止；请让 Codex 核查');
  const api = (action, data) => call('app-node24', { action, data });
  const retry = async (action, data) => {
    let last;
    for (let i = 0; i < 4; i++) {
      ensure(today() === config.date, '已跨日期，停止');
      try {
        const r = await api(action, data);
        if (r.success) return r;
        last = new Error(r.message || JSON.stringify(r));
      } catch (e) { last = e; }
    }
    throw last;
  };
  // Deliberately ignore the first result. Every retry uses the exact same draft.
  // This models a lost response; it does not disconnect the actual network.
  await retry('publishAiPlan', config.request);
  const publications = [];
  for (let i = 0; i < 20; i++) publications.push(await retry('publishAiPlan', config.request));
  ensure(publications.every(r => r.already_published && r.created_count === 3 &&
    r.goal_id === config.goalId && JSON.stringify(r.task_ids) === JSON.stringify(config.taskIds)), '发布回执不一致');
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    api('taskCheckin', { task_id: config.taskIds[i % 2] }).then(r => ({ result: r }), e => ({ error: e.errMsg || e.message }))));
  // Conflicting requests may fail safely with the old SDK; retry the same IDs.
  for (const task_id of config.taskIds.slice(0, 2)) {
    await retry('taskCheckin', { task_id });
    const repeated = await retry('taskCheckin', { task_id });
    ensure(repeated.already_completed === true && repeated.xp_earned === 0, '重复打卡返回异常');
  }
  const future = await api('taskCheckin', { task_id: config.taskIds[2] });
  ensure(future.success !== true && /未来/.test(future.message || ''), '未来任务未按预期拒绝');
  const after = await call('login-node24', {});
  ensure(after.code === 0 && after.data.username === 'lzk', '结束时身份检查失败');
  console.log('NODE24业务检查', JSON.stringify({ publicationRepeats: publications.length,
    sameReceipt: true, concurrentRequests: outcomes.length,
    concurrentSuccess: outcomes.filter(o => o.result?.success).length,
    concurrentFailures: outcomes.filter(o => !o.result?.success).length,
    futureRejected: true, xpDelta: after.data.total_xp - config.beforeXp,
    note: '需Codex核对数据库并清理；本脚本不调用宠物或模型' }));
})().catch(error => console.log('NODE24业务检查失败', error.errMsg || error.message || String(error)));
