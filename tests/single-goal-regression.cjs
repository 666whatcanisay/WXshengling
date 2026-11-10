// Exercises production handlers and page methods with isolated, paginated database rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const rules = require('../cloudfunctions/app/lib/taskRules');
const schedule = require('../miniprogram/utils/planSchedule');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let rows = {}, nextId = 0, clock = Date.parse('2026-11-04T08:00:00Z');
let checks = 0;
const equal = (actual, expected) => { assert.deepEqual(clone(actual), clone(expected)); checks++; };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class AuditDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => value && value.kind === 'neq' ? row[key] !== value.value : row[key] === value);
}
function docOps(name, id) {
  return {
    collection(coll) { return docOps(coll, id); },
    async get() {
      const row = clone((rows[name] || []).find(r => r._id === id));
      return { data: row || null };
    },
    async update({ data }) {
      const row = (rows[name] || []).find(r => r._id === id);
      if (!row) return { stats: { updated: 0 }, updated: 0 };
      for (const [key, value] of Object.entries(data)) {
        row[key] = value && value.kind === 'inc' ? (row[key] || 0) + value.value : clone(value);
      }
      return { stats: { updated: 1 }, updated: 1 };
    },
    async add({ data }, optId) {
      const id = optId || 'row-' + (++nextId);
      (rows[name] ||= []).push({ _id: id, ...clone(data) });
      return { _id: id };
    },
    async remove() {
      const before = (rows[name] || []).length;
      rows[name] = (rows[name] || []).filter(r => r._id !== id);
      return { stats: { removed: before - rows[name].length }, removed: before - rows[name].length };
    },
  };
}
function query(name, filter = {}, offset = 0, limit = Infinity) {
  return {
    where: next => query(name, next, offset, limit),
    doc: id => docOps(name, id),
    skip: value => query(name, filter, value, limit),
    limit: value => query(name, filter, offset, value),
    field: () => query(name, filter, offset, limit),
    async get() { return { data: clone((rows[name] || []).filter(row => matches(row, filter)).slice(offset, offset + limit)) }; },
    async add({ data }, optId) {
      const id = optId || 'row-' + (++nextId);
      (rows[name] ||= []).push({ _id: id, ...clone(data) });
      return { _id: id };
    },
    async update({ data }) {
      let updated = 0;
      for (const row of rows[name] || []) {
        if (!matches(row, filter)) continue;
        for (const [key, value] of Object.entries(data)) row[key] = value && value.kind === 'inc' ? (row[key] || 0) + value.value : clone(value);
        updated++;
      }
      return { stats: { updated }, updated };
    },
  };
}
const db = {
  collection: name => query(name),
  command: { inc: value => ({ kind: 'inc', value }), neq: value => ({ kind: 'neq', value }), eq: value => ({ kind: 'eq', value }), in: value => ({ kind: 'in', value }) },
  async runTransaction(callback) {
    // 简化的事务替身：直接执行 callback 并自动 commit；
    // 不模拟真正的 snapshot isolation / 锁冲突 / 重试。
    const tx = {
      collection(name) {
        return {
          doc(id) { return docOps(name, id); },
          async add({ data }, optId) {
            const id = data._id || optId || 'tx-row-' + (++nextId);
            (rows[name] ||= []).push({ _id: id, ...clone(data) });
            return { _id: id };
          },
        };
      },
    };
    return await callback(tx);
  },
};
const appFile = path.join(root, 'cloudfunctions/app/index.js');
const appRequire = createRequire(appFile);
const quiet = { log() {}, warn() {}, error() {} };
// The handler and its date helper must share the same fixture clock. Loading
// taskRules with host require left Date.now() real, causing next-day failures.
const ruleContext = vm.createContext({ module: { exports: {} }, Date: AuditDate });
vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/app/lib/taskRules.js'), 'utf8'), ruleContext);
const context = vm.createContext({
  require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'owner' }) };
    if (name === 'https') return { request() { throw new Error('Network disabled'); } };
    if (name === './lib/taskRules') return ruleContext.module.exports;
    return appRequire(name);
  },
  exports: {}, Date: AuditDate, console: quiet, Buffer, setTimeout, clearTimeout,
});
vm.runInContext(fs.readFileSync(appFile, 'utf8'), context);
async function call(name, data = {}, owner = 'owner') {
  context.input = clone(data); context.owner = owner;
  return vm.runInContext(`${name}(owner, input)`, context);
}
async function apiCall(name, data) {
  const result = await call(name, data);
  if (result.code === -1) throw new Error(result.message);
  return result.data === undefined ? result : result.data;
}
function page(relative, api, storage = new Map()) {
  const file = path.join(root, relative), localRequire = createRequire(file);
  let definition;
  const app = { globalData: { currentOpenid: 'owner', userInfo: { id: 'user', openid: 'owner' } } };
  const toasts = [], modals = [];
  const wx = { showToast: options => toasts.push(options), showModal: options => modals.push(options),
    getStorageSync: key => clone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key) };
  const state = vm.createContext({
    require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
    Page: value => { definition = value; }, getApp: () => app,
    wx: new Proxy(wx, { get: (target, name) => target[name] || (() => {}) }), Date: AuditDate, console: quiet,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), state);
  definition.data = clone(definition.data);
  Object.assign(definition, { app, toasts, modals, storage, wx });
  definition.setData = function(values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
    if (callback) callback();
  };
  return definition;
}

