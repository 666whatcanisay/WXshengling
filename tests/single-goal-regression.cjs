// Exercises production handlers and page methods with isolated, paginated database rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const rules = require('../cloudfunctions/app/lib/taskRules');
const schedule = require('../miniprogram/utils/planSchedule');
const clone = value => JSON.parse(JSON.stringify(value));
let rows = {}, nextId = 0, clock = Date.parse('2026-11-04T08:00:00Z');
let checks = 0;
const equal = (actual, expected) => { assert.deepEqual(clone(actual), clone(expected)); checks++; };
class AuditDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => value && value.kind === 'neq' ? row[key] !== value.value : row[key] === value);
}
function query(name, filter = {}, offset = 0, limit = Infinity) {
  return {
    where: next => query(name, next, offset, limit),
    skip: value => query(name, filter, value, limit),
    limit: value => query(name, filter, offset, value),
    async get() { return { data: clone((rows[name] || []).filter(row => matches(row, filter)).slice(offset, offset + limit)) }; },
    async add({ data }) { const id = 'row-' + (++nextId); (rows[name] ||= []).push({ _id: id, ...clone(data) }); return { _id: id }; },
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
const db = { collection: name => query(name), command: { inc: value => ({ kind: 'inc', value }), neq: value => ({ kind: 'neq', value }) } };
const appFile = path.join(root, 'cloudfunctions/app/index.js');
const appRequire = createRequire(appFile);
const quiet = { log() {}, warn() {}, error() {} };
const context = vm.createContext({
  require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'owner' }) };
    if (name === 'https') return { request() { throw new Error('Network disabled'); } };
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
function page(relative, api) {
  const file = path.join(root, relative), localRequire = createRequire(file);
  let definition;
  const state = vm.createContext({
    require: name => name.endsWith('/cloudApi') ? api : localRequire(name),
    Page: value => { definition = value; }, getApp: () => ({ globalData: {} }),
    wx: new Proxy({}, { get: () => () => {} }), Date: AuditDate, console: quiet,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), state);
  definition.data = clone(definition.data);
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
    createGoal: data => apiCall('createGoal', data), createTask: data => apiCall('createTask', data),
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
  const goalsPage = page('miniprogram/pages/goals/goals.js', { createGoal: data => apiCall('createGoal', data) });
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
