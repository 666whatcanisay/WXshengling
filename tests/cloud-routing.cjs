// Actual client adapter -> actual function handlers -> installed SDK/offline DB.
// Also checks lost-response retries and manual legacy-name routing without mixing.
// The legacy-name case tests client selection only, not old deployed API compatibility.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { offlineCloudbase } = require('./helpers/offline-cloudbase.cjs');
const root = path.resolve(__dirname, '..');
const config = require('../miniprogram/utils/cloudConfig');
const quiet = { log() {}, warn() {}, error() {} };
let assertions = 0;
const plain = value => JSON.parse(JSON.stringify(value));
const eq = (a, b) => { assert.deepEqual(plain(a), plain(b)); assertions++; };
async function run(selected, rollback = false) {
  const env = offlineCloudbase({ users: [{ _id: 'user', _openid: 'owner', username: 'lzk', role: 'admin', total_xp: 0 }],
    goals: [], tasks: [], ai_plans: [], growth_logs: [], user_growth_pool: [] });
  function handler(relative) {
    const file = path.join(root, relative), localRequire = createRequire(file);
    const context = vm.createContext({ exports: {}, console: quiet, Buffer, setTimeout, clearTimeout,
      require: name => name === 'wx-server-sdk' ? env.cloud : name === 'https'
        ? { request() { throw new Error('Network disabled'); } } : localRequire(name) });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context); return context.exports.main;
  }
  const app = handler('cloudfunctions/app/index.js'), login = handler('cloudfunctions/login/index.js');
  const calls = [], initializations = [], redirects = [];
  let application;
  let networkFailures = 0, missing = false, losePublicationResponse = false, unsupportedAction = '';
  const wx = { getStorageSync() {}, removeStorageSync() {}, showToast() {},
    reLaunch({ url }) { redirects.push(url); },
    getNetworkType({ success }) { success({ networkType: 'wifi' }); },
    cloud: { init(value) { initializations.push(value); }, callFunction(options) {
      calls.push({ name: options.name, env: options.config?.env, data: plain(options.data) });
      if (missing) { options.fail({ errMsg: 'FUNCTION_NOT_FOUND' }); return; }
      if (networkFailures) { networkFailures--; options.fail({ errMsg: 'network timeout' }); return; }
      if (unsupportedAction && options.data.action === unsupportedAction) {
        options.success({ result: { code: -1, message: '未知操作: ' + unsupportedAction } }); return;
      }
      const route = options.name === selected.functions.login ? login : options.name === selected.functions.app ? app : null;
      assert(route, 'Unexpected physical function');
      Promise.resolve(route(options.data)).then(result => {
        if (losePublicationResponse && options.data.action === 'publishAiPlan') {
          losePublicationResponse = false; options.fail({ errMsg: 'network timeout' });
        } else options.success({ result });
      }).catch(error => options.fail({ errMsg: error.message || String(error) }));
    } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils/cloudApi.js'), 'utf8'), {
    module, require: name => { assert.equal(name, './cloudConfig'); return selected; }, wx,
    console: quiet, getApp: () => application, setTimeout(fn) { fn(); } });
  const api = module.exports;
  try {
    const user = await api.login(); eq(user.username, 'lzk');
    eq(calls[0].name, selected.functions.login); eq(calls[0].env, config.env);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const manual = await api.createGoal({ title: '手动目标', target_days: 7 });
    eq(manual.success, true); eq((await api.goals()).length, 1);
    if (rollback) { eq(calls.every(c => ['app', 'login'].includes(c.name)), true); return; }
    const input = { publication_id: 'client-routing', goal: { title: '客户端发布', target_days: 2, start_date: today },
      tasks: [{ title: '今日任务', date: today, stage: 1, estimated_minutes: 1, xp_reward: 10 }] };
    losePublicationResponse = true;
    const receipt = await api.publishAiPlan(input);
    eq(receipt.already_published, true); eq(receipt.created_count, 1);
    eq(env.rows.goals.length, 2); eq(env.rows.tasks.length, 2);
    const publishedCalls = calls.filter(c => c.data.action === 'publishAiPlan');
    eq(publishedCalls.length, 2); eq(publishedCalls[0], publishedCalls[1]);
    eq((await api.taskCheckin({ task_id: receipt.task_ids[0] })).xp_earned, 10);
    const duplicate = await api.taskCheckin({ task_id: receipt.task_ids[0] });
    eq(duplicate.already_completed, true); eq(duplicate.xp_earned, 0);
    eq(env.rows.users[0].total_xp, 10); eq((await api.growthLogs()).length, 1);
    eq((await api.tasks({ date: today })).length, 2);
    const manualTask = { request_id: 'manual-recovery', title: '附加任务', date: today, goal_id: manual.id };
    unsupportedAction = 'createTaskOnce';
    const beforeOldRoute = calls.length;
    await assert.rejects(api.createTask(manualTask), /未知操作: createTaskOnce/); assertions++;
    eq(calls.slice(beforeOldRoute).map(c => c.data.action), ['createTaskOnce']);
    eq(env.rows.tasks.length, 2);
    unsupportedAction = '';
    const taskReceipt = await api.createTask(manualTask);
    eq(taskReceipt.success, true);
    eq((await api.createTask(manualTask)).id, taskReceipt.id);
    eq((await api.createTask({ ...manualTask, title: '不应写入' })).rejected, true);
    eq(env.rows.tasks.length, 3);
    const goalDraft = { request_id: 'goal-recovery', title: '可恢复目标', start_date: today, target_days: 7 };
    unsupportedAction = 'createGoalOnce';
    const beforeOldGoalRoute = calls.length;
    await assert.rejects(api.createGoalOnce(goalDraft), /未知操作: createGoalOnce/); assertions++;
    eq(calls.slice(beforeOldGoalRoute).map(c => c.data.action), ['createGoalOnce']);
    eq(env.rows.goals.length, 2);
    unsupportedAction = '';
    const goalReceipt = await api.createGoalOnce(goalDraft);
    eq(goalReceipt.success, true);
    eq((await api.createGoalOnce(goalDraft)).id, goalReceipt.id);
    eq(env.rows.tasks.filter(task => task.goal_id === goalReceipt.id).length, 1);
    for (const action of ['allocatePoolOnce', 'useBackpackItemOnce']) {
      unsupportedAction = action;
      const beforeRewardRoute = calls.length;
      await assert.rejects(api[action]({ request_id: 'protected-reward' }), /未知操作/); assertions++;
      eq(calls.slice(beforeRewardRoute).map(c => c.data.action), [action]);
    }
    unsupportedAction = '';
    vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8'), {
      App(value) { application = value; }, wx, console: quiet, Date,
      require: name => name.endsWith('/cloudApi') ? api : name.endsWith('/userSession')
        ? require('../miniprogram/utils/userSession') : selected });
    application.onLaunch(); eq(initializations[0].env, config.env);
    const info = await application.checkCloudConnection();
    eq(info.functions, config.functions); eq(info.cachedOffline, false);
    eq(info.tasksReadable, true); eq(info.loginVerified, true); eq('openid' in info, false);
    networkFailures = 2;
    const before = calls.length; await api.tasks({ date: today });
    eq(calls.length - before, 3); eq(calls.slice(before).every(c => c.name === 'app-node24'), true);
    missing = true; const beforeMissing = calls.length;
    await assert.rejects(api.tasks({ date: today }), error => /尚未部署/.test(String(error))); assertions++;
    eq(calls.length - beforeMissing, 1); missing = false;
    env.mutate('users', 'user', { role: 'user' });
    await assert.rejects(api.adminDashboard(), error => /权限|管理员/.test(String(error))); assertions++;
    env.mutate('users', 'user', { status: 'banned' });
    application.globalData.currentOpenid = 'owner';
    const olderRequest = api.tasks({ date: today });
    application.globalData.currentOpenid = 'other';
    await assert.rejects(olderRequest, /已封禁/);
    eq(application.globalData.currentOpenid, 'other');
    eq(redirects.length, 0);
    application.globalData.currentOpenid = 'owner';
    await assert.rejects(api.tasks({ date: today }), /已封禁/);
    eq(application.globalData.currentOpenid, '');
    eq(redirects, ['/pages/login/login?reason=account-banned']);
    env.mutate('users', 'user', { status: 'active', requires_session_id: true });
    application.globalData.currentOpenid = 'owner';
    application.globalData.userInfo = { id: 'deleted-user' };
    const staleAccount = api.tasks({ date: today });
    application.globalData.userInfo = { id: 'user' };
    await assert.rejects(staleAccount, /会话已失效/); assertions++;
    eq(redirects.length, 1);
    eq(application.globalData.userInfo.id, 'user');
    await api.tasks({ date: today });
    eq(calls.at(-1).data.accountId, 'user');
    eq(calls.every(c => ['app-node24', 'login-node24'].includes(c.name)), true);
  } finally { env.close(); }
}
(async () => {
  await run(config);
  await run({ ...config, functions: { app: 'app', login: 'login' } }, true);
  console.log(JSON.stringify({ passed: assertions, cloudWrites: false,
    scope: 'Client adapter + function handlers + installed SDK with offline wire transport; no WeChat UI verification' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