(async () => {
  equal(rules.businessDate(Date.parse('2026-11-04T15:59:59Z')), '2026-11-04');
  equal(rules.businessDate(Date.parse('2026-11-04T16:00:00Z')), '2026-11-05');
  for (const date of ['2026-11-04T15:59:59Z', '2026-11-04T16:00:00Z']) equal(schedule.today(Date.parse(date)), rules.businessDate(Date.parse(date)));
  equal(rules.validDate('2026-02-30'), false);
  equal(rules.addDays('2028-02-28', 1), '2028-02-29');
  equal(schedule.durationDays('2周'), 14);
  equal(schedule.durationDays('1个月'), 30);
  equal(schedule.endDate('2026-11-04', 999999999999), '');
  equal(schedule.draftTasks([{ title: '日期越界', day_index: 9 }], '2026-11-04', 7)[0].date, '');

  rows = { users: [{ _id: 'user', _openid: 'owner', total_xp: 0 }] };
  const ai = page('miniprogram/pages/ai/ai.js', {
    publishAiPlan: data => apiCall('publishAiPlan', data),
  });
  ai._updatePlannerState({ generatedGoal: { title: '七天阅读', period: '7天', stages: [{ name: '起步', duration: '第1-7天' }] },
    generatedTasks: [
      { title: '开始阅读', xp_reward: 10, stage: 1, estimated_minutes: 15, day_index: 1 },
      { title: '阶段总结', xp_reward: 20, stage: 2, estimated_minutes: 25, day_index: 7 },
    ], lastPlanId: 'regression-plan' });
  // The host require has a real clock, so explicitly set the editable, user-confirmed start date.
  ai.onPlanStartDate({ detail: { value: '2026-11-04' } });
  ai.onPlanDays({ detail: { value: '' } });
  await ai.publishPlanTasks();
  equal((rows.goals || []).length, 0);
  ai.onPlanDays({ detail: { value: '7' } });
  await ai.publishPlanTasks();
  equal(rows.goals.length, 1);
  equal(rows.goals[0].target_days, 7);
  equal(rows.goals[0].end_date, '2026-11-10');
  equal(rows.tasks.length, 2); // No extra same-name initial task for an AI plan.
  equal(rows.tasks.map(task => [task.date, task.stage, task.estimated_minutes]), [['2026-11-04', 1, 15], ['2026-11-10', 2, 25]]);
  const goalId = rows.goals[0]._id;
  equal((await call('listTasks', { date: '2026-11-10', goal_id: goalId })).data[0].estimated_minutes, 25);
  equal((await call('createTask', { title: '跨用户', goal_id: goalId }, 'other')).code, -1);
  equal((await call('createTask', { title: '非法日期', date: '2026-02-30' })).code, -1);
  equal((await call('createTask', { title: '周期外', goal_id: goalId, date: '2026-11-11' })).code, -1);
  equal((await call('createTask', { title: '时长错误', estimated_minutes: -3 })).code, -1);
  equal((await call('createGoal', { title: '周期错误', target_days: 0 })).code, -1);
  equal((await call('taskCheckin', { task_id: rows.tasks[1]._id })).code, -1);
  const done = await call('taskCheckin', { task_id: rows.tasks[0]._id });
  equal(done.completed_days, 1);
  equal(rows.goals[0].completed_days, 1);
  equal(rows.tasks[1].completed, false);
  await call('repairGoalDays', { goal_id: goalId });
  equal(rows.goals[0].completed_days, 1);

  // Manual creation sends the selected duration and preserves the default initial task.
  const goalsPage = page('miniprogram/pages/goals/goals.js', {
    createGoalOnce: data => context.exports.main({ action: 'createGoalOnce', data, accountId: 'user' }),
    goals: async () => [], tasks: async () => [],
  });
  goalsPage.data.formTitle = '手动目标'; goalsPage.data.formDays = 21;
  await goalsPage.submitGoal();
  equal(rows.goals[1].target_days, 21);
  equal(rows.tasks.filter(task => task.goal_id === rows.goals[1]._id).length, 1);

  // Detail queries the selected date and keeps read errors distinct from an empty day.
  const detail = page('miniprogram/pages/goal-detail/goal-detail.js', {
    goalDetail: id => apiCall('getGoalDetail', id), tasks: data => apiCall('listTasks', data),
  });
  detail.data.goalId = goalId; detail.data.selectedDate = '2026-11-10';
  await detail.loadGoalDetail(goalId);
  equal(detail.data.tasks.map(task => task.task_date), ['2026-11-10']);
  equal(detail.data.goal.statusLabel, '进行中');
  await detail.onTaskDateChange({ detail: { value: '2026-11-04' } });
  equal(detail.data.completedTaskCount, 1);
  const failedDetail = page('miniprogram/pages/goal-detail/goal-detail.js', {
    goalDetail: id => apiCall('getGoalDetail', id), tasks: () => Promise.reject(new Error('Offline test')),
  });
  failedDetail.data.goalId = goalId;
  await failedDetail.onTaskDateChange({ detail: { value: '2026-11-10' } });
  equal(failedDetail.data.loadError, true);
  equal(failedDetail.data.loading, false);
  equal(failedDetail.data.tasks.length, 0);

  // An old response arriving after a newer date selection must not replace the new day's rows.
  const pendingDates = {};
  const racingDetail = page('miniprogram/pages/goal-detail/goal-detail.js', {
    goalDetail: id => apiCall('getGoalDetail', id),
    tasks: data => new Promise(resolve => { pendingDates[data.date] = resolve; }),
  });
  racingDetail.data.goalId = goalId;
  const firstLoad = racingDetail.onTaskDateChange({ detail: { value: '2026-11-04' } });
  while (!pendingDates['2026-11-04']) await Promise.resolve();
  const secondLoad = racingDetail.onTaskDateChange({ detail: { value: '2026-11-10' } });
  while (!pendingDates['2026-11-10']) await Promise.resolve();
  pendingDates['2026-11-10']([{ id: 'new', goal_id: goalId, date: '2026-11-10' }]);
  await secondLoad;
  pendingDates['2026-11-04']([{ id: 'old', goal_id: goalId, date: '2026-11-04' }]);
  await firstLoad;
  equal(racingDetail.data.tasks[0].id, 'new');
  equal(racingDetail.data.loading, false);

  const dateWrites = [];
  let finishCheckin, finishCreation;
  const editingDetail = page('miniprogram/pages/goal-detail/goal-detail.js', {
    goalDetail: id => apiCall('getGoalDetail', id),
    tasks: data => apiCall('listTasks', data),
    taskCheckin: data => {
      dateWrites.push(data);
      return new Promise(resolve => { finishCheckin = resolve; });
    },
    createTask: data => {
      dateWrites.push(data);
      return new Promise(resolve => { finishCreation = resolve; });
    },
  });
  Object.assign(editingDetail.data, { goalId, selectedDate: '2026-11-04', tasks: [{ id: 'unfinished' }] });
  const checkinEvent = { currentTarget: { dataset: { id: 'unfinished' } } };
  const checking = editingDetail.checkinTask(checkinEvent);
  await editingDetail.checkinTask(checkinEvent);
  equal(dateWrites, [{ task_id: 'unfinished', pet_growth: true }]);
  await editingDetail.onTaskDateChange({ detail: { value: '2026-11-10' } });
  finishCheckin({ success: true, xp_earned: 10 });
  await checking;
  equal(editingDetail.data.result, null);
  equal(editingDetail.data.tasks.map(task => task.task_date), ['2026-11-10']);

  editingDetail.showAddTask();
  editingDetail.data.taskTitle = '只创建一次';
  const creating = editingDetail.submitTask();
  await editingDetail.submitTask();
  editingDetail.cancelAdd();
  equal(editingDetail.data.showAdd, true);
  equal(dateWrites.length, 2);
  finishCreation({ success: true, id: 'new-task' });
  await creating;
  equal(editingDetail.data.showAdd, false);
  equal(editingDetail.data.submittingTask, false);
  equal(editingDetail.storage.size, 0);

  const sharedStorage = new Map();
  const submitted = [];
  let dropped = true;
  const creationApi = {
    goalDetail: id => apiCall('getGoalDetail', id), tasks: data => apiCall('listTasks', data),
    async createTask(data) {
      submitted.push(clone(data));
      const receipt = await context.exports.main({ action: 'createTaskOnce', data, accountId: 'user' });
      assert.equal(receipt.success, true);
      if (dropped) throw Error('response lost after commit');
      return receipt;
    },
  };
  const detailFile = 'miniprogram/pages/goal-detail/goal-detail.js';
  const original = page(detailFile, creationApi, sharedStorage);
  await original.onLoad({ id: goalId, date: '2026-11-10' });
  original.showAddTask();
  original.onTaskTitle({ detail: { value: '重启后确认原任务' } });
  await original.submitTask();
  equal(original.data.taskCreationPending, true);
  equal(sharedStorage.size, 1);
  equal(rows.tasks.filter(task => task.title === '重启后确认原任务').length, 1);

  const different = page(detailFile, creationApi, sharedStorage);
  different.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  await different.onLoad({ id: goalId });
  equal(different.data.taskCreationPending, false);
  equal(submitted.length, 1);
  const reopened = page(detailFile, creationApi, sharedStorage);
  await reopened.onLoad({ id: goalId });
  equal(reopened.data.taskCreationPending, true);
  equal(reopened.data.showAdd, false);
  reopened.showAddTask();
  reopened.onTaskTitle({ detail: { value: '尝试覆盖原任务' } });
  equal(reopened.data.taskTitle, '重启后确认原任务');
  dropped = false;
  await reopened.submitTask();
  equal(submitted.length, 2);
  equal(submitted[1], submitted[0]);
  equal(sharedStorage.size, 0);
  equal(rows.tasks.filter(task => task.title === '重启后确认原任务').length, 1);

  reopened.showAddTask();
  reopened.onTaskTitle({ detail: { value: '存储失败时保留输入' } });
  reopened.wx.setStorageSync = () => { throw Error('storage full'); };
  await reopened.submitTask();
  equal(reopened.data.taskTitle, '存储失败时保留输入');
  equal(submitted.length, 2);
  const rejected = page(detailFile, { ...creationApi, createTask: async () => ({ rejected: true, message: '目标已结束' }) });
  await rejected.onLoad({ id: goalId });
  rejected.showAddTask();
  rejected.onTaskTitle({ detail: { value: '被明确拒绝的任务' } });
  await rejected.submitTask();
  equal(rejected.data.taskCreationPending, false);
  equal(rejected.storage.size, 0);
  equal(rejected.data.taskTitle, '被明确拒绝的任务');
  equal(rejected.toasts.at(-1).title, '目标已结束');

  const oldList = deferred();
  let reads = 0;
  const board = page('miniprogram/pages/goals/goals.js', {
    goals: () => ++reads === 1 ? oldList.promise : Promise.resolve([{ _id: 'new-goal', title: '新账号目标' }]),
    tasks: async () => [],
  });
  const reading = board.onShow();
  board.showCreateForm();
  board.onTitle({ detail: { value: '旧账号未提交' } });
  board.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  await board.onShow();
  oldList.resolve([{ _id: 'old-goal', title: '旧账号目标' }]);
  await reading;
  equal(board.data.goals.map(g => g.id), ['new-goal']);
  equal(board.data.formTitle, '');
  equal(board.data.showForm, false);

  const goalReceipt = deferred();
  const creatingBoard = page('miniprogram/pages/goals/goals.js', {
    goals: async () => [], tasks: async () => [], createGoalOnce: () => goalReceipt.promise,
  });
  creatingBoard.showCreateForm();
  creatingBoard.onTitle({ detail: { value: '旧账号提交' } });
  const submitting = creatingBoard.submitGoal();
  creatingBoard.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  await creatingBoard.onShow();
  creatingBoard.showCreateForm();
  creatingBoard.onTitle({ detail: { value: '新账号草稿' } });
  goalReceipt.resolve({ success: true, id: 'old-created' });
  await submitting;
  equal(creatingBoard.data.formTitle, '新账号草稿');
  equal(creatingBoard.data.showForm, true);
  equal(creatingBoard.toasts, []);

  const goalFile = 'miniprogram/pages/goals/goals.js';
  const pendingGoals = new Map(), goalRequests = [];
  const goalApi = {
    goals: async () => [], tasks: async () => [],
    async createGoalOnce(data) {
      goalRequests.push(clone(data));
      const receipt = await context.exports.main({ action: 'createGoalOnce', data, accountId: 'user' });
      assert.equal(receipt.success, true);
      if (goalRequests.length === 1) throw Error('response lost after commit');
      return receipt;
    },
  };
  const beforeGoalRestart = page(goalFile, goalApi, pendingGoals);
  beforeGoalRestart._todayStr = () => '2026-11-10';
  beforeGoalRestart.showCreateForm();
  beforeGoalRestart.setData({ formTitle: '重启后确认目标', formDesc: '保存原始描述', formDays: 7, formEmoji: '📚' });
  await beforeGoalRestart.submitGoal();
  equal(beforeGoalRestart.data.goalCreationPending, true);
  beforeGoalRestart.cancelForm();
  equal(pendingGoals.size, 1);
  const otherBoard = page(goalFile, goalApi, pendingGoals);
  otherBoard.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  await otherBoard.onShow();
  equal(otherBoard.data.goalCreationPending, false);
  const recoveredBoard = page(goalFile, goalApi, pendingGoals);
  recoveredBoard._todayStr = () => '2026-11-11';
  await recoveredBoard.onShow();
  equal(recoveredBoard.data.goalCreationPending, true);
  equal(recoveredBoard.data.showForm, false);
  equal(goalRequests.length, 1);
  recoveredBoard.showCreateForm();
  recoveredBoard.onTitle({ detail: { value: '不覆盖待确认目标' } });
  recoveredBoard.selectDays({ currentTarget: { dataset: { days: 30 } } });
  equal(recoveredBoard.data.formTitle, '重启后确认目标');
  equal(recoveredBoard.data.formDays, 7);
  equal(recoveredBoard.data.goalCreationStart, '2026-11-10');
  await recoveredBoard.submitGoal();
  equal(goalRequests[1], goalRequests[0]);
  equal(pendingGoals.size, 0);
  const matchedGoals = rows.goals.filter(goal => goal.title === '重启后确认目标');
  equal(matchedGoals.length, 1);
  equal(matchedGoals[0].start_date, '2026-11-10');
  equal(rows.tasks.filter(task => task.goal_id === matchedGoals[0]._id).map(task => task.date), ['2026-11-10']);
  recoveredBoard.showCreateForm();
  recoveredBoard.onTitle({ detail: { value: '本机存储失败保留目标' } });
  recoveredBoard.wx.setStorageSync = () => { throw Error('storage full'); };
  await recoveredBoard.submitGoal();
  equal(recoveredBoard.data.formTitle, '本机存储失败保留目标');
  equal(goalRequests.length, 2);

  const delayedCheckin = deferred(), staleTasks = deferred();
  const task = { id: 'a-task', goal_id: 'g', completed: false };
  let taskReads = 0, checkinCalls = 0;
  const checkBoard = page('miniprogram/pages/goals/goals.js', {
    goals: async () => [{ _id: 'g', title: '目标' }],
    tasks: async () => ++taskReads === 2 ? staleTasks.promise : [{ ...task, completed: taskReads > 2 }],
    taskCheckin: () => { checkinCalls++; return delayedCheckin.promise; },
  });
  await checkBoard.onShow();
  const tapTask = { currentTarget: { dataset: { taskid: 'a-task', goalid: 'g' } } };
  const check = checkBoard.toggleTodayTask(tapTask);
  await checkBoard.toggleTodayTask(tapTask);
  equal(checkinCalls, 1);
  const refreshing = checkBoard.loadGoals();
  delayedCheckin.resolve({ success: true, completed_days: 1 });
  await check;
  staleTasks.resolve([task]);
  await refreshing;
  equal(checkBoard.data.goals[0].todayTasks[0].done, true);

  const detailRead = deferred(), detailCheckin = deferred();
  let updates = 0;
  const oldDetail = page('miniprogram/pages/goal-detail/goal-detail.js', {
    goalDetail: async () => ({ _id: 'g', title: '旧详情' }),
    tasks: () => detailRead.promise,
    updateGoal: async () => { updates++; return { success: true }; },
    taskCheckin: () => detailCheckin.promise,
  });
  const oldDetailLoad = oldDetail.onLoad({ id: 'g' });
  oldDetail.setData({ goal: { id: 'g' }, tasks: [task] });
  oldDetail.completeGoal();
  const oldCheckin = oldDetail.checkinTask({ currentTarget: { dataset: { id: task.id } } });
  oldDetail.app.globalData.userInfo = { id: 'recreated', openid: 'owner' };
  oldDetail.onShow();
  await oldDetail.modals[0].success({ confirm: true });
  detailRead.resolve([task]);
  detailCheckin.resolve({ success: true, xp_earned: 10 });
  await Promise.all([oldDetailLoad, oldCheckin]);
  equal(updates, 0);
  equal(oldDetail.data.goal, null);
  equal(oldDetail.data.tasks, []);
  equal(oldDetail.data.result, null);
  equal(oldDetail.data.accountChanged, true);
  equal(oldDetail.toasts, []);

  // Pagination: an unfinished task past the first page must prevent a false completed day.
  rows.goals.push({ _id: 'many', _openid: 'owner', completed_days: 0 });
  for (let i = 0; i < 205; i++) rows.tasks.push({ _id: 'many-' + i, _openid: 'owner', goal_id: 'many', date: '2026-11-04', completed: i !== 204 });
  equal((await call('listTasks', { goal_id: 'many' })).data.length, 205);
  equal((await call('repairGoalDays', { goal_id: 'many' })).completed_days, 0);
  rows.goals.push({ _id: 'empty', _openid: 'owner', completed_days: 0 });
  equal((await call('repairGoalDays', { goal_id: 'empty' })).completed_days, 0);
  equal(rows.goals.find(goal => goal._id === 'empty').completed_days, 0);
  console.log(JSON.stringify({ passed: checks, failed: 0, scope: 'Local production source + isolated database/page stubs; no cloud writes or model requests' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
