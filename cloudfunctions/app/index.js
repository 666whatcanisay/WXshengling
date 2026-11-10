const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const https = require('https');
const crypto = require('crypto');
const taskRules = require('./lib/taskRules');
const publishAiPlan = require('./lib/planPublication').createPublisher(cloud, getStewardRuns);
const plannerDrafts = require('./lib/plannerDrafts').createStore(cloud,
  (tx, owner, input) => getStewardRuns().checkStandaloneSave(tx, owner, input));
const plannerContext = require('./lib/plannerContext');
const generationLease = require('./lib/modelRunLease');
const petChat = require('./lib/petChat').createService({ cloud,
  loadModel: openid => resolveAiRequest(openid, {}),
  callModel: (config, messages, maxTokens) => callLLM(config.baseUrl, config.apiKey, config.model, messages, maxTokens, { timeoutMs: 17000, usage: true }),
  observeUsage: usage => console.info('[宠物聊天缓存]', JSON.stringify(usage)),
});
const plannerReviews = require('./lib/plannerReviews').createService({ cloud, drafts: plannerDrafts,
  loadModel: openid => resolveAiRequest(openid, {}),
  callModel: (config, messages) => callLLM(config.baseUrl, config.apiKey, config.model, messages, 1800, { timeoutMs: 18000 }) });
const coachService = require('./lib/coachService').createService({ cloud,
  loadModel: openid => resolveAiRequest(openid, {}),
  callModel: (config, messages) => callLLM(config.baseUrl, config.apiKey, config.model, messages, 1800, { timeoutMs: 18000, jsonObject: true }) });
let stewardRuns;
let adjustmentService;
function getAdjustmentService() {
  if (!adjustmentService) adjustmentService = require('./lib/adjustmentService').createService({ cloud, coach: coachService,
    loadModel: openid => resolveAiRequest(openid, {}),
    callModel: (config, messages) => callLLM(config.baseUrl, config.apiKey, config.model, messages, 1800, { timeoutMs: 18000, jsonObject: true }),
    graphFactory: (...args) => require('./lib/stewardGraph.cjs').createAdjustmentGraph(...args) });
  return adjustmentService;
}
function getStewardRuns() {
  if (!stewardRuns) stewardRuns = require('./lib/stewardRuns').createService({ cloud, drafts: plannerDrafts, reviews: plannerReviews,
    generate: require('./lib/stewardPlanner').createGenerator({ cloud, drafts: plannerDrafts, doGenerate: aiDoGenerate }),
    graphFactory: (...args) => require('./lib/stewardGraph.cjs').createGraph(...args) });
  return stewardRuns;
}

function getOpenId() {
  return cloud.getWXContext().OPENID || "";
}

function todayStr() {
  return taskRules.businessDate();
}

// 【V8.5新增】宠物成长阶段进度（与前端 SpeciesConfig.getStageProgress 一致）
// 阶段: EGG(0~99) → BABY(100~299) → YOUTH(300~599) → ADULT(600~1199) → PERFECT(1200+)
var STAGE_RANGES = { EGG:[0,99], BABY:[100,299], YOUTH:[300,599], ADULT:[600,1199], PERFECT:[1200,99999] };
function getStageByGrowth(gv) {
  gv = gv || 0;
  if (gv >= 1200) return 'PERFECT';
  if (gv >= 600) return 'ADULT';
  if (gv >= 300) return 'YOUTH';
  if (gv >= 100) return 'BABY';
  return 'EGG';
}
function getStageProgress(pet) {
  if (!pet) return { currentStage: 'EGG', nextStage: 'BABY', percent: 0, growthValue: 0, growthNeeded: 100 };
  var gv = pet.growth_value || 0;
  var current = getStageByGrowth(gv);
  var range = STAGE_RANGES[current];
  var nextKey = '';
  if (current === 'EGG') nextKey = 'BABY';
  else if (current === 'BABY') nextKey = 'YOUTH';
  else if (current === 'YOUTH') nextKey = 'ADULT';
  else if (current === 'ADULT') nextKey = 'PERFECT';

  var pct = 100;
  var needed = 0;
  if (current !== 'PERFECT') {
    var rangeLen = range[1] - range[0] + 1;
    pct = Math.min(100, Math.max(0, Math.round((gv - range[0]) / rangeLen * 100)));
    needed = range[1] - gv + 1;
  }
  // 中文名映射
  var CN = { EGG:'蛋', BABY:'幼体', YOUTH:'青年', ADULT:'成年', PERFECT:'完全体' };
  return {
    currentStage: CN[current] || current,
    nextStage: CN[nextKey] || '',
    percent: pct,
    growthValue: gv,
    growthNeeded: needed,
  };
}

// 安全查询：集合不存在时返回空数组
async function safeQuery(collectionName, query) {
  try {
    const res = await db.collection(collectionName).where(query).get();
    return res.data || [];
  } catch (e) {
    console.warn(`[安全查询] 集合 ${collectionName} 查询失败:`, e.message);
    return [];
  }
}

async function safeAdd(collectionName, data) {
  try {
    // Legacy pool writers share the first-create key used by transactional awards.
    if (collectionName === 'user_growth_pool' && !data._id) data = { ...data, _id: 'pool:' + data._openid };
    return await db.collection(collectionName).add({ data });
  } catch (e) {
    console.warn(`[安全写入] 集合 ${collectionName} 写入失败:`, e.message);
    throw e;
  }
}

async function safeUpdate(collectionName, query, data) {
  try {
    return await db.collection(collectionName).where(query).update({ data });
  } catch (e) {
    console.warn(`[安全更新] 集合 ${collectionName} 更新失败:`, e.message);
    throw e;
  }
}

/**
 * 【V8.4修复】安全整文档替换 — 用于孵化等需要写入嵌套对象的场景
 *
 * 为什么需要这个函数：
 *   wx-server-sdk ~2.4.0 的 .update({ data: {nested: {...}} }) 会自动将嵌套对象
 *   flatten 为点路径（如 {"attributes.vitality": 3}），当父字段为 null 时
 *   MongoDB 拒绝写入子路径（Cannot create field 'luck' in element {attributes: null}）
 *
 * 解决方案：
 *   使用 .doc(id).set(data) 做整文档替换，不经过 flatten 路径
 *   但必须先读取当前文档保留 _id/_openid/created_at 等不可变字段
 *
 * @param {string} collectionName - 集合名
 * @param {string} docId - 文档 _id
 * @param {Object} mergeData - 要合并写入的字段（会覆盖同名字段）
 */
async function safeSet(collectionName, docId, mergeData) {
  console.log('[SAFESET] docId=', docId);
  try {
    var existing = await db.collection(collectionName).doc(docId).get();
    console.log('[SAFESET] existing raw=', JSON.stringify(existing));
    console.log('[SAFESET] existing.data=', JSON.stringify(existing && existing.data));
    if (!existing.data) {
      throw new Error('[SAFESET] 文档不存在: ' + docId);
    }
    console.log('[SAFESET] mergeData=', JSON.stringify(mergeData));
    var merged = Object.assign({}, existing.data, mergeData);
    // 删除系统字段，set() 不允许更新这些
    delete merged._id;
    delete merged._openid;
    console.log('[SAFESET] final merged=', JSON.stringify(merged));
    console.log('[SAFESET] typeof merged=', typeof merged);
    merged.updated_at = Date.now();
    return await db.collection(collectionName).doc(docId).set({
      data: merged
    });
  } catch (e) {
    console.warn(`[SAFESET] 集合 ${collectionName} 替换失败:`, e.message);
    throw e;
  }
}

/**
 * 确保集合存在（不存在则自动创建）
 * 用于首次使用时自动初始化数据库集合
 */
var _createdCollections = {}; // 缓存已确认存在的集合
async function ensureCollection(name) {
  if (_createdCollections[name]) return true; // 已确认存在
  try {
    await db.createCollection(name);
    console.log('[ensureCollection] 自动创建集合:', name);
  } catch (e) {
    // 集合已存在时 createCollection 会报错，忽略即可
    if (e.message && e.message.indexOf('already') >= 0) {
      // 已存在，正常
    } else {
      console.warn('[ensureCollection]', name, e.message);
    }
  }
  _createdCollections[name] = true;
  return true;
}

// ====== 仪表盘 ======
async function getDashboard(openid) {
  const today = todayStr();
  const [users, activeGoals, petsList, dayTasks, checkins, achievements, emotions] = await Promise.all([
    readAll('users', { _openid: openid }),
    readAll('goals', { _openid: openid, status: _.neq('deleted') }),
    readActivePets(openid),
    queryTasks({ _openid: openid, date: today }),
    readAll('checkins', { _openid: openid, date: today }),
    readAll('achievements', { _openid: openid }),
    readAll('emotions', { _openid: openid, date: today }).catch(error => {
      console.warn('[Dashboard] 今日心情读取失败', error.code || error.errCode);
      return null;
    }),
  ]);
  const todayTasks = actionableTasks(dayTasks, activeGoals);
  const user = users[0] || {};
  const activePet = petsList[0] || null;
  const completed = todayTasks.filter(t => t.completed);
  const completedCount = completed.length;
  const totalCount = todayTasks.length;
  const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const signedIn = checkins.length > 0;
  const todayXp = completed.reduce((sum, task) => sum + (Number(storedTaskExperience(task)) || 0), Number(checkins[0]?.xp_earned) || 0);
  const emotion = emotions?.filter(hasMoodLabel).reduce(preferLatestEmotion, null);

  return {
    code: 0,
    data: {
    user: {
      nickname: user.nickname || "森林伙伴",
      username: user.username || "",
      level: user.level || 1,
      total_xp: user.total_xp || 0,
      streak_days: user.streak_days || 0,
      avatar: user.avatar || "",
      role: user.role || "user",
      _id: user._id || "",
    },
    todayGrowth: { xp: todayXp, completedTasks: completedCount, totalTasks: totalCount, completionRate, streakDays: user.streak_days || 0 },
    ...(emotions ? { todayEmotion: emotion ? emotionSummary(emotion) : null } : {}),
    goals: activeGoals.map(g => ({ id: g._id, title: g.title, progress: g.progress || 0, emoji: g.emoji || "🎯" })),
    signedIn,
    todayTasks: todayTasks.map(t => ({ id: t._id, title: t.title, completed: t.completed, xp_reward: storedTaskExperience(t) })),
    achievements: achievements || [],
    activePet: activePet ? {
      id: activePet._id, name: activePet.name, stage: activePet.stage,
      level: activePet.level, experience: activePet.experience,
      egg_stage: activePet.egg_stage || 'egg',
      species: activePet.species || '',
      attribute_type: activePet.attribute_type || '',
      personality: activePet.personality || [],
      hatch_progress: activePet.hatch_progress || 0,
      is_hatched: activePet.is_hatched === true,
      // V3
      rarity: activePet.rarity || 'common',
      attributes: activePet.attributes || null,
      bond: activePet.bond || 0,
      mood: activePet.mood || 'normal',
      mood_message: activePet.mood_message || '',
      awakened: activePet.awakened || false,
      // 【V8.4修复】补充V6字段，解决首页蛋显示不一致问题
      egg_type: activePet.egg_type || 'forest_egg',
      growth_value: activePet.growth_value || 0,
      is_shiny: activePet.is_shiny === true,
      color_tier: activePet.color_tier || 'normal',
      color_label: activePet.color_label || '普通',
      talent: activePet.talent || 1,
      talent_grade: activePet.talent_grade || 'F',
      talent_name: activePet.talent_name || '普通',
      // 【V8.5新增】宠物成长阶段进度（真实经验条）
      stageProgress: getStageProgress(activePet),
    } : null,
    },
  };
}

// ====== 用户 ======
async function updateUser(openid, data) {
  const database = cloud.database({ throwOnNotFound: false });
  const { data: users } = await database.collection('users').where({ _openid: openid }).limit(2).get();
  if (users.length !== 1) return { code: -1, message: '用户记录异常，请重新登录或联系管理员' };
  return database.runTransaction(async tx => {
    const { data: user } = await tx.collection('users').doc(users[0]._id).get();
    if (user?._openid !== openid || user.status === 'banned') {
      return { code: -1, message: '当前账号无法更新资料，请重新登录' };
    }
    const fields = { updated_at: Date.now() };
    if (data.nickname !== undefined) fields.nickname = data.nickname;
    if (data.avatar !== undefined) fields.avatar = data.avatar;
    await updateTransactionRow(tx, 'users', user._id, fields);
    return { success: true };
  });
}

// ====== 签到 ======
async function updateTransactionRow(tx, collection, id, data) {
  const result = await tx.collection(collection).doc(id).update({ data });
  if (result.stats?.updated !== 1) throw new Error('结算记录未更新: ' + collection);
}

async function rewardContext(openid, accountId) {
  const database = cloud.database({ throwOnNotFound: false });
  const [users, pools] = await Promise.all([
    database.collection('users').where({ _openid: openid }).limit(2).get(),
    database.collection('user_growth_pool').where({ _openid: openid }).limit(2).get(),
  ]);
  if (users.data.length !== 1) return { code: -1, message: '用户记录异常，请重新登录或联系管理员' };
  if (accountId && (users.data[0]._id !== accountId || users.data[0].status === 'banned')) {
    return { code: -1, message: '账号会话已失效，请重新登录' };
  }
  if (pools.data.length > 1) return { code: -1, message: '成长池记录重复，请联系管理员' };
  const legacyPool = pools.data[0];
  return { database, userId: users.data[0]._id, poolId: legacyPool?._id || 'pool:' + openid, legacyPool };
}

async function selectRewardPet(openid) {
  const pets = await readActivePets(openid);
  return pets.find(pet => pet.is_hatched === false) || pets.find(pet => pet.is_hatched === true);
}

async function readRewardPool(tx, context, openid) {
  const pool = (await tx.collection('user_growth_pool').doc(context.poolId).get()).data;
  if ((pool && pool._openid !== openid) || (context.legacyPool && !pool)) throw new Error('成长池记录已变更，请刷新后重试');
  return pool;
}

async function creditRewardPool(tx, context, pool, openid, balance, earned, now, extra = {}) {
  if (pool) {
    await updateTransactionRow(tx, 'user_growth_pool', context.poolId, {
      ...(balance ? { growth_pool: _.inc(balance) } : {}),
      ...(earned ? { total_earned: _.inc(earned) } : {}),
      updated_at: now, ...extra,
    });
  } else {
    await tx.collection('user_growth_pool').add({ data: {
      _id: context.poolId, _openid: openid, growth_pool: balance, total_earned: earned,
      created_at: now, updated_at: now, ...extra,
    } });
  }
}

async function dailyCheckin(openid) {
  const today = todayStr();
  const existing = await db.collection('checkins').where({ _openid: openid, date: today }).limit(1).get();
  if (existing.data.length) return { success: true, already_signed: true, message: '今日已签到' };

  const context = await rewardContext(openid);
  if (context.code === -1) return context;
  const selected = await selectRewardPet(openid);
  const receiptId = 'daily:' + openid + ':' + today;
  const result = await context.database.runTransaction(async tx => {
    const receipt = (await tx.collection('checkins').doc(receiptId).get()).data;
    const user = (await tx.collection('users').doc(context.userId).get()).data;
    if (!user || user._openid !== openid) throw new Error('用户记录已变更，请刷新后重试');
    if (receipt || user.last_checkin_date === today) {
      return { success: true, already_signed: true, streak_days: user.streak_days, message: '今日已签到' };
    }
    const pool = await readRewardPool(tx, context, openid);
    const pet = selected && (await tx.collection('pets').doc(selected._id).get()).data;
    const now = Date.now();
    if (todayStr() !== today) throw new Error('日期已更新，请重新签到');
    const streak = user.last_checkin_date === taskRules.addDays(today, -1) ? (user.streak_days || 0) + 1 : 1;
    const growth = await applyPetGrowth(tx, pet, openid, GROWTH_SOURCES.checkin.value, now);
    await creditRewardPool(tx, context, pool, openid, growth.unused, GROWTH_SOURCES.checkin.value, now);
    await updateTransactionRow(tx, 'users', context.userId, {
      total_xp: _.inc(10), streak_days: streak, last_checkin_date: today, updated_at: now,
    });
    await tx.collection('checkins').add({ data: {
      _id: receiptId, _openid: openid, date: today, xp_earned: 10, pet_growth_awarded: true, created_at: now,
    } });
    return { success: true, xp_earned: 10, streak_days: streak, growth };
  });
  if (result.growth) {
    await notifyGrowthEvent(openid, result.growth);
    if (result.streak_days === 7 || result.streak_days === 30) {
      try {
        const pets = await readActivePets(openid);
        const pet = pets.find(item => item.is_hatched === true);
        if (pet) await checkAndGeneratePetEvent(openid, pet, 'streak_' + result.streak_days);
      } catch (error) { console.warn('[签到事件] 生成失败'); }
    }
    delete result.growth;
  }
  return result;
}

// ====== 目标 ======
async function listGoals(openid) {
  const data = await readAll('goals', { _openid: openid, status: _.neq("deleted") });
  return { success: true, data: data.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)) };
}

function stableId(prefix, parts) {
  return prefix + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function createGoal(openid, data, accountId) {
  if (typeof data.title !== 'string' || !data.title.trim()) return { code: -1, message: "目标标题不能为空" };
  const requestId = data.request_id;
  if (accountId && (!requestId || !taskRules.validDate(data.start_date))) {
    return { code: -1, message: '目标创建请求不完整' };
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w:.-]{1,128}$/.test(requestId))) {
    return { code: -1, message: '创建标识不正确' };
  }
  const days = taskRules.positiveInteger(data.target_days === undefined ? (data.target_value === undefined ? 30 : data.target_value) : data.target_days);
  const startDate = data.start_date || todayStr();
  if (!days || !taskRules.validDate(startDate)) return { code: -1, message: "目标周期或开始日期不正确" };
  let endDate;
  try { endDate = taskRules.addDays(startDate, days - 1); } catch (e) { return { code: -1, message: "目标周期超出日期范围" }; }
  if (!taskRules.validDate(endDate)) return { code: -1, message: "目标周期超出日期范围" };
  const now = Date.now();
  const goal = {
    _openid: openid, title: data.title, description: data.description || "",
    emoji: data.emoji || "🎯", progress: 0, target_value: days, target_days: days,
    start_date: startDate, end_date: endDate, time_zone: 'Asia/Shanghai',
    stages: Array.isArray(data.stages) ? data.stages.filter(s => s && typeof s === 'object').map(s => ({ name: String(s.name || ''), duration: String(s.duration || ''), milestone: String(s.milestone || '') })) : [],
    current_value: 0, unit: data.unit || "", status: "active", created_at: now, updated_at: now,
  };
  const initialTask = data.create_initial_task !== false;
  const id = requestId && stableId('manual_', accountId ? [openid, accountId, requestId] : [openid, requestId]);
  const binding = id && stableId('', [goal.title, goal.description, goal.emoji, days, data.start_date || '', goal.stages, goal.unit, initialTask]);
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    if (accountId) {
      const { data: account } = await tx.collection('users').doc(accountId).get();
      if (!account || account._openid !== openid || account.status === 'banned') {
        return { code: -1, message: '账号会话已失效，请重新登录' };
      }
    }
    if (id) {
      const old = (await tx.collection('goals').doc(id).get()).data;
      if (old) return old._openid === openid && old.create_binding === binding
        ? { success: true, id, already_created: true }
        : { code: -1, message: '此创建请求已使用，请刷新目标列表' };
      Object.assign(goal, { _id: id, create_binding: binding });
    }
    const goalId = (await tx.collection('goals').add({ data: goal }))._id;
    if (!goalId) throw new Error('目标未能保存');
    if (initialTask) {
      const task = await tx.collection('tasks').add({ data: {
        _openid: openid, goal_id: goalId, title: data.title, completed: false,
        xp_reward: 10, date: startDate, created_at: now, updated_at: now,
      } });
      if (!task._id) throw new Error('初始任务未能保存');
    }
    return { success: true, id: goalId };
  });
}

async function createGoalOnce(openid, accountId, data) {
  const result = await createGoal(openid, data, accountId);
  return result.code === -1 ? { rejected: true, message: result.message } : result;
}

async function updateGoal(openid, data) {
  if (typeof data.id !== 'string' || !data.id) return { code: -1, message: "缺少目标ID" };
  const fields = {};
  ["title", "description", "emoji", "progress", "current_value", "status"].forEach(k => {
    if (data[k] !== undefined) fields[k] = data[k];
  });
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: goal } = await tx.collection('goals').doc(data.id).get();
    if (!goal || goal._openid !== openid) return { code: -1, message: '目标不存在' };
    if (goal.status === 'deleted') {
      return data.status === 'deleted' ? { success: true } : { code: -1, message: '目标不存在' };
    }
    if (goalClosed(goal) && data.status && data.status !== goal.status && data.status !== 'deleted') {
      return { code: -1, message: '目标已结束，状态不能再变更' };
    }
    await updateTransactionRow(tx, 'goals', goal._id, { ...fields, updated_at: nextGoalUpdate(goal) });
    return { success: true };
  });
}

async function deleteGoal(openid, id) {
  return updateGoal(openid, { id, status: 'deleted' });
}

async function getGoalDetail(openid, id) {
  const { data } = await db.collection('goals').where({ _id: id, _openid: openid, status: _.neq('deleted') }).limit(1).get();
  if (!data[0]) return { code: -1, message: "目标不存在" };
  return { success: true, data: data[0] };
}

// ====== 任务 ======
async function readAll(collection, filter) {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.collection(collection).where(filter).skip(offset).limit(100).get();
    const rows = page.data || [];
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}

function queryTasks(filter) { return readAll('tasks', filter); }
async function readActivePets(openid) {
  const pets = await readAll('pets', { _openid: openid });
  return pets.filter(pet => !pet.deleted_at);
}
const storedTaskExperience = task => task.xp_reward == null || task.xp_reward === '' ? 10 : task.xp_reward;
const goalClosed = goal => ['done', 'abandoned', 'deleted'].includes(goal.status);
const nextGoalUpdate = goal => Math.max(Date.now(), (Number(goal.updated_at) || 0) + 1);

function actionableTasks(tasks, goals) {
  const openGoals = new Set(goals.filter(goal => !goalClosed(goal)).map(goal => goal._id));
  return tasks.filter(task => !task.goal_id || task.completed === true || openGoals.has(task.goal_id));
}

async function listTasks(openid, params) {
  const options = typeof params === 'string' ? { date: params } : (params || {});
  const queryDate = options.date || todayStr();
  if (!taskRules.validDate(queryDate)) return { code: -1, message: "任务日期不正确" };
  const filter = { _openid: openid, date: queryDate };
  if (options.goal_id) filter.goal_id = options.goal_id;
  const [tasks, goals] = await Promise.all([queryTasks(filter), options.goal_id ? null : readAll('goals', { _openid: openid })]);
  const data = goals ? actionableTasks(tasks, goals) : tasks;
  return { success: true, data: data.map(t => ({ id: t._id, title: t.title, completed: t.completed,
    xp_reward: storedTaskExperience(t), goal_id: t.goal_id, date: t.date, stage: t.stage,
    estimated_minutes: t.estimated_minutes, completed_at: t.completed_at })) };
}

async function createTask(openid, data, accountId) {
  if (accountId && (typeof data.request_id !== 'string' || !/^[\w:.-]{1,128}$/.test(data.request_id) ||
      typeof data.goal_id !== 'string' || !data.goal_id || !taskRules.validDate(data.date))) {
    return { code: -1, message: '任务创建请求不完整' };
  }
  if (!data.title) return { code: -1, message: "任务标题不能为空" };
  if (accountId && (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200)) {
    return { code: -1, message: '任务名称需为1至200字' };
  }
  const xp = taskRules.taskExperience(data.xp_reward ?? 10);
  if (xp === null) return { code: -1, message: '任务经验需为0至1000的整数' };
  const date = data.date || todayStr();
  if (!taskRules.validDate(date)) return { code: -1, message: "任务日期不正确" };
  const minutes = data.estimated_minutes === undefined ? null : taskRules.positiveInteger(data.estimated_minutes);
  if (data.estimated_minutes !== undefined && (!minutes || minutes > 1440)) return { code: -1, message: "任务时长需为1至1440分钟" };
  if (data.stage !== undefined && !['string', 'number'].includes(typeof data.stage)) return { code: -1, message: "任务阶段不正确" };
  const scheduling = {};
  if (minutes !== null) scheduling.estimated_minutes = minutes;
  if (data.stage !== undefined) scheduling.stage = data.stage;
  const task = {
    _openid: openid, title: data.title, goal_id: data.goal_id || "",
    xp_reward: xp, completed: false, date, ...scheduling,
    created_at: Date.now(), updated_at: Date.now(),
  };
  if (task.goal_id) {
    const id = accountId && stableId('manual_task_', [openid, accountId, data.request_id]);
    const binding = id && stableId('', [task.goal_id, task.title, date, xp, minutes, data.stage ?? null]);
    const database = cloud.database({ throwOnNotFound: false });
    return database.runTransaction(async tx => {
      if (id) {
        const { data: account } = await tx.collection('users').doc(accountId).get();
        if (!account || account._openid !== openid || account.status === 'banned') {
          return { code: -1, message: '账号会话已失效，请重新登录' };
        }
        const { data: existing } = await tx.collection('tasks').doc(id).get();
        if (existing) {
          return existing._openid === openid && existing.create_binding === binding
            ? { success: true, id, already_created: true }
            : { code: -1, message: '此创建请求已使用，请核对目标任务' };
        }
      }
      const { data: goal } = await tx.collection('goals').doc(task.goal_id).get();
      if (!goal || goal._openid !== openid) return { code: -1, message: '目标不存在' };
      if (goalClosed(goal)) return { code: -1, message: '目标已结束，不能新增任务' };
      if ((goal.start_date && date < goal.start_date) || (goal.end_date && date > goal.end_date)) return { code: -1, message: '任务日期超出目标周期' };
      await updateTransactionRow(tx, 'goals', goal._id, { task_activity_version: _.inc(1) });
      const result = await tx.collection('tasks').add({ data: id ? { ...task, _id: id, create_binding: binding } : task });
      if (!result._id) throw new Error('任务未能保存');
      return { success: true, id: result._id };
    });
  }
  const res = await safeAdd('tasks', task);
  return { success: true, id: res._id };
}

async function createTaskOnce(openid, accountId, data) {
  const result = await createTask(openid, data, accountId);
  return result.code === -1 ? { rejected: true, message: result.message } : result;
}

// 核心奖励原子结算；事务外只定位旧随机 ID，结算依据均在事务内重读。
async function taskCheckin(openid, data, { makeup = false, accountId } = {}) {
  if (typeof data.task_id !== 'string' || !data.task_id) return { code: -1, message: "缺少任务ID" };
  if (!openid) return { code: -1, message: "未登录" };
  const context = await rewardContext(openid, accountId);
  if (context.code === -1) return context;
  const { userId } = context;
  const selected = data.pet_growth === true ? await selectRewardPet(openid) : null;
  const settlement = await context.database.runTransaction(async tx => {
    const task = (await tx.collection("tasks").doc(data.task_id).get()).data;
    if (!task || task._openid !== openid) return { code: -1, message: "任务不存在" };
    if (task.date && task.date > todayStr()) return { code: -1, message: "未来任务请到当天再打卡" };
    if (makeup && (!task.goal_id || (task.date !== todayStr() && !(accountId && task.completed)))) {
      return { code: -1, message: '只能补签今日的目标任务' };
    }
    if (task.completed) return { success: true, already_completed: true, xp_earned: 0, message: "任务已完成" };
    const goal = task.goal_id && (await tx.collection('goals').doc(task.goal_id).get()).data;
    if (task.goal_id && (!goal || goal._openid !== openid || goalClosed(goal))) {
      return { code: -1, message: '目标已结束或不可用，不能继续打卡' };
    }
    const user = (await tx.collection("users").doc(userId).get()).data;
    const pool = await readRewardPool(tx, context, openid);
    if (!user || user._openid !== openid) throw new Error("用户记录已变更，请刷新后重试");
    const pet = selected && (await tx.collection('pets').doc(selected._id).get()).data;
    const xpReward = taskRules.taskExperience(storedTaskExperience(task));
    if (xpReward === null) return { code: -1, message: '任务经验超出有效范围，未结算' };
    const now = Date.now();
    const backpack = makeup ? backpackAfterUse(pool, '补签卡') : null;
    if (makeup && !backpack) return { code: -1, message: '补签卡数量不足' };
    const growthValue = data.pet_growth === true && xpReward > 0 ? GROWTH_SOURCES.complete_goal.value : 0;
    // Both settlement and closing write the goal so their ordering also holds under snapshot isolation.
    if (goal) await updateTransactionRow(tx, 'goals', goal._id, { task_activity_version: _.inc(1) });
    const growth = growthValue ? await applyPetGrowth(tx, pet, openid, growthValue, now) : { unused: 0 };
    await updateTransactionRow(tx, 'tasks', task._id, {
      completed: true, completed_at: now, updated_at: now, ...(growthValue ? { pet_growth_awarded: true } : {}),
    });
    if (xpReward) await updateTransactionRow(tx, 'users', userId, { total_xp: _.inc(xpReward), updated_at: now });
    // The SDK requires explicit IDs inside data.
    await tx.collection("growth_logs").add({ data: {
      _id: 'checkin-log:' + task._id, _openid: openid, xp_change: xpReward,
      reason: makeup ? '使用了【补签卡】，补签了「' + task.title + '」' : '完成任务: ' + task.title,
      source: "task", created_at: now, updated_at: now,
    }});
    if (xpReward || backpack) {
      await creditRewardPool(tx, context, pool, openid, xpReward + growth.unused, xpReward + growthValue, now,
        backpack ? { backpack } : {});
    }
    return { success: true, xp_earned: xpReward, goal_id: task.goal_id, date: task.date, growth, backpack };
  });
  if (!settlement.success || settlement.already_completed) return settlement;
  await notifyGrowthEvent(openid, settlement.growth);
  // 派生统计在核心结算后幂等修复；不把它的失败当成奖励回滚。
  let completedDays;
  try {
    if (settlement.goal_id && (!settlement.date || settlement.date === todayStr())) {
      const result = await repairGoalDays(openid, { goal_id: settlement.goal_id });
      if (result.success) completedDays = result.completed_days;
    }
  } catch (e) { console.warn('[TASK-CHECKIN] 更新目标天数失败（非致命）:', e.message); }
  const result = { success: true, xp_earned: settlement.xp_earned };
  if (settlement.backpack) result.backpack = settlement.backpack;
  if (completedDays !== undefined) result.completed_days = completedDays;
  return result;
}

/**
 * V10.2 补录目标完成天数
 * 用于修复历史数据：任务已全部完成但 completed_days 未更新的情况
 */
async function repairGoalDays(openid, data) {
  if (!data.goal_id) return { code: -1, message: "缺少目标ID" };

  const goalId = data.goal_id;
  const date = todayStr();

  // 查询目标
  const goals = await safeQuery("goals", { _id: goalId, _openid: openid });
  if (!goals || !goals[0]) return { code: -1, message: "目标不存在" };

  const goal = goals[0];
  const lastDate = goal.last_completed_date || '';

  // 如果今天已经计过天数，跳过
  if (lastDate === date) {
    return { success: true, already_repaired: true, completed_days: goal.completed_days || 0 };
  }

  const tasks = await queryTasks({ _openid: openid, goal_id: goalId, date });
  if (!tasks.length || !tasks.every(task => task.completed)) {
    return { success: true, repaired: false, completed_days: goal.completed_days || 0 };
  }
  // The date condition prevents two concurrent completion/repair requests counting today twice.
  const change = await safeUpdate("goals", { _id: goalId, _openid: openid, last_completed_date: _.neq(date) }, {
    completed_days: _.inc(1),
    last_completed_date: date,
    updated_at: Date.now()
  });

  const updated = await safeQuery('goals', { _id: goalId, _openid: openid });
  const completedDays = updated[0] ? (updated[0].completed_days || 0) : (goal.completed_days || 0);
  const changed = change.stats ? change.stats.updated : change.updated;
  return { success: true, repaired: changed > 0, completed_days: completedDays, new_days: completedDays };
}

// ====== 宠物 V7 常量（15种物种 / 3种蛋类型 / 5阶段 / 属性决定物种）======

const SPECIES_LIST = [
  // 森林系 feline（猫科）
  'calico_cat','orange_cat','black_cat','snow_leopard','lynx',
  // 家园系 canine（犬科）
  'shiba','corgi','golden_retriever','husky','wolf',
  // 荒野系 small_mammal（小型兽类）
  'hamster','chinchilla','capybara','fox','raccoon',
];

const SPECIES_NAMES = {
  calico_cat: '三花猫', orange_cat: '橘猫', black_cat: '黑猫',
  snow_leopard: '雪豹', lynx: '猞猁',
  shiba: '柴犬', corgi: '柯基', golden_retriever: '金毛',
  husky: '哈士奇', wolf: '狼',
  hamster: '仓鼠', chinchilla: '龙猫', capybara: '水豚',
  fox: '狐狸', raccoon: '小浣熊',
};

const EGG_TYPES = {
  forest_egg: { name: '森林蛋', emoji: '🥚', color: '#7CB342' },
  home_egg:   { name: '家园蛋', emoji: '🏠', color: '#FF9800' },
  wild_egg:    { name: '荒野蛋', emoji: '🌿', color: '#8D6E63' },
};

// ===== V7.1 核心：属性→物种概率池 =====
// 孵化时读取四维属性，选择最高属性 → 对应概率池 → 按权重roll物种
// 设计原则：主物种60% / 副物种25% / 稀有15%，保证收集感
const SPECIES_PROBABILITY_POOLS = {
  forest_egg: {
    vitality:  [
      { species: 'orange_cat',   weight: 60 }, { species: 'lynx',         weight: 25 }, { species: 'snow_leopard', weight: 15 },
    ],
    wisdom: [
      { species: 'snow_leopard', weight: 60 }, { species: 'black_cat',    weight: 25 }, { species: 'lynx',         weight: 15 },
    ],
    luck: [
      { species: 'calico_cat',   weight: 60 }, { species: 'orange_cat',   weight: 25 }, { species: 'snow_leopard', weight: 15 },
    ],
    resonance: [
      { species: 'black_cat',    weight: 60 }, { species: 'calico_cat',   weight: 25 }, { species: 'lynx',         weight: 15 },
    ],
    balanced: [
      { species: 'lynx',         weight: 50 }, { species: 'snow_leopard', weight: 25 }, { species: 'black_cat',    weight: 25 },
    ],
  },
  home_egg: {
    vitality:  [
      { species: 'husky',            weight: 60 }, { species: 'shiba',            weight: 25 }, { species: 'wolf',             weight: 15 },
    ],
    wisdom: [
      { species: 'wolf',             weight: 60 }, { species: 'golden_retriever', weight: 25 }, { species: 'shiba',            weight: 15 },
    ],
    luck: [
      { species: 'corgi',            weight: 60 }, { species: 'husky',            weight: 25 }, { species: 'golden_retriever', weight: 15 },
    ],
    resonance: [
      { species: 'golden_retriever', weight: 60 }, { species: 'corgi',            weight: 25 }, { species: 'shiba',            weight: 15 },
    ],
    balanced: [
      { species: 'shiba',            weight: 50 }, { species: 'wolf',             weight: 25 }, { species: 'golden_retriever', weight: 25 },
    ],
  },
  wild_egg: {
    vitality:  [
      { species: 'fox',        weight: 60 }, { species: 'hamster',    weight: 25 }, { species: 'chinchilla', weight: 15 },
    ],
    wisdom: [
      { species: 'chinchilla', weight: 60 }, { species: 'capybara',   weight: 25 }, { species: 'hamster',    weight: 15 },
    ],
    luck: [
      { species: 'raccoon',    weight: 60 }, { species: 'fox',        weight: 25 }, { species: 'capybara',   weight: 15 },
    ],
    resonance: [
      { species: 'capybara',   weight: 60 }, { species: 'raccoon',    weight: 25 }, { species: 'hamster',    weight: 15 },
    ],
    balanced: [
      { species: 'hamster',    weight: 50 }, { species: 'capybara',   weight: 25 }, { species: 'fox',        weight: 25 },
    ],
  },
};

// ===== V8.0 天赋系统（Talent）=====
// 孵化时生成1~100，永久不变，决定成长加成幅度
const TALENT_GRADES = [
  { key: 'F', name: '普通', range: [1, 20],   color: '#9E9E9E',
    bonusMin: 1, bonusMax: 1 },
  { key: 'D', name: '良好', range: [21, 40],  color: '#42A5F5',
    bonusMin: 1, bonusMax: 2 },
  { key: 'C', name: '优秀', range: [41, 60],  color: '#66BB6A',
    bonusMin: 2, bonusMax: 2 },
  { key: 'B', name: '卓越', range: [61, 80],  color: '#FFCA28',
    bonusMin: 2, bonusMax: 3 },
  { key: 'A', name: '天才', range: [81, 95],  color: '#FF7043',
    bonusMin: 3, bonusMax: 4 },
  { key: 'S', name: '传奇', range: [96, 100], color: '#FFD700',
    bonusMin: 4, bonusMax: 5 },
];

/** V8.0：roll天赋值 */
function rollTalent() {
  return Math.floor(Math.random() * 100) + 1;
}

/** V8.0：获取天赋等级 */
function getTalentGrade(talentValue) {
  var tv = Math.max(1, Math.min(100, talentValue || 1));
  for (var i = 0; i < TALENT_GRADES.length; i++) {
    if (tv >= TALENT_GRADES[i].range[0] && tv <= TALENT_GRADES[i].range[1]) {
      return TALENT_GRADES[i];
    }
  }
  return TALENT_GRADES[0];
}

/** V8.0：根据天赋计算成长加成 */
function getTalentGrowthBonus(talentValue) {
  var grade = getTalentGrade(talentValue);
  var min = grade.bonusMin || 1;
  var max = grade.bonusMax || 3;
  if (min === max) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ===== V7.1 三档颜色变体系统 =====
// 普通(normal)92% / 稀有(rare)6% / 异色(shiny)2%
const COLOR_TIERS = {
  normal: { key: 'normal', label: '普通', probability: 0.92, suffix: 'normal' },
  rare:   { key: 'rare',   label: '稀有', probability: 0.06, suffix: 'rare' },
  shiny:  { key: 'shiny',  label: '异色', probability: 0.02, suffix: 'shiny' },
};

/**
 * V7.1：从加权概率池中roll一个物种
 */
function rollFromPool(pool) {
  if (!pool || !pool.length) return 'lynx'
  var totalWeight = pool.reduce(function(s, item) { return s + item.weight }, 0)
  var roll = Math.random() * totalWeight
  var cumulative = 0
  for (var i = 0; i < pool.length; i++) {
    cumulative += pool[i].weight
    if (roll <= cumulative) return pool[i].species
  }
  return pool[pool.length - 1].species
}

/**
 * V7.1：根据四维属性和蛋类型，从概率池中roll物种
 */
function resolveSpeciesByAttributes(attributes, eggType) {
  var pools = SPECIES_PROBABILITY_POOLS[eggType] || SPECIES_PROBABILITY_POOLS.forest_egg
  var v = attributes.vitality || 0
  var w = attributes.wisdom || 0
  var l = attributes.luck || 0
  var r = attributes.resonance || 0

  var maxVal = Math.max(v, w, l, r)
  var minVal = Math.min(v, w, l, r)

  // 四维均衡（差值 <= 5）→ 均衡池
  if (maxVal - minVal <= 5) return rollFromPool(pools.balanced)

  // 找最高属性（并列时随机选一个）
  var attrKeys = ['vitality', 'wisdom', 'luck', 'resonance']
  var maxAttrs = attrKeys.filter(function(k) {
    return k === 'vitality' ? attributes.vitality === maxVal :
           k === 'wisdom' ? attributes.wisdom === maxVal :
           k === 'luck' ? attributes.luck === maxVal :
           attributes.resonance === maxVal
  })
  if (maxAttrs.length > 1) maxAttrs.sort(function() { return Math.random() - 0.5 })

  var topAttr = maxAttrs[0]
  var pool = pools[topAttr]

  // 最高属性 < 20 也回退到均衡池
  if (!pool || maxVal < 20) return rollFromPool(pools.balanced)

  return rollFromPool(pool)
}

/**
 * V7.1：三档颜色变体判定（普通92% / 稀有6% / 异色2%）
 * @returns {{key:string, label:string, suffix:string}} 颜色档次信息
 */
function rollColorTier() {
  var r = Math.random()
  if (r < COLOR_TIERS.shiny.probability) return COLOR_TIERS.shiny
  if (r < COLOR_TIERS.shiny.probability + COLOR_TIERS.rare.probability) return COLOR_TIERS.rare
  return COLOR_TIERS.normal
}

const EGG_TO_CATEGORY = {
  forest_egg: ['calico_cat','orange_cat','black_cat','snow_leopard','lynx'],
  wild_egg:    ['hamster','chinchilla','capybara','fox','raccoon'],
};
// home_egg 固定出 canine
const HOME_EGG_CANDIDATES = [
  'shiba','corgi','golden_retriever','husky','wolf',
];

const ATTRIBUTE_TYPES = ['study', 'creative', 'action', 'social', 'lucky'];

const RARITY_ROLL = [
  { key: 'common', threshold: 70 },
  { key: 'rare', threshold: 90 },
  { key: 'epic', threshold: 98 },
  { key: 'legendary', threshold: 100 },
];

function rollRarity() {
  const rand = Math.random() * 100;
  for (const r of RARITY_ROLL) { if (rand < r.threshold) return r.key; }
  return 'common';
}

// V8.6: 四维属性权重（活力/智慧/幸运/共鸣），上限10
const SPECIES_WEIGHTS = {
  // feline（猫科）— 偏智慧+幸运
  calico_cat:   { vitality: 1.0, wisdom: 1.3, luck: 1.2, resonance: 1.1 },
  orange_cat:   { vitality: 1.1, wisdom: 1.0, luck: 1.3, resonance: 1.2 },
  black_cat:    { vitality: 0.9, wisdom: 1.3, luck: 1.0, resonance: 1.1 },
  snow_leopard: { vitality: 1.3, wisdom: 1.1, luck: 1.0, resonance: 0.9 },
  lynx:         { vitality: 1.2, wisdom: 1.2, luck: 1.1, resonance: 0.9 },
  // canine（犬科）— 偏活力+共鸣
  shiba:            { vitality: 1.4, wisdom: 0.9, luck: 1.0, resonance: 1.2 },
  corgi:            { vitality: 1.1, wisdom: 1.0, luck: 1.1, resonance: 1.3 },
  golden_retriever: { vitality: 1.2, wisdom: 1.1, luck: 1.0, resonance: 1.4 },
  husky:            { vitality: 1.3, wisdom: 0.8, luck: 1.1, resonance: 1.0 },
  wolf:             { vitality: 1.4, wisdom: 1.2, luck: 0.9, resonance: 0.8 },
  // small_mammal（小型兽类）— 偏幸运+智慧
  hamster:   { vitality: 0.9, wisdom: 1.2, luck: 1.1, resonance: 1.0 },
  chinchilla: { vitality: 1.0, wisdom: 1.1, luck: 1.2, resonance: 1.2 },
  capybara:   { vitality: 1.0, wisdom: 0.9, luck: 1.2, resonance: 1.4 },
  fox:        { vitality: 1.2, wisdom: 1.2, luck: 1.3, resonance: 1.0 },
  raccoon:    { vitality: 1.0, wisdom: 1.3, luck: 1.2, resonance: 1.1 },
};

function generateAttributes(species) {
  var w = SPECIES_WEIGHTS[species] || SPECIES_WEIGHTS.hamster;
  var attrs = {};
  // V8.6: 上限10，根据物种权重生成 2~7 的初始值
  var keys = ['vitality', 'wisdom', 'luck', 'resonance'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var weight = w[key] || 1.0;
    var val = Math.round(2 + Math.random() * 5 * weight);
    val = Math.max(1, Math.min(10, val));
    attrs[key] = val;
  }
  return attrs;
}

const AWAKEN_PREFIX = {
  calico_cat: '斑纹', orange_cat: '暖阳', black_cat: '暗影',
  snow_leopard: '霜雪', lynx: '荒野',
  shiba: '烈焰', corgi: '萌心', golden_retriever: '光辉',
  husky: '寒冰', wolf: '暗月',
  hamster: '圣光', chinchilla: '星辉', capybara: '淡定',
  fox: '幻影', raccoon: '月影',
};

const MOODS = ['excited', 'happy', 'normal', 'sleepy', 'bored', 'sad'];
const MOOD_MESSAGES = {
  excited: ['主人今天超棒！', '太开心了想转圈圈！', '今天也要元气满满！'],
  happy: ['和你在一起最开心啦～', '嘿嘿，今天也很满足！', '主人最好了！'],
  normal: ['今天一起加油吧～', '平静的一天也不错呢', '嗯，继续努力！'],
  sleepy: ['哈欠...有点困了...', '能不能小睡一会儿？', '眼皮好重...'],
  bored: ['今天没什么事做呢...', '好无聊啊，陪我玩嘛', '发呆中...'],
  sad:   ['我有点想你...', '主人是不是忘了我？', '有点难过...抱抱我...'],
};

function pickMoodMessage(mood) {
  const pool = MOOD_MESSAGES[mood] || MOOD_MESSAGES.normal;
  return pool[Math.floor(Math.random() * pool.length)];
}

const INTERACTION_FEEDBACK = {
  feed: {
    default: ['开心地吃掉了食物！', '大口大口地吃，真香！', '满足地舔了舔嘴～'],
    hamster: ['仓鼠把食物塞进腮帮子！', '小爪子捧着食物啃得好香～', '腮帮子鼓鼓的太可爱了！'],
    shiba:   ['柴犬摇着尾巴大口吃！', '汪！好吃好吃！', '三两下就吃完了，还要！'],
    orange_cat:['橘猫挑剔地闻了闻才吃', '喵呜～味道还不错', '优雅地舔了舔爪子'],
    calico_cat: ['狸花猫优雅地叼走食物', '像小老虎一样大口吃', '吃完舔了舔爪子'],
    snow_leopard: ['雪豹小心翼翼地品尝', '高贵地享用美食', '满足地眯起眼睛'],
    lynx: ['猞猁用爪子按住食物', '耳朵抖动着吃得很香', '快速消灭了食物'],
    golden_retriever: ['金毛摇着大尾巴开心吃', '汪汪！太好吃了！', '温暖地蹭了蹭你'],
    capybara: ['水豚淡定地嚼了嚼', '……味道还行', '慢悠悠地吃完了'],
    fox: ['狐狸狡黠地看了看四周才吃', '快速叼走藏起来吃', '吃得满嘴都是'],
    raccoon: ['小浣熊洗了洗食物再吃', '捧着食物左右开弓', '眼罩闪闪发光地吃掉了'],
  },
  play: {
    default: ['围着你转圈圈！', '玩得好开心！', '再来一次！'],
    hamster: ['仓鼠在跑轮上狂奔！', '小短腿跑得飞快！', '滚成了一个毛球！'],
    shiba:   ['柴犬追着自己的尾巴跑', '汪汪叫着扑过来！', '四脚朝天打滚耍赖'],
    husky:   ['哈士奇开始拆家模式！', '二哈的破坏力惊人！', '一脸无辜地看着你'],
    calico_cat: ['狸花猫灵活地跳上跳下', '像猎手一样扑向玩具', '得意地甩了甩尾巴'],
    snow_leopard: ['雪豹在雪地上打滚', '优雅地翻了个跟头', '威风凛凛地巡视领地'],
    lynx: ['猞猁在岩石间跳跃', '耳朵竖起来警觉地观察', '敏捷地抓住飞虫'],
    golden_retriever: ['金毛叼着飞盘跑过来', '兴奋地转圈圈', '用鼻子拱你玩'],
    capybara: ['水豚慢吞吞地挪动', '趴在地上晒太阳不想动', '淡定地看着你闹腾'],
    fox: ['狐狸狡猾地把玩具藏起来', '假装受伤引你注意', '突然窜出来吓你一跳'],
    raccoon: ['小浣熊把东西翻得乱七八糟', '好奇地研究你的手指', '抱着东西不撒手'],
  },
  pet: {
    default: ['舒服地眯起眼睛！', '蹭了蹭你的手心', '发出满足的声音～'],
    hamster: ['仓鼠缩成小球靠在你手心', '小爪子扒拉着你的手指', '眯着眼睛好享受'],
    shiba:   ['柴犬疯狂摇尾巴！', '舌头伸出来哈气', '把头塞进你怀里撒娇'],
    orange_cat:['橘猫踩奶式按摩', '喉咙里发出呼噜声', '用头顶轻轻顶你'],
    calico_cat: ['狸花猫傲娇地偏过头', '又忍不住蹭了蹭你', '尾巴尖勾住你的手腕'],
    snow_leopard: ['雪豹把头靠在你肩上', '温顺地闭上眼睛', '用脸颊轻轻磨蹭你'],
    lynx: ['猞猁警惕后放松下来', '允许你摸摸耳尖', '喉咙里发出低沉呼噜声'],
    golden_retriever: ['金毛把大脑袋搁你腿上', '湿漉漉的鼻子蹭你脸', '整个身子贴过来求抱抱'],
    capybara: ['水豚面无表情地任你抚摸', '……（毫无反应）', '偶尔眨一下眼睛表示知道你在'],
    fox: ['狐狸试探性地凑近', '毛茸茸的大尾巴扫过你手背', '狡黠地眯起眼睛享受'],
    raccoon: ['小浣熊用爪子握住你的手指', '眼罩闪闪发光地看着你', '舒服地缩成一团靠着你'],
  },
};

function getInteractionFeedback(action, species) {
  const pool = (INTERACTION_FEEDBACK[action] && INTERACTION_FEEDBACK[action][species])
    || (INTERACTION_FEEDBACK[action] && INTERACTION_FEEDBACK[action].default)
    || INTERACTION_FEEDBACK.pet.default;
  return pool[Math.floor(Math.random() * pool.length)];
}

const BOND_LEVELS = [
  { name: '陌生', min: 0, icon: '♡' },
  { name: '熟悉', min: 200, icon: '🌲' },
  { name: '伙伴', min: 400, icon: '�' },
  { name: '好友', min: 700, icon: '�' },
  { name: '挚友', min: 900, icon: '❤️' },
];

function getBondLevel(bond) {
  for (let i = BOND_LEVELS.length - 1; i >= 0; i--) {
    if (bond >= BOND_LEVELS[i].min) return BOND_LEVELS[i];
  }
  return BOND_LEVELS[0];
}

const PERSONALITY_TYPES = ['lively', 'cool', 'tsundere', 'airhead', 'scholar', 'foodie', 'socialphobia'];

const GROWTH_SOURCES = {
  checkin:       { label: '每日签到', value: 5 },
  complete_goal: { label: '完成目标', value: 10 },
  streak_bonus:  { label: '连续打卡', value: 20 },
  ai_focus:      { label: 'AI专注计时', value: 15 },
};

// V8.2：成长阶段阈值（云函数独立配置，PERFECT=1200 与前端一致）
const GROWTH_STAGE_THRESHOLDS = [
  { key: 'EGG',     minGrowth: 0,    name: '蛋' },
  { key: 'BABY',    minGrowth: 100,  name: '幼年' },
  { key: 'YOUTH',   minGrowth: 300,  name: '少年' },
  { key: 'ADULT',   minGrowth: 600,  name: '成年' },
  { key: 'PERFECT', minGrowth: 1200, name: '完美形态' },  // V8.2修正：原1000→1200
];

// ===== 经验值来源定义 =====
const PET_EVENT_TEMPLATES = {
  // 连续签到7天
  streak_7: {
    type: 'letter',
    title: '💌 宠物给你写了一封信',
    generateContent: function(petName, speciesName, streakDays) {
      var templates = [
        '亲爱的主人，\n\n今天是你连续签到的第' + streakDays + '天！\n\n'
          + '我——' + petName + '，看着你每天坚持的样子，真的很为你骄傲。\n\n'
          + '虽然我只是只小小的' + speciesName + '，但我会一直陪在你身边的。\n\n'
          + '明天也一起加油吧！\n\n—— 来自' + petName + '的悄悄话',
        '主人主人！\n\n已经连续' + streakDays + '天啦！\n\n'
          + petName + '在这里给你比心！❤️\n\n'
          + '你是最棒的！不要放弃哦～',
        '嘿，发现没？\n\n你已经坚持了' + streakDays + '天了！\n\n'
          + '作为你的' + speciesName + '伙伴，我决定授予你一个称号：\n\n'
          + '「坚持之星 ✨」\n\n'
          + '——' + petName + ' 敬上',
      ];
      return templates[Math.floor(Math.random() * templates.length)];
    },
  },
  // 连续签到30天
  streak_30: {
    type: 'title',
    title: '🏅 获得成长纪念称号',
    generateContent: function(petName, speciesName, streakDays) {
      var titles = [
        '「' + petName + '的守护者」',
        '「' + streakDays + '天连续自律王」',
        '「与' + speciesName + '共进的勇士」',
        '「不屈不挠的坚持者」',
      ];
      return '恭喜获得称号：\n\n★ ' + titles[Math.floor(Math.random() * titles.length)] + ' ★\n\n这是你和' + petName + '共同成长的见证！';
    },
  },
  // 达到成年 ADULT
  reach_adult: {
    type: 'memory',
    title: '💫 解锁成长纪念语',
    generateContent: function(petName, speciesName) {
      var memories = [
        '从一颗蛋到现在的样子，我们一起走了很远的路。\n\n'
          + petName + '想对你说：谢谢你选择了我。\n\n'
          + '未来的路，我也会一直在。',
        '还记得第一次见面吗？那时的我还只是一颗蛋。\n\n'
          + '现在我已经长大了，而你也变得更优秀了。\n\n'
          + '—— 成年后的' + petName,
      ];
      return memories[Math.floor(Math.random() * memories.length)];
    },
  },
  // 达到完美形态 PERFECT
  reach_perfect: {
    type: 'record',
    title: '👑 获得专属成长记录',
    generateContent: function(petName, speciesName, attrs) {
      return '★ 完美形态达成 ★\n\n'
        + petName + '(' + speciesName + ') 已达到终极形态！\n\n'
        + '最终属性：\n'
        + '🔥 活力 ' + (attrs.vitality || 0) + '\n'
        + '📖 智慧 ' + (attrs.wisdom || 0) + '\n'
        + '⭐ 幸运 ' + (attrs.luck || 0) + '\n'
        + '💗 共鸣 ' + (attrs.resonance || 0) + '\n\n'
        + '这是一段属于你们独一无二的成长故事。';
    },
  },
};

/**
 * 检查并生成宠物事件
 * @param {string} openid
 * @param {object} pet - 宠物对象
 * @param {string} eventType - 事件类型 (streak_7 / streak_30 / reach_adult / reach_perfect)
 * @returns {object|null} 生成的事件对象，或null（已触发过）
 */
async function checkAndGeneratePetEvent(openid, pet, eventType) {
  // 检查是否已触发过同类事件
  var existingEvents = pet.pet_events || [];
  var alreadyTriggered = existingEvents.some(function(e) { return e.trigger_type === eventType });
  if (alreadyTriggered) return null; // 已触发过

  var template = PET_EVENT_TEMPLATES[eventType];
  if (!template) return null;

  var petName = pet.name || '小伙伴';
  var speciesName = SPECIES_NAMES[pet.species] || '神秘生物';
  var eventContent = '';

  // 根据事件类型获取额外参数
  if (eventType === 'streak_7' || eventType === 'streak_30') {
    var userRes = await safeQuery("users", { _openid: openid });
    var streakDays = (userRes[0] && userRes[0].streak_days) || 0;
    eventContent = template.generateContent(petName, speciesName, streakDays);
  } else if (eventType === 'reach_perfect') {
    eventContent = template.generateContent(petName, speciesName, pet.attributes || {});
  } else {
    eventContent = template.generateContent(petName, speciesName);
  }

  var newEvent = {
    id: 'evt_' + eventType + '_' + Date.now(),
    type: template.type,
    title: template.title,
    content: eventContent,
    trigger_type: eventType,
    triggered_at: Date.now(),
    read: false,
  };

  // 写入数据库
  // 【V8.3修复2】pet_events可能为null，_.push对null会报错，改为整体替换
  var existingPetEvents = pet.pet_events;
  if (!existingPetEvents || !Array.isArray(existingPetEvents)) {
    existingPetEvents = [];
  }
  await safeUpdate("pets", { _id: pet._id }, {
    pet_events: existingPetEvents.concat(newEvent),
    updated_at: Date.now(),
  });

  return newEvent;
}

/**
 * 标记事件已读
 */
async function markEventRead(openid, data) {
  if (!data.pet_id || !data.event_id) return { code: -1, message: "缺少参数" };
  var pets = await safeQuery("pets", { _id: data.pet_id, _openid: openid });
  if (!pets || !pets[0]) return { code: -1, message: "宠物不存在" };

  var events = pets[0].pet_events || [];
  var eventIndex = events.findIndex(function(e) { return e.id === data.event_id });
  if (eventIndex < 0) return { code: -1, message: "事件不存在" };

  // 标记已读
  events[eventIndex].read = true;
  await safeUpdate("pets", { _id: data.pet_id }, {
    pet_events: events,
    updated_at: Date.now(),
  });

  return { success: true };
}

// ====== V8.2 来信系统 ======

/**
 * 检查是否有可触发的新来信
 */
async function checkLetters(openid, data) {
  var petId = data.pet_id;
  if (!petId) return { code: -1, message: "缺少pet_id" };

  var pets = await safeQuery("pets", { _id: petId, _openid: openid });
  if (!pets || !pets[0]) return { code: -1, message: "宠物不存在" };

  var pet = pets[0];
  var sentLetters = pet.sent_letter_types || [];

  var petState = {
    petName: pet.name || '小伙伴',
    checkin_streak: data.checkin_streak || 0,
    goals_completed: data.goals_completed || 0,
    bond: pet.bond || 0,
    talent_is_S: (pet.talent_grade === 'S'),
    pending_events: data.pending_events || [],
  };
  if (pet.hatch_time) {
    petState.pet_age_days = Math.floor((Date.now() - pet.hatch_time) / 86400000);
  }

  var triggers = [
    { type: 'streak_7',   letterType: 'normal',    cond: function(s){return s.checkin_streak>=7} },
    { type: 'streak_14',  letterType: 'memorial',  cond: function(s){return s.checkin_streak>=14} },
    { type: 'streak_30',  letterType: 'rare',      cond: function(s){return s.checkin_streak>=30}, permanent:true },
    { type: 'streak_100', letterType: 'legendary', cond: function(s){return s.checkin_streak>=100}, permanent:true },
    { type: 'stage_youth',  letterType: 'normal',    cond: function(s){return pet.stage==='YOUTH'} },
    { type: 'stage_adult',  letterType: 'rare',      cond: function(s){return pet.stage==='ADULT'} },
    { type: 'stage_perfect', letterType: 'legendary', cond: function(s){return pet.stage==='PERFECT'}, permanent:true },
    { type: 'bond_300',    letterType: 'normal',    cond: function(s){return s.bond>=300} },
    { type: 'bond_500',    letterType: 'rare',      cond: function(s){return s.bond>=500} },
    { type: 'talent_S_reveal', letterType:'legendary',cond: function(s){return s.talent_is_S}, permanent:true },
    { type: 'goals_10',    letterType: 'normal',    cond: function(s){return s.goals_completed>=10} },
    { type: 'goals_50',    letterType: 'memorial',  cond: function(s){return s.goals_completed>=50} },
    { type: 'pet_birthday_30',  letterType:'memorial',cond: function(s){return s.pet_age_days>=30} },
    { type: 'pet_birthday_100', letterType:'rare',   cond: function(s){return s.pet_age_days>=100} },
  ];

  var newLetters = [], newSentTypes = [];
  triggers.forEach(function(t){
    if(sentLetters.indexOf(t.type)>=0)return;
    if(!t.cond(petState))return;
    newLetters.push(_genLetter(t, petState, pet.name||'小伙伴'));
    newSentTypes.push(t.type);
  });

  if(newLetters.length===0)
    return{success:true,newLetters:[],message:"暂无新来信"};

  ensureCollection('pet_letters');
  for(var i=0;i<newLetters.length;i++){
    try{await safeAdd('pet_letters',Object.assign({_openid:openid,pet_id:petId},newLetters[i]));}catch(e){}
  }
  await safeUpdate('pets',{_id:petId},{
    sent_letter_types:sentLetters.concat(newSentTypes),updated_at:Date.now()
  });

  return{success:true,newLetters:newLetters,count:newLetters.length,message:'收到'+newLetters.length+'封新来信！'};
}

function _genLetter(t,state,pname){
  var d=state.checkin_streak||state.pet_age_days||1;
  var map={
    streak_7:{title:pname+'的悄悄话',content:'我发现你已经坚持'+d+'天了。\n虽然不知道未来会怎样。\n但我会一直陪着你。\n——'+pname},
    streak_14:{title:'两周的约定',content:d+'天了...\n你知道吗？大部分人会在第一周放弃。\n但你不一样。\n谢谢你选择了我。\n——'+pname},
    streak_30:{title:'三十天的足迹',content:'整整'+d+'天。\n这不仅仅是数字。\n这是你每天做出的选择。\n我很荣幸见证这一切。\n这封信，永久收藏吧。\n——'+pname},
    streak_100:{title:'百日传奇',content:'一百天。\n从一颗蛋，到现在的我。\n从第一天，到今天的你。\n这不是结束。\n这是我们真正的开始。\n——深爱着你的 '+pname},
    stage_youth:{title:'我长大了',content:'感觉...身体变得更有力气了。\n谢谢你陪我走到今天。\n以前我只是一个小家伙。\n现在我能做更多事了。\n——少年期的'+pname},
    stage_adult:{title:'成年礼',content:'今天是一个特别的日子。\n我长大了。\n不再是需要保护的小孩了。\n现在，换我来守护你。\n——成年的'+pname},
    stage_perfect:{title:'终极形态',content:'这是我从未想象过的样子。\n完美形态。\n这一切都是因为你从未放弃。\n谢谢你，让我成为了最好的自己。\n——完美体 '+pname},
    bond_300:{title:'成为朋友了',content:'不知不觉...\n我们的关系已经这么好了。\n谢谢你一直陪着我。\n我们...是朋友了对吧？\n——'+pname},
    bond_500:{title:'挚友之约',content:'亲密度突破了500...\n我不知道该怎么形容这种感觉。\n只知道，有你在的时候，我很安心。\n——'+pname},
    talent_S_reveal:{title:'隐藏的力量',content:'我好像...不太一样。\n感觉到体内有一种力量。\n也许这是你赋予我的天赋。\n传奇之姿...我会珍惜的。\n——觉醒了潜能的'+pname},
    goals_10:{title:'十个目标',content:'听说你已经完成了10个目标了？\n好厉害...\n我连一个都做不到（因为我只是一只宠物）\n但我会为你加油的！\n——'+pname},
    goals_50:{title:'五十个脚印',content:'50个目标。\n每一个都代表你的一次努力。\n我把这些都记在心里了。\n——'+pname},
    pet_birthday_30:{title:'满月快乐',content:'今天是我来到这个世界的第30天。\n谢谢你这一个月的照顾。\n未来的日子，也请多指教。\n——'+pname},
    pet_birthday_100:{title:'百日记',content:'100天了。\n回忆起刚孵化的时候，我还什么都不懂。\n现在我已经学会了很多。\n学会了依赖你，学会了信任你。\n——100天的'+pname},
  };
  var tpl=map[t.type]||{title:'来自'+pname+'的信',content:'有一句话想对你说...\n谢谢你一直在我身边。\n——'+pname};
  var ti={normal:{icon:'✉️',color:'#9E9E9E'},memorial:{icon:'💌',color:'#42A5F5'},
           rare:{icon:'📜',color:'#FF7043'},legendary:{icon:'👑',color:'#FFD700'}};
  return{
    id:'letter_'+Date.now()+'_'+Math.random().toString(36).substr(2,6),
    trigger_type:t.type,letter_type:t.letterType,
    letter_info:ti[t.letterType]||ti.normal,title:tpl.title,content:tpl.content,
    permanent:t.permanent||false,read:false,created_at:new Date().toISOString(),
  };
}

async function markLetterRead(openid,data){
  if(!data.letter_id)return{code:-1,message:"缺少letter_id"};
  var letters=await safeQuery('pet_letters',{_openid:openid,id:data.letter_id});
  if(!letters||!letters[0])return{code:-1,message:"信件不存在"};
  await safeUpdate('pet_letters',{id:data.letter_id,_openid:openid},{read:true,read_at:Date.now()});
  return{success:true};
}

async function getLetterCollection(openid){
  ensureCollection('pet_letters');
  var letters=await safeQuery('pet_letters',{_openid:openid});
  if(!letters||!letters.length)return{success:true,letters:[],total:0};
  letters.sort(function(a,b){return(b.created_at||'').localeCompare(a.created_at||'')});
  var stats={normal:0,memorial:0,rare:0,legendary:0};
  letters.forEach(function(l){var lt=l.letter_type||'normal';stats[lt]=(stats[lt]||0)+1;});
  return{
    success:true,letters:letters,total:letters.length,
    unread:letters.filter(function(l){return!l.read}).length,stats:stats
  };
}

function rollSpeciesByEggType(eggType) {
  var candidates;
  if (eggType === 'home_egg') {
    candidates = HOME_EGG_CANDIDATES;
  } else if (EGG_TO_CATEGORY[eggType]) {
    candidates = EGG_TO_CATEGORY[eggType];
  } else {
    candidates = EGG_TO_CATEGORY['forest_egg'];
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function getEggStage(growthValue) {
  var v = growthValue || 0;
  // V6：蛋子阶段视觉状态
  if (v >= 100) return 'hatched';
  if (v >= 50)  return 'cracking_egg';
  if (v >= 25)  return 'glowing_egg';
  return 'pattern_egg';
}

/**
 * V8.2：根据 growth_value 获取当前成长阶段（使用本地 GROWTH_STAGE_THRESHOLDS）
 */
function getGrowthStage(growthValue) {
  var v = growthValue || 0;
  for (var i = GROWTH_STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (v >= GROWTH_STAGE_THRESHOLDS[i].minGrowth) {
      return GROWTH_STAGE_THRESHOLDS[i];
    }
  }
  return GROWTH_STAGE_THRESHOLDS[0];
}

function getHatchedGrowthStage(pet) {
  const stage = getGrowthStage(pet.growth_value);
  return stage.key !== 'EGG' ? stage : GROWTH_STAGE_THRESHOLDS.slice(1).find(entry => entry.key === pet.stage) || GROWTH_STAGE_THRESHOLDS[1];
}

/**
 * V8.2：检查是否跨阶段
 */
function checkStageUp(oldGrowth, newGrowth) {
  var oldStage = getGrowthStage(oldGrowth);
  var newStage = getGrowthStage(newGrowth);
  if (oldStage.key !== newStage.key) return newStage;
  return null;
}

/**
 * V6：阶段升级时生成四维属性随机奖励
 * 返回 { vitality: N, wisdom: N, luck: N, resonance: N }
 */
function generateStageUpBonus() {
  var allAttrs = ['vitality', 'wisdom', 'luck', 'resonance'];

  // 随机选1~2个属性来提升
  var numAttrsToBoost = 1 + Math.floor(Math.random() * 2); // 1或2
  // 打乱并取前N个
  var shuffled = allAttrs.slice().sort(function() { return Math.random() - 0.5; });
  var selectedAttrs = shuffled.slice(0, numAttrsToBoost);

  var result = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 }; // 默认0

  selectedAttrs.forEach(function(attr) {
    result[attr] = 1 + Math.floor(Math.random() * 3); // +1 ~ +3
  });

  return result;
}

/**
 * 生成宠物孵化时的初始四维属性（每项1~5随机）
 * @returns {object} { vitality: N, wisdom: N, luck: N, resonance: N }
 */
function generateInitialAttributes() {
  var attrs = ['vitality', 'wisdom', 'luck', 'resonance'];
  var result = {};
  attrs.forEach(function(key) {
    result[key] = 1 + Math.floor(Math.random() * 5); // 1~5
  });
  return result;
}

// ====== 孵化核心（V7：属性决定物种 + 异色系统）======
/**
 * V7 孵化核心：
 *   1. 生成初始四维属性（每项1~5随机）
 *   2. 根据属性最高项 + 蛋类型 → 确定物种
 *   3. 5%概率异色
 *   4. 稀有度独立于物种
 */
function hatchPetV7(eggType) {
  // 1. 生成初始四维属性
  var initAttrs = generateInitialAttributes()

  // 2. V7.1：从概率池中roll物种（增加收集感）
  var species = resolveSpeciesByAttributes(initAttrs, eggType)

  // 3. V7.1：三档颜色变体判定（普通92%/稀有6%/异色2%）
  var colorTier = rollColorTier()

  // 4. V8.0：roll天赋值（1~100，永久不变）
  var talentValue = rollTalent()
  var talentGrade = getTalentGrade(talentValue)

  // 5. 稀有度独立判定
  var rarity = rollRarity()

  var personality = PERSONALITY_TYPES[Math.floor(Math.random() * PERSONALITY_TYPES.length)]

  return {
    species: species,
    name: SPECIES_NAMES[species] || '神秘生物',
    stage: 'BABY',
    is_hatched: true,
    rarity: rarity,
    attributes: initAttrs,
    is_shiny: colorTier.key === 'shiny',        // 兼容旧字段
    color_tier: colorTier.key,                   // V7.1 新增：颜色档次 (normal/rare/shiny)
    color_label: colorTier.label,                // V7.1 新增：颜色档位名称
    talent: talentValue,                         // V8.0 新增：天赋值 (1~100)
    talent_grade: talentGrade.key,               // V8.0 新增：天赋等级 (F/D/C/B/A/S)
    talent_name: talentGrade.name,               // V8.0 新增：天赋等级名
    bond: 50,
    mood: 'excited',
    mood_message: pickMoodMessage('excited'),
    awakened: false,
    personality: personality,
    titles: [],
    hatch_time: Date.now(),
    egg_type: eggType,
    chat_context: {
      species: species,
      species_name: SPECIES_NAMES[species] || '神秘生物',
      stage: 'BABY',
      attributes: initAttrs,
      talent: talentValue,              // V8.0
      talent_grade: talentGrade.key,    // V8.0
      personality_prompt: '',
      growth_records: [],
      created_at: Date.now(),
    },
  };
}

// ====== 宠物（V6）======
async function listPets(openid) {
  const activeData = await readActivePets(openid);
  // V8.2修复：按创建时间升序排序，确保返回顺序一致（先创建的在前）
  activeData.sort(function(a, b) {
    return (a.created_at || 0) - (b.created_at || 0);
  });
  return { success: true, data: activeData.map(p => ({
    id: p._id, name: p.name, stage: p.stage,
    level: p.level, experience: p.experience,
    egg_stage: p.egg_stage || 'egg',
    species: p.species || '',
    attribute_type: p.attribute_type || '',
    personality: p.personality || '',
    hatch_progress: p.hatch_progress || 0,
    is_hatched: p.is_hatched === true,
    // V3 新字段
    rarity: p.rarity || 'common',
    attributes: p.attributes || null,
    bond: p.bond || 0,
    mood: p.mood || 'normal',
    mood_message: p.mood_message || '',
    awakened: p.awakened || false,
    hatch_time: p.hatch_time || 0,
    // V4 新字段
    personality: p.personality || '',
    titles: p.titles || [],
    // V5 新字段
    egg_type: p.egg_type || '',
    growth_value: p.growth_value || 0,
    // 成长记录
    growth_records: p.growth_records || [],
    // 宠物陪伴事件
    pet_events: p.pet_events || [],
    // AI聊天上下文
    chat_context: p.chat_context || null,
    // V7: 异色标记
    is_shiny: p.is_shiny === true,
    // V7.1 颜色档次
    color_tier: p.color_tier || 'normal',
    color_label: p.color_label || '普通',
    // V8.0 天赋
    talent: p.talent || 1,
    talent_grade: p.talent_grade || 'F',
    talent_name: p.talent_name || '普通',
  })) };
}

// 创建神秘蛋（V6：支持3种蛋类型 + growth_value）
async function createEgg(openid, data) {
  const eggTypeKeys = Object.keys(EGG_TYPES);
  const eggType = eggTypeKeys.includes(data.egg_type)
    ? data.egg_type
    : eggTypeKeys[Math.floor(Math.random() * eggTypeKeys.length)];
  const eggInfo = EGG_TYPES[eggType];
  const database = cloud.database({ throwOnNotFound: false });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: users } = await database.collection('users').where({ _openid: openid }).limit(2).get();
    if (users.length !== 1) return { code: -1, message: '用户记录异常，请重新登录或联系管理员' };
    const user = users[0];
    // 事务只支持单文档。先读用户版本再查宠物，提交时确认期间没有其他领蛋写入。
    const pets = await readActivePets(openid);
    if (pets.length >= 3) return { code: -1, message: '最多拥有3只宠物' };
    if (pets.some(pet => pet.is_hatched === false)) return { code: -1, message: '已有正在孵化的蛋' };

    const result = await database.runTransaction(async tx => {
      const { data: currentUser } = await tx.collection('users').doc(user._id).get();
      if (currentUser?._openid !== openid || currentUser.status === 'banned') {
        return { code: -1, message: '当前账号无法领蛋，请重新登录' };
      }
      if (currentUser.pet_claim_revision !== user.pet_claim_revision) return null;
      await updateTransactionRow(tx, 'users', user._id, { pet_claim_revision: _.inc(1) });
      const now = Date.now();
      const egg = await tx.collection('pets').add({ data: {
        _openid: openid,
        name: eggInfo.name || '神秘成长蛋',
        stage: 'egg',
        egg_stage: 'egg',
        level: 1,
        experience: 0,
        species: '',
        egg_type: eggType,
        growth_value: 0,
        is_hatched: false,
        rarity: 'unknown',
        attributes: {},
        bond: 0,
        mood: 'sleepy',
        mood_message: '正在沉睡中...',
        awakened: false,
        personality: '',
        titles: [],
        created_at: now,
        updated_at: now,
      } });
      return { success: true, id: egg._id, egg_type: eggType, egg_name: eggInfo.name };
    });
    if (result) return result;
  }
  return { code: -1, message: '宠物状态已变更，请刷新后重试' };
}

/**
 * @deprecated V8.2 已废弃 — 原有领养接口（V3遗留）
 *
 * 废弃原因：
 *   1. 内部调用 hatchPetV3() 但该函数从未被定义，会导致 ReferenceError 崩溃
 *   2. 使用 V3 废弃字段（attribute_type, hatch_progress, experience, level）
 *   3. 缺少 V7+ 核心字段（talent, color_tier, is_shiny, chat_context）
 *   4. 前端已全部迁移至 createEgg + hatchProgress/allocatePool 流程
 *
 * 替代方案：
 *   第一步：action = "createEgg"     → 创建未孵化的蛋
 *   第二步：action = "hatchProgress"  → 签到/任务成长自动孵化
 *   或      action = "allocatePool"   → 手动分配经验触发孵化
 *   以上流程统一调用 performPetHatch() → hatchPetV7()
 *
 * 最后调用时间：未知（前端零引用记录）
 * 废弃时间：2026-06-18 (V8.2 P0-1修复)
 */
async function createPet(openid, data) {
  console.warn('[createPet] ⚠️ 此接口已废弃(V8.2)，请使用 createEgg + hatchProgress/allocatePool 替代');
  return {
    code: -1,
    deprecated: true,
    message: '此接口已废弃，请使用 createEgg 创建蛋后通过 allocatePool 分配经验来孵化宠物',
    alternative: { step1: 'createEgg', step2: 'allocatePool' },
  };
}

/**
 * V8.2：统一孵化执行函数（消除 hatchProgress / allocatePool 重复代码）
 *
 * 职责：
 *   1. 调用 hatchPetV7 生成属性/物种/颜色/天赋
 *   2. 构建标准化的宠物更新字段对象
 *   3. 构建标准化的聊天上下文初始化对象
 *   4. 返回统一结果供调用方写入数据库
 *
 * @param {string} eggType - 蛋类型 (forest_egg/home_egg/wild_egg)
 * @returns {{ updateFields: Object, result: Object, rarityText: Object }}
 *   - updateFields: 直接传给 safeUpdate("pets", {...}, updateFields) 的字段对象
 *   - result: hatchPetV7 的原始返回值（用于构建消息等）
 *   - rarityText: 稀有度中文映射
 */
function performPetHatch(eggType) {
  var result = hatchPetV7(eggType || 'forest_egg');
  var hatchAttrs = result.attributes || {};

  // 三层防御：确保 attributes 不为 null/undefined
  if (!hatchAttrs || typeof hatchAttrs !== 'object') {
    hatchAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
  }

  var now = Date.now();
  var rarityTextMap = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };

  var updateFields = {
    growth_value: 100,
    egg_stage: "hatched",
    is_hatched: true,
    stage: "BABY",
    species: result.species,
    name: result.name,
    rarity: result.rarity,
    attributes: hatchAttrs,
    is_shiny: result.is_shiny,
    color_tier: result.color_tier,
    color_label: result.color_label,
    talent: result.talent,
    talent_grade: result.talent_grade,
    talent_name: result.talent_name,
    bond: result.bond,
    mood: result.mood,
    mood_message: result.mood_message,
    awakened: false,
    personality: result.personality,
    titles: [],
    hatch_time: now,
    chat_context: {
      species: result.species,
      species_name: SPECIES_NAMES[result.species] || '神秘生物',
      stage: 'BABY',
      attributes: hatchAttrs,
      talent: result.talent,
      talent_grade: result.talent_grade,
      personality_prompt: '',
      growth_records: [],
      created_at: now,
    },
    growth_records: [
      { time: now, stage: 'BABY', message: '🎉 成功孵化！' },
    ],
    updated_at: now,
  };

  return {
    // 【诊断日志】打印完整updateFields，用于排查 $set is empty
    get _debug() {
      var keys = Object.keys(updateFields);
      console.log('[PERFORM-HATCH-DEBUG] updateFields keys count=' + keys.length + ':', keys.join(', '));
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = updateFields[k];
        console.log('[PERFORM-HATCH-DEBUG]   ' + k + ': type=' + typeof v + ', value=', JSON.stringify(v));
      }
      return null;
    },
    updateFields: updateFields,
    result: result,
    rarityText: rarityTextMap,
    // 辅助：构建颜色标签和天赋标签
    buildDisplayTags: function() {
      var colorTag = result.color_tier === 'shiny' ? ' ✨异色✨' :
                      result.color_tier === 'rare' ? ' 💎稀有' : '';
      var talentTag = result.talent_name ? '【' + result.talent_name + '】' : '';
      return { colorTag: colorTag, talentTag: talentTag };
    },
  };
}

// 孵化进度增加（V6→V8.2：经验池 + 多阶段成长 + 属性随机成长）
// Growth is settled with the authoritative check-in. The legacy route is read-only.
async function hatchProgress(openid, data) {
  const daily = data.source === 'checkin';
  const task = data.source === 'complete_goal' && typeof data.task_id === 'string' && data.task_id;
  if (!daily && !task) return { code: -1, message: '需要有效的签到或任务记录' };
  const database = cloud.database({ throwOnNotFound: false });
  const id = daily ? 'daily:' + openid + ':' + todayStr() : task;
  const { data: record } = await database.collection(daily ? 'checkins' : 'tasks').doc(id).get();
  if (record?._openid !== openid || record.pet_growth_awarded !== true) {
    return { code: -1, message: '没有可核实的成长奖励记录' };
  }
  return { success: true, already_awarded: true };
}

async function applyPetGrowth(tx, pet, openid, value, now) {
  if (!pet || pet._openid !== openid || pet.deleted_at) return { unused: value };
  const oldValue = Number(pet.growth_value) || 0;
  const newValue = oldValue + value;
  const patch = { growth_value: newValue, updated_at: now };
  let log, event;
  if (pet.is_hatched !== true) {
    if (newValue >= 100) {
      const hatched = performPetHatch(pet.egg_type || 'forest_egg');
      Object.assign(patch, hatched.updateFields, { attributes: _.set(hatched.updateFields.attributes) });
      log = { reason: '🎉 蛋孵化了！获得了【' + hatched.result.name + '】', source: 'hatch' };
    } else {
      patch.egg_stage = getEggStage(newValue);
    }
  } else {
    const previous = getGrowthStage(oldValue);
    const next = getGrowthStage(newValue);
    if (previous.key !== next.key) {
      const attributes = { ...(pet.attributes || {}) };
      const bonus = generateStageUpBonus();
      for (const key of Object.keys(bonus)) attributes[key] = (attributes[key] || 0) + bonus[key];
      const records = Array.isArray(pet.growth_records) ? pet.growth_records : [];
      Object.assign(patch, { stage: next.key, attributes: _.set(attributes),
        growth_records: records.concat({ time: now, stage: next.key, message: '成长为【' + next.name + '】' }) });
      log = { reason: '⬆️ 成长升级：' + previous.name + ' → ' + next.name, source: 'stage_up' };
      if (next.key === 'ADULT' || next.key === 'PERFECT') event = 'reach_' + next.key.toLowerCase();
    }
  }
  await updateTransactionRow(tx, 'pets', pet._id, patch);
  if (log) await tx.collection('growth_logs').add({ data: { _openid: openid, xp_change: 0, created_at: now, ...log } });
  return { unused: 0, pet, event };
}

async function notifyGrowthEvent(openid, growth) {
  if (!growth?.event) return;
  try { await checkAndGeneratePetEvent(openid, growth.pet, growth.event); }
  catch (error) { console.warn('[成长事件] 生成失败'); }
}

// ===== P4：性格系统 =====

/**
 * 设置宠物性格描述（用户自定义）
 * data: { pet_id: string, personality_desc: string }
 */
async function setPetPersonality(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  if (!data.personality_desc || !data.personality_desc.trim()) {
    return { code: -1, message: "性格描述不能为空" };
  }

  var desc = data.personality_desc.trim().slice(0, 50); // 最多50字
  var res = await safeUpdate("pets", { _id: data.pet_id, _openid: openid }, {
    personality_desc: desc,
    updated_at: Date.now(),
  });

  if (res && res.updated) {
    return { success: true, personality_desc: desc, message: '性格已记录：' + desc };
  }
  return { code: -1, message: "设置失败，请确认宠物属于你" };
}

/**
 * 设置宠物性格期望（跨阶段时触发）
 * data: { pet_id: string, prompt: string }
 */
async function setPersonalityPrompt(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  if (!data.prompt || !data.prompt.trim()) {
    return { code: -1, message: "性格期望不能为空" };
  }

  var prompt = data.prompt.trim().slice(0, 100); // 最多100字

  var res = await safeUpdate("pets", { _id: data.pet_id, _openid: openid }, {
    personality_prompt: prompt,
    updated_at: Date.now(),
  });

  if (res && res.updated) {
    return { success: true, personality_prompt: prompt, message: '性格期望已记录：' + prompt };
  }
  return { code: -1, message: "设置失败" };
}

/**
 * 更新宠物AI聊天上下文（预留接口）
 * data: { pet_id: string, personality_prompt: string }
 */
async function updateChatContext(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  var pets = await safeQuery("pets", { _id: data.pet_id, _openid: openid });
  if (!pets || !pets[0]) return { code: -1, message: "宠物不存在" };

  var updates = { updated_at: Date.now() };
  // 【V8.3修复】chat_context可能为null（旧数据），点号写法会崩溃
  var existingContext = pets[0].chat_context || {};
  if (data.personality_prompt !== undefined) {
    updates.chat_context = Object.assign({}, existingContext, { personality_prompt: data.personality_prompt });
  }

  await safeUpdate("pets", { _id: data.pet_id }, updates);
  return { success: true, message: '聊天上下文已更新' };
}

/**
 * 获取用户成长池信息
 */
async function getGrowthPool(openid) {
  const { data } = await db.collection('user_growth_pool').where({ _openid: openid }).limit(2).get();
  if (data.length > 1) return { code: -1, message: '成长池记录重复，请联系管理员' };
  const pool = data[0];
  return {
    success: true,
    growth_pool: pool?.growth_pool || 0,
    total_earned: pool?.total_earned || 0,
    starter_claimed: !!(pool?.starter_claimed || pool?.starter_claimed_at),
  };
}

/**
 * 【泉水系统】从经验池分配经验到指定宠物
 * data: { pet_id: string, amount: number, request_id?: string }
 * amount=0 表示使用可分配余额，未孵化的蛋只接收孵化所需成长。
 *
 * 池子扣减、宠物成长和回执在同一事务提交。
 */
async function allocatePool(openid, data, accountId) {
  const requested = typeof data.amount === 'string' && /^\d+$/.test(data.amount) ? Number(data.amount) : data.amount;
  if (typeof data.pet_id !== 'string' || !data.pet_id) return { code: -1, message: '请选择目标宠物' };
  if (!Number.isSafeInteger(requested) || requested < 0) return { code: -1, message: '请输入有效的灌注数量' };
  const requestId = data.request_id;
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w:.-]{1,128}$/.test(requestId))) {
    return { code: -1, message: '灌注凭据不正确' };
  }

  const context = await rewardContext(openid, accountId);
  if (context.code === -1) return context;
  const receiptId = requestId && stableId('fountain_', accountId ? [openid, accountId, requestId] : [openid, requestId]);
  const settlement = await context.database.runTransaction(async tx => {
    if (receiptId) {
      const { data: receipt } = await tx.collection('growth_logs').doc(receiptId).get();
      if (receipt) {
        if (receipt._openid !== openid || receipt.pet_id !== data.pet_id || receipt.requested_growth !== requested) {
          return { code: -1, message: '此灌注凭据已用于其他操作' };
        }
        return { result: receipt.allocation_result };
      }
    }
    const { data: pet } = await tx.collection('pets').doc(data.pet_id).get();
    if (pet?._openid !== openid || pet.deleted_at) return { code: -1, message: '目标宠物不存在或已放行' };
    const pool = await readRewardPool(tx, context, openid);
    const balance = Number(pool?.growth_pool) || 0;
    if (balance <= 0) return { code: -1, message: '经验池是空的，先去签到或完成任务吧' };

    const now = Date.now();
    const oldGrowth = Number(pet.growth_value) || 0;
    const isEgg = pet.is_hatched !== true;
    const available = Math.min(requested || balance, balance);
    const amount = isEgg ? Math.min(available, Math.max(0, 100 - oldGrowth)) : available;
    const newGrowth = oldGrowth + amount;
    const previous = getGrowthStage(oldGrowth);
    const next = getGrowthStage(newGrowth);
    const patch = { growth_value: newGrowth, updated_at: now };
    const result = { success: true, allocated: amount, pool_remaining: balance - amount, pet_new_growth: newGrowth,
      stage: next.key, stage_name: next.name };
    let source, event;
    if (isEgg && newGrowth >= 100) {
      const hatch = performPetHatch(pet.egg_type || 'forest_egg');
      Object.assign(patch, hatch.updateFields, { growth_value: newGrowth, stage: next.key,
        attributes: _.set(hatch.updateFields.attributes),
        chat_context: _.set({ ...hatch.updateFields.chat_context, stage: next.key }) });
      const tags = hatch.buildDisplayTags();
      const name = (hatch.rarityText[hatch.result.rarity] || '') + hatch.result.name;
      Object.assign(result, { hatched: true, pet: { id: pet._id, ...hatch.result }, need_personality: true,
        message: '灌注 ' + amount + ' 点，孵化出【' + name + tags.colorTag + tags.talentTag + '】' });
      if (available > amount) result.message += '，超出部分已留在泉水';
      source = 'hatch_pool';
    } else if (!isEgg && previous.key !== next.key) {
      const bonus = generateStageUpBonus();
      const attributes = {};
      for (const key of Object.keys(bonus)) attributes[key] = (Number(pet.attributes?.[key]) || 0) + bonus[key];
      const records = Array.isArray(pet.growth_records) ? pet.growth_records : [];
      Object.assign(patch, { stage: next.key, attributes: _.set(attributes),
        growth_records: records.concat({ time: now, stage: next.key, message: '💧 泉水灌注成长为【' + next.name + '】' }) });
      const attrText = Object.entries({ vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' })
        .map(([key, label]) => label + '+' + bonus[key]).join(' ');
      Object.assign(result, { stage_up: { from: previous.key, to: next.key, name: next.name, attrBonus: bonus },
        attr_bonus: bonus, need_personality_prompt: true,
        message: '💧 灌注 +' + amount + '，升级为【' + next.name + '】！' + attrText });
      source = 'fountain_allocate';
      if (next.key === 'ADULT' || next.key === 'PERFECT') event = 'reach_' + next.key.toLowerCase();
    } else {
      if (isEgg) patch.egg_stage = getEggStage(newGrowth);
      result.message = '💧 灌入 +' + amount + ' 点成长';
    }

    await updateTransactionRow(tx, 'pets', pet._id, patch);
    await creditRewardPool(tx, context, pool, openid, -amount, 0, now);
    if (source || receiptId) {
      await tx.collection('growth_logs').add({ data: {
        ...(receiptId && { _id: receiptId, requested_growth: requested, allocation_result: result }),
        _openid: openid, pet_id: pet._id, source: source || 'fountain_allocate', xp_change: 0,
        reason: result.message, created_at: now,
      } });
    }
    return { result, growth: { pet, event } };
  });
  await notifyGrowthEvent(openid, settlement.growth);
  return settlement.result || settlement;
}

/**
 * 【刷新蛋类型】更换当前未孵化蛋的类型
 * data: { pet_id: string, target_egg_type: string }  (不传target_egg_type则随机)
 *
 * 规则：
 *   - 只能刷新未孵化的蛋
 *   - 保留 growth_value 不变
 *   - 可指定目标类型，或随机切换到其他类型
 */
async function refreshEgg(openid, data) {
  if (typeof data.pet_id !== 'string' || !data.pet_id) return { code: -1, message: '缺少宠物ID' };
  const allEggTypes = Object.keys(EGG_TYPES);
  const requested = allEggTypes.includes(data.target_egg_type) ? data.target_egg_type : null;
  const roll = requested ? 0 : Math.random();
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.pet_id).get();
    if (pet?._openid !== openid) return { code: -1, message: '宠物不存在' };
    if (pet.deleted_at) return { code: -1, message: '该宠物已释放' };
    if (pet.is_hatched === true) return { code: -1, message: '已孵化的宠物不能更换蛋类型哦' };

    const currentType = pet.egg_type || 'forest_egg';
    const otherTypes = allEggTypes.filter(type => type !== currentType);
    const newType = requested || otherTypes[Math.floor(roll * otherTypes.length)];
    if (newType === currentType) {
      return { code: -1, message: '当前就是这个类型哦～换一个吧' };
    }
    const eggInfo = EGG_TYPES[newType];
    await updateTransactionRow(tx, 'pets', pet._id, { egg_type: newType, updated_at: Date.now() });
    return {
      success: true,
      new_egg_type: newType,
      new_egg_name: eggInfo.name,
      new_egg_color: eggInfo.color,
      new_egg_emoji: eggInfo.emoji,
      message: '🔄 已更换为【' + eggInfo.name + '】！',
    };
  });
}

/**
 * 【新手礼包】领取800点初始经验
 * 每个用户只能领取一次
 */
async function claimStarterXp(openid) {
  const context = await rewardContext(openid);
  if (context.code === -1) return context;
  const bonusAmount = 800;
  return context.database.runTransaction(async tx => {
    const pool = await readRewardPool(tx, context, openid);
    const balance = pool?.growth_pool || 0;
    if (pool?.starter_claimed || pool?.starter_claimed_at) {
      return { success: true, already_claimed: true, claimed_amount: 0,
        total_pool: balance, message: '新手礼包已经领过了' };
    }
    const now = Date.now();
    await creditRewardPool(tx, context, pool, openid, bonusAmount, bonusAmount, now, {
      starter_claimed: true, starter_claimed_at: now,
    });
    await tx.collection('growth_logs').add({ data: {
      _openid: openid, xp_change: 0, source: 'starter_bonus', created_at: now,
      reason: '🎁 新手礼包：获得 ' + bonusAmount + ' 点初始经验',
    } });
    return { success: true, claimed_amount: bonusAmount, total_pool: balance + bonusAmount,
      message: '🎁 领取成功！+' + bonusAmount + ' 点经验已存入泉水' };
  });
}

// ===== 儿童节礼包 + 背包云端持久化（V10.4）=====

/** 儿童节礼包：每人一次，送各20个道具 */
async function claimChildrenDayGift(openid) {
  const context = await rewardContext(openid);
  if (context.code === -1) return context;
  const giftBackpack = [
    { name: '普通饲料', count: 20 },
    { name: '高级饲料', count: 20 },
    { name: '成长药水', count: 20 },
    { name: '补签卡', count: 20 },
  ];

  return context.database.runTransaction(async tx => {
    const pool = await readRewardPool(tx, context, openid);
    if (pool?.children_day_claimed || pool?.children_day_claimed_at) {
      return { success: true, already_claimed: true, message: '儿童节礼包已经领过了' };
    }
    const backpack = [...storedBackpack(pool)];
    for (const gift of giftBackpack) {
      const index = backpack.findIndex(item => item.name === gift.name);
      if (index === -1) backpack.push(gift);
      else backpack[index] = { ...backpack[index], count: (Number(backpack[index].count) || 0) + gift.count };
    }
    const now = Date.now();
    await creditRewardPool(tx, context, pool, openid, 0, 0, now, {
      backpack, children_day_claimed: true, children_day_claimed_at: now,
    });
    return { success: true, backpack: giftBackpack, message: '🎈 儿童节快乐！道具x20 已放入背包' };
  });
}

/** 获取当前背包（从云端同步） */
async function getBackpack(openid, options) {
  const { data } = await db.collection('user_growth_pool').where({ _openid: openid }).limit(2).get();
  if (data.length > 1) return { code: -1, message: '成长池记录重复，请联系管理员' };
  const pool = data[0];
  const backpack = pool?.backpack ?? null;
  return { code: 0, data: options?.includeGiftStatus === true
    ? { backpack, children_day_claimed: !!(pool?.children_day_claimed || pool?.children_day_claimed_at) }
    : backpack };
}

function collectedPetSpecies(pets) {
  const owned = new Set(pets.map(pet => pet.species));
  return SPECIES_LIST.filter(species => owned.has(species));
}

/** 保留旧入口和返回格式，图鉴从当前与已放行的宠物记录读取。 */
async function syncEverOwnedSpecies(openid) {
  const pets = await readAll('pets', { _openid: openid });
  return { success: true, all_ever_owned_species: collectedPetSpecies(pets), added: 0 };
}

function storedBackpack(pool) {
  return Array.isArray(pool?.backpack) ? pool.backpack : [
    { name: '普通饲料', count: 3 }, { name: '高级饲料', count: 1 },
    { name: '成长药水', count: 0 }, { name: '补签卡', count: 1 },
  ];
}

function backpackAfterUse(pool, itemName) {
  const inventory = storedBackpack(pool);
  const item = inventory.find(entry => entry.name === itemName);
  if (!item || !Number.isInteger(item.count) || item.count <= 0) return null;
  return inventory.map(entry => entry === item ? { ...entry, count: entry.count - 1 } : entry);
}

function backpackPetPatch(pet) {
  return { experience: pet.experience, growth_value: pet.growth_value, stage: pet.stage, attributes: pet.attributes };
}

async function useBackpackItem(openid, data, accountId) {
  const name = data.itemName;
  if (name === '补签卡') return taskCheckin(openid, { task_id: data.task_id }, { makeup: true, accountId });
  if (!['普通饲料', '高级饲料', '成长药水'].includes(name) ||
      typeof data.pet_id !== 'string' || !data.pet_id ||
      typeof data.request_id !== 'string' || !/^[\w:.-]{1,128}$/.test(data.request_id)) {
    return { code: -1, message: '道具、宠物或使用凭据不正确' };
  }
  const context = await rewardContext(openid, accountId);
  if (context.code === -1) return context;
  const receiptId = stableId('item_', accountId ? [openid, accountId, data.request_id] : [openid, data.request_id]);
  // Keep the same roll if the SDK re-executes the transaction.
  const xp = name === '普通饲料' ? 10 : name === '高级饲料' ? 30 : Math.random() < 0.9 ? 30 + Math.floor(Math.random() * 21) : 0;
  const attributes = ['vitality', 'wisdom', 'luck', 'resonance'];
  const attr = xp ? '' : attributes[Math.floor(Math.random() * attributes.length)];
  return context.database.runTransaction(async tx => {
    const receipt = (await tx.collection('growth_logs').doc(receiptId).get()).data;
    const pet = (await tx.collection('pets').doc(data.pet_id).get()).data;
    const pool = await readRewardPool(tx, context, openid);
    if (receipt) {
      if (receipt._openid !== openid || receipt.item_name !== name || receipt.pet_id !== data.pet_id) {
        return { code: -1, message: '此道具使用凭据已用于其他操作' };
      }
      return { success: true, already_used: true, backpack: pool?.backpack,
        pet: pet?._openid === openid && !pet.deleted_at ? backpackPetPatch(pet) : null,
        xp_added: receipt.xp_change, attribute: receipt.attribute };
    }
    if (pet?._openid !== openid || pet.deleted_at) return { code: -1, message: '宠物不存在' };
    const backpack = backpackAfterUse(pool, name);
    if (!backpack) return { code: -1, message: '物品数量不足' };
    const now = Date.now();
    const experience = (Number(pet.experience) || 0) + xp;
    const growthValue = (Number(pet.growth_value) || 0) + xp;
    const stage = pet.is_hatched === true ? getGrowthStage(growthValue).key : 'EGG';
    const nextAttributes = attr ? { ...(pet.attributes || {}), [attr]: (Number(pet.attributes?.[attr]) || 0) + 1 } : null;
    const patch = attr ? { attributes: _.set(nextAttributes) } :
      { experience, growth_value: growthValue, stage };
    await updateTransactionRow(tx, 'pets', pet._id, { ...patch, updated_at: now });
    await creditRewardPool(tx, context, pool, openid, 0, 0, now, { backpack });
    await tx.collection('growth_logs').add({ data: {
      _id: receiptId, _openid: openid, source: 'item_use', item_name: name, pet_id: pet._id,
      xp_change: xp, attribute: attr, reason: '使用了【' + name + '】', created_at: now,
    } });
    return { success: true, backpack,
      pet: backpackPetPatch({ ...pet, ...patch, ...(attr ? { attributes: nextAttributes } : {}) }),
      xp_added: xp, attribute: attr };
  });
}

async function settleRewardOnce(operation, openid, data, accountId) {
  if (typeof data.request_id !== 'string' || !/^[\w:.-]{1,128}$/.test(data.request_id)) {
    return { rejected: true, message: '操作凭据不正确' };
  }
  const result = await operation(openid, data, accountId);
  return result.code === -1 ? { rejected: true, message: result.message } : result;
}

/** 宠物互动（V3：含反馈文案 + bond增加 + mood变化） */
async function petInteract(openid, data) {
  if (typeof data.pet_id !== 'string' || !data.pet_id) return { code: -1, message: '缺少宠物ID' };
  const action = data.action === 'feed' || data.action === 'play' ? data.action : 'pet';
  const xp = { feed: 10, play: 15, pet: 5 }[action];
  const bondAdd = { feed: 2, play: 4, pet: 3 }[action];
  const actionName = { feed: '喂食', play: '玩耍', pet: '抚摸' }[action];
  const moodPool = ['excited', 'happy', 'happy', 'normal'];
  const mood = moodPool[Math.floor(Math.random() * moodPool.length)];
  const moodMessage = pickMoodMessage(mood);
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.pet_id).get();
    if (pet?._openid !== openid || pet.deleted_at || pet.is_hatched !== true) {
      return { code: -1, message: '宠物不存在或未孵化' };
    }

    const previousXp = Number(pet.experience) || 0;
    const experience = previousXp + xp;
    const previousBond = Number(pet.bond) || 0;
    const bond = Math.min(1000, previousBond + bondAdd);
    const stage = getHatchedGrowthStage(pet).key;
    const threshold = stage === 'ADULT' || stage === 'PERFECT' ? 9999 : 300;
    const levelUp = previousXp < threshold && experience >= threshold;
    const level = (Number(pet.level) || 1) + Number(levelUp);
    const feedback = getInteractionFeedback(action, pet.species);
    const now = Date.now();

    await updateTransactionRow(tx, 'pets', pet._id, {
      experience, level, stage, bond, mood, mood_message: moodMessage, updated_at: now,
    });
    await tx.collection('growth_logs').add({ data: {
      _openid: openid, pet_id: pet._id, xp_change: xp, reason: actionName + ' ' + feedback,
      source: 'interact_' + action, created_at: now,
    } });
    return {
      success: true, xp_earned: xp, new_xp: experience, bond_added: Math.max(0, bond - previousBond),
      new_bond: bond, bond_level: getBondLevel(bond), feedback, mood, mood_message: moodMessage,
      level_up: levelUp, new_level: level, stage_changed: stage !== pet.stage, new_stage: stage,
    };
  });
}

async function updatePet(openid, data) {
  if (!data.id || typeof data.name !== 'string' || !data.name.trim()) {
    return { code: -1, message: '请填写有效的宠物名称' };
  }
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.id).get();
    if (pet?._openid !== openid || pet.deleted_at) return { code: -1, message: '宠物不存在' };
    await updateTransactionRow(tx, 'pets', data.id, { name: data.name.trim().slice(0, 30), updated_at: Date.now() });
    return { success: true };
  });
}

/** 觉醒宠物 */
async function awakenPet(openid, data) {
  if (typeof data.pet_id !== 'string' || !data.pet_id) return { code: -1, message: '缺少宠物ID' };
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.pet_id).get();
    if (pet?._openid !== openid || pet.deleted_at || pet.is_hatched !== true) return { code: -1, message: '宠物不存在或未孵化' };
    if (pet.awakened) return { success: true, already_awakened: true, awakened_name: pet.name, message: '已经觉醒过了' };
    if (!['ADULT', 'PERFECT'].includes(getHatchedGrowthStage(pet).key)) {
      return { code: -1, message: '达到成年或完美形态后才能觉醒' };
    }
    const now = Date.now();
    const awakenedName = (AWAKEN_PREFIX[pet.species] || '觉醒') + pet.name;
    await updateTransactionRow(tx, 'pets', pet._id, { awakened: true, name: awakenedName, updated_at: now });
    await tx.collection('growth_logs').add({ data: {
      _openid: openid, pet_id: pet._id, xp_change: 0,
      reason: `✨ 【${pet.name}】觉醒了！进化为【${awakenedName}】`,
      source: 'awaken', created_at: now,
    } });
    return { success: true, awakened_name: awakenedName, message: `${pet.name} 觉醒成为了 ${awakenedName}！` };
  });
}

/** 释放/删除宠物（软删除，保留历史记录） */
async function deletePet(openid, data) {
  if (typeof data.pet_id !== 'string' || !data.pet_id) return { code: -1, message: '缺少宠物ID' };
  const database = cloud.database({ throwOnNotFound: false });
  const rarityText = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.pet_id).get();
    if (pet?._openid !== openid) return { code: -1, message: '宠物不存在' };
    const message = `已放行【${pet.name}】`;
    if (pet.deleted_at) return { success: true, already_released: true, message };
    const now = Date.now();
    await updateTransactionRow(tx, 'pets', pet._id, { deleted_at: now, is_hatched: false, updated_at: now });
    await tx.collection('growth_logs').add({ data: {
      _openid: openid, xp_change: 0, source: 'release', created_at: now,
      reason: `👋 放行了【${rarityText[pet.rarity] || ''}${pet.name}】，它回到了大自然`,
    } });
    return { success: true, message };
  });
}

/** 宠物图鉴：获取全部宠物（含已释放的） */
async function petCollection(openid) {
  const allPets = await readAll('pets', { _openid: openid });

  // 当前宠物（未删除）
  const current = allPets.filter(p => !p.deleted_at).map(p => ({
    id: p._id,
    name: p.name,
    species: p.species || '',
    rarity: p.rarity || 'common',
    stage: p.stage,
    level: p.level || 1,
    experience: p.experience || 0,
    bond: p.bond || 0,
    mood: p.mood || 'normal',
    awakened: p.awakened === true,
    is_hatched: p.is_hatched === true,
    hatch_progress: p.hatch_progress || 0,
    egg_stage: p.egg_stage || 'egg',
    attribute_type: p.attribute_type || '',
    attributes: p.attributes || null,
    personality: p.personality || '',       // V4: 字符串
    titles: p.titles || [],                // V4: 称号列表
    created_at: p.created_at || 0,
    updated_at: p.updated_at || 0,
    growth_records: p.growth_records || [],
  }));

  // 已释放宠物（有 deleted_at）
  const released = allPets.filter(p => !!p.deleted_at)
    .sort((a, b) => (b.deleted_at || 0) - (a.deleted_at || 0))
    .map(p => ({
      id: p._id,
      name: p.name,
      species: p.species || '',
      rarity: p.rarity || 'common',
      stage: p.stage,
      level: Math.max(p.level || 1, (p._level_history && p._level_history.max) || p.level || 1),
      bond: p.bond || 0,
      awakened: p.awakened === true,
      attribute_type: p.attribute_type || '',
      personality: p.personality || '',
      released_at: p.deleted_at || 0,
      owned_days: p.deleted_at ? Math.max(1, Math.floor((p.deleted_at - (p.created_at || p.deleted_at)) / 86400000)) : 0,
      created_at: p.created_at || 0,
    }));

  // 统计数据
  const totalEverOwned = allPets.length;
  const currentCount = current.length;
  const releasedCount = released.length;
  const awakenedCount = allPets.filter(p => p.awakened === true).length;

  // V6: 物种收集数据（图鉴Dex）
  const allSpeciesList = SPECIES_LIST;  // V6: 使用15种物种
  const collectedSpecies = collectedPetSpecies(allPets);
  const uncollectedSpecies = allSpeciesList.filter(species => !collectedSpecies.includes(species));

  // 最稀有宠物
  const rarityOrder = { legendary: 5, epic: 4, rare: 3, common: 2, unknown: 1 };
  const sortedByRarity = [...allPets].sort((a, b) =>
    (rarityOrder[b.rarity] || 1) - (rarityOrder[a.rarity] || 1) ||
    ((b.level || 0) - (a.level || 0))
  );
  const rarest = sortedByRarity[0];

  return {
    success: true,
    data: {
      current,
      released,
      stats: {
        total_ever_owned: totalEverOwned,
        current_count: currentCount,
        max_pets: 3,
        released_count: releasedCount,
        awakened_count: awakenedCount,
        rarest_pet: rarest ? {
          name: rarest.name,
          species: rarest.species || '',
          rarity: rarest.rarity || 'common',
          level: rarest.level || 1,
          awakened: rarest.awakened === true,
        } : null,
      },
      // V4: 物种图鉴收集数据
      dex: {
        total_species: allSpeciesList.length,
        collected_count: collectedSpecies.length,
        uncollected_count: uncollectedSpecies.length,
        percent: Math.round((collectedSpecies.length / allSpeciesList.length) * 100),
        owned_species: collectedSpecies,
        collected_species: collectedSpecies,
        uncollected_species: uncollectedSpecies,
        is_complete: collectedSpecies.length >= allSpeciesList.length,
      },
    },
  };
}

// 宠物详情（V3：含全部字段 + 成长记录）
async function petDetail(openid, petId) {
  if (typeof petId !== 'string' || !petId) return { code: -1, message: '宠物不存在' };
  const { data: pets } = await db.collection('pets').where({ _id: petId, _openid: openid }).limit(1).get();
  const pet = pets[0];
  if (!pet || pet.deleted_at) return { code: -1, message: '宠物不存在' };

  const stageXpMap = { EGG: 100, BABY: 300, YOUTH: 600, ADULT: 9999, PERFECT: 9999 };
  const stageMaxXp = stageXpMap[pet.stage] || 300;
  const bondLv = getBondLevel(pet.bond || 0);

  // 计算陪伴天数
  const hatchTime = pet.hatch_time || pet.created_at || Date.now();
  const companionDays = Math.max(0, Math.floor((Date.now() - hatchTime) / 86400000));

  // 成长记录
  const sortedLogs = (await readRecentGrowthLogs(openid, 50))
    .map(l => ({
      id: l._id,
      xp_change: l.xp_change,
      reason: l.reason,
      source: l.source,
      created_at: l.created_at,
    }));

  return {
    success: true,
    data: {
      // 基本信息
      pet_name: pet.name,
      species: pet.species || '',
      attribute_type: pet.attribute_type || '',
      rarity: pet.rarity || 'common',
      stage: pet.stage,
      level: pet.level || 1,
      xp: pet.experience || 0,
      next_level_xp: stageMaxXp,
      // 蛋相关
      hatch_progress: pet.hatch_progress || 0,
      egg_stage: pet.egg_stage || 'egg',
      is_hatched: pet.is_hatched === true,
      // V3 新字段
      attributes: pet.attributes || null,
      bond: pet.bond || 0,
      bond_max: 1000,
      bond_level: bondLv,
      mood: pet.mood || 'normal',
      mood_message: pet.mood_message || '',
      awakened: pet.awakened || false,
      personality_tags: pet.personality || [],
      hatch_time: hatchTime,
      companion_days: companionDays,
      created_at: pet.created_at || hatchTime,
      growth_logs: sortedLogs,
      // 成长记录（跨阶段里程碑）
      growth_records: pet.growth_records || [],
      // AI聊天上下文
      chat_context: pet.chat_context || null,
    },
  };
}

// ====== 成就 ======
// ====== 成就 ======
// 成就检测规则：根据用户当前状态自动检查并记录新完成的成就
async function checkAndRecordAchievements(openid, user) {
  const existing = await safeQuery("achievements", { _openid: openid });
  var recordedNames = {};
  for (var i = 0; i < existing.length; i++) {
    recordedNames[existing[i].name] = true;
  }

  // 并行查询各项数据用于判断成就条件
  var checkins = await safeQuery("checkins", { _openid: openid });
  var tasks = await safeQuery("tasks", { _openid: openid, completed: true });
  var pets = await safeQuery("pets", { _openid: openid });

  var streakDays = (user && user.streak_days) || 0;
  var hasCheckedIn = checkins.length > 0;
  var totalCompletedTasks = tasks.length;
  var petCount = 0;
  for (var j = 0; j < pets.length; j++) {
    if (pets[j].is_hatched !== false) petCount++;
  }

  // 成就检测规则
  var rules = [
    { name: "初次打卡",   condition: hasCheckedIn },
    { name: "连续7天",    condition: streakDays >= 7 },
    { name: "目标达人",   condition: totalCompletedTasks >= 1 },
    { name: "宠物伙伴",   condition: petCount >= 1 },
    { name: "坚持不懈",   condition: streakDays >= 30 },
  ];

  var now = Date.now();
  var recorded = [];
  for (var k = 0; k < rules.length; k++) {
    var rule = rules[k];
    if (rule.condition && !recordedNames[rule.name]) {
      await safeAdd("achievements", {
        _openid: openid,
        name: rule.name,
        unlocked_at: now,
        created_at: now
      });
      recordedNames[rule.name] = true;
      recorded.push(rule.name);
    }
  }

  if (recorded.length > 0) {
    console.log("[成就] 新解锁: " + recorded.join(", ") + " | openid=" + openid);
  }
  return recorded;
}

async function listAchievements(openid) {
  // 先获取用户数据用于判断成就条件
  var userArr = await safeQuery("user", { _openid: openid });
  var user = userArr[0] || {};

  // 检测并记录新成就
  await checkAndRecordAchievements(openid, user);

  // 返回所有已解锁成就
  var data = await safeQuery("achievements", { _openid: openid });
  return { success: true, data: data || [] };
}

// ====== 情绪 ======
const emotionTime = mood => Number(mood?.updated_at || mood?.created_at) || 0;
const hasMoodLabel = mood => typeof mood.mood_label === 'string' && mood.mood_label.trim();

function preferLatestEmotion(previous, candidate) {
  if (!previous) return candidate;
  const order = emotionTime(candidate) - emotionTime(previous);
  return order > 0 || (order === 0 && (candidate._id || '') > (previous._id || '')) ? candidate : previous;
}

function emotionSummary(mood) {
  return { date: mood.date, mood_index: mood.mood_index, mood_label: mood.mood_label };
}

async function recordEmotion(openid, data) {
  const index = typeof data.mood_index === 'string' && /^[0-4]$/.test(data.mood_index)
    ? Number(data.mood_index) : data.mood_index;
  if (!Number.isInteger(index) || index < 0 || index > 4 ||
      (data.mood_label !== undefined && (typeof data.mood_label !== 'string' || data.mood_label.length > 24))) {
    return { code: -1, message: '请选择有效的心情' };
  }
  if (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 140)) {
    return { code: -1, message: '心情备注最多 140 字' };
  }
  const today = todayStr();
  const rows = await readAll('emotions', { _openid: openid, date: today });
  const latest = rows.reduce(preferLatestEmotion, null);
  const id = latest?._id || stableId('mood_', [openid, today]);
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const emotions = tx.collection('emotions');
    const { data: current } = await emotions.doc(id).get();
    if ((current && (current._openid !== openid || current.date !== today)) || (!current && latest)) {
      throw new Error('心情记录已变更，请刷新后重试');
    }
    if (todayStr() !== today) throw new Error('日期已更新，请重新记录');
    const now = Date.now();
    const note = data.note ?? current?.note ?? '';
    const fields = {
      mood_index: index,
      mood_label: data.mood_label?.trim() || current?.mood_label || '',
      updated_at: Math.max(now, emotionTime(current) + 1),
      ...(data.note === undefined ? {} : { note }),
    };
    if (current) await updateTransactionRow(tx, 'emotions', id, fields);
    else await emotions.add({ data: { _id: id, _openid: openid, date: today, created_at: now, ...fields } });
    return { success: true, mood: { ...emotionSummary({ date: today, ...fields }), note } };
  });
}

// ====== 成长日志 ======
async function readRecentGrowthLogs(openid, limit, source) {
  const filter = { _openid: openid, ...(source ? { source } : {}) };
  const { data } = await db.collection('growth_logs').where(filter)
    .orderBy('created_at', 'desc').orderBy('_id', 'desc').limit(limit).get();
  return data;
}

async function listGrowthLogs(openid, params) {
  if (params.source !== undefined && (typeof params.source !== 'string' || params.source.length > 64)) {
    return { code: -1, message: '成长记录类型无效' };
  }
  const requested = Number(params.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(100, requested) : 50;
  return { success: true, data: await readRecentGrowthLogs(openid, limit, params.source) };
}

async function getGrowthReport(openid) {
  const today = todayStr();
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay() || 7;
  const monday = taskRules.addDays(today, 1 - weekday);
  const dates = Array.from({ length: 7 }, (_, index) => taskRules.addDays(monday, index));
  const elapsed = dates.slice(0, weekday);
  const start = Date.parse(monday + 'T00:00:00+08:00');
  const cutoff = Date.now();
  const owner = { _openid: openid };
  const [tasks, goals, logs, users, moods] = await Promise.all([
    queryTasks({ ...owner, date: _.in(elapsed) }),
    readAll('goals', owner),
    readAll('growth_logs', { ...owner, created_at: _.gte(start).and(_.lte(cutoff)) }),
    db.collection('users').where(owner).limit(1).get(),
    readAll('emotions', { ...owner, date: _.in(elapsed) }),
  ]);
  const completed = tasks.filter(task => task.completed === true);
  const counts = new Map();
  for (const task of completed) if (task.goal_id) counts.set(task.goal_id, (counts.get(task.goal_id) || 0) + 1);
  const best = goals.filter(goal => counts.has(goal._id))
    .sort((a, b) => counts.get(b._id) - counts.get(a._id) || a._id.localeCompare(b._id))[0];
  const latestMood = new Map();
  for (const mood of moods) {
    if (hasMoodLabel(mood)) latestMood.set(mood.date, preferLatestEmotion(latestMood.get(mood.date), mood));
  }
  return { code: 0, data: {
    weekLabel: monday + ' ~ ' + dates[6], completedTasks: completed.length, totalTasks: tasks.length,
    completionRate: tasks.length ? Math.round(completed.length / tasks.length * 100) : null,
    xpEarned: logs.length ? logs.reduce((sum, log) => sum + (Number(log.xp_change) || 0), 0) : null,
    streakDays: users.data[0]?.streak_days ?? null,
    topGoal: best ? { title: best.title, emoji: best.emoji || '🎯', count: counts.get(best._id) } : null,
    moods: dates.map((date, index) => ({ date, day: '周' + '一二三四五六日'[index],
      label: latestMood.get(date)?.mood_label || (date > today ? '未到' : '未记录') })),
  } };
}

// ====== API Key ======
async function saveApiKey(openid, data) {
  const { provider, expected_version: expectedVersion } = data;
  if (!openid || typeof provider !== 'string' || !Object.hasOwn(AI_PROVIDER_DEFAULTS, provider)) {
    return { code: -1, message: '身份或供应商无效' };
  }
  const clearing = data.clear === true;
  const key = !clearing && typeof data.api_key === 'string' ? data.api_key.trim() : '';
  if (key && (key.length < 10 || /[\s*]/.test(key))) return { code: -1, message: 'API Key 无效，请勿填写遮蔽值' };
  let config;
  try {
    if (!clearing) config = normalizeAiConfig({ provider, base_url: data.base_url, model: data.model });
  } catch {
    return { code: -1, message: '请填写有效的 HTTPS 接口地址和模型名称' };
  }

  const changed = { code: -1, message: '服务商配置已变化，请重新读取后再操作' };
  const database = cloud.database({ throwOnNotFound: false });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: users } = await database.collection('users').where({ _openid: openid })
        .field({ _id: true, ai_config_revision: true }).limit(2).get();
      if (users.length !== 1) return { code: -1, message: '账号资料已变化，请重新登录' };
      const owner = users[0];
      const rows = await queryApiKeys(openid, provider);
      const existing = rows.find(row => row.api_key);
      const version = existing ? apiConfigVersion(existing) : null;
      if (expectedVersion !== undefined && expectedVersion !== version) return changed;
      if (clearing && !rows.length) return { success: true, cleared: true };
      if (clearing && rows.length > 30) return { code: -1, message: '旧配置重复过多，请联系管理员核对后清理' };
      if (!clearing && !existing && !key) return { code: -1, message: '请填写 API Key' };
      if (!clearing && !key && !canReuseApiKey(existing, config.base_url)) {
        return { code: -1, message: '接口站点已变化，请重新填写该站点的 API Key' };
      }

      const result = await database.runTransaction(async tx => {
        const { data: currentOwner } = await tx.collection('users').doc(owner._id).get();
        if (currentOwner?._openid !== openid || currentOwner.status === 'banned') {
          return { code: -1, message: '账号资料已变化，请重新登录' };
        }
        if (currentOwner.ai_config_revision !== owner.ai_config_revision) return null;
        const collection = tx.collection('api_keys');
        const timestamp = Math.max(Date.now(), (Number(currentOwner.ai_config_updated_at) || 0) + 1,
          (Number((existing || rows[0])?.updated_at) || 0) + 1);
        await updateTransactionRow(tx, 'users', owner._id, { ai_config_revision: _.inc(1), ai_config_updated_at: timestamp });
        if (clearing) {
          for (const row of rows) {
            const document = collection.doc(row._id);
            const { data: current } = await document.get();
            if (current?._openid !== openid || current.provider !== provider || apiConfigVersion(current) !== apiConfigVersion(row)) {
              throw new Error('配置记录已变化');
            }
            if ((await document.remove()).stats?.removed !== 1) throw new Error('配置未删除');
          }
          return { success: true, cleared: true };
        }
        const target = existing || rows[0];
        const fields = { base_url: config.base_url, model: config.model, updated_at: timestamp, ...(key ? { api_key: key } : {}) };
        if (target) {
          const { data: current } = await collection.doc(target._id).get();
          if (current?._openid !== openid || current.provider !== provider || apiConfigVersion(current) !== apiConfigVersion(target)) {
            throw new Error('配置记录已变化');
          }
          await updateTransactionRow(tx, 'api_keys', target._id, fields);
          return { success: true, version: apiConfigVersion({ ...current, ...fields }) };
        }
        const created = { _openid: openid, provider, created_at: timestamp, ...fields };
        const { _id } = await collection.add({ data: created });
        return { success: true, version: apiConfigVersion({ ...created, _id }) };
      });
      if (result) return result;
    }
    return changed;
  } catch {
    // SDK failures can carry credential-bearing write details.
    return { code: -1, message: '服务商配置操作未确认，请重新读取后再试' };
  }
}

function apiConfigVersion(row) {
  return stableId('cfg_', [row._id, row.created_at || 0, row.updated_at || 0]);
}

async function listApiKeys(openid) {
  const data = await queryApiKeys(openid);
  return { success: true, data: (data || []).map(k => ({
    provider: k.provider,
    api_key_masked: k.api_key ? '****' + k.api_key.slice(-4) : '',
    base_url: k.base_url || '',
    model: k.model || '',
    version: apiConfigVersion(k),
    has_key: !!(k.api_key), updated_at: k.updated_at || 0, created_at: k.created_at || 0
  })) };
}

// ====== 反馈 ======
async function submitFeedback(openid, data) {
  if (!data.type || !data.title || !data.description) return { code: -1, message: "缺少反馈信息" };
  await safeAdd("feedbacks", {
    _openid: openid, type: data.type, title: data.title,
    description: data.description, contact: data.contact || "",
    created_at: Date.now(),
  });
  return { success: true };
}

// ====== 管理员接口 ======

// V8.4：管理员权限校验（只可信调用者身份）
// 仅根据服务端传入的 openid 查询其自身 users 记录的 role 字段判定；
// 不再硬编码 username 兜底，避免无关调用者因数据库中存在管理员用户名即被放行。
async function findAdminId(openid) {
  if (!openid) return null;
  const { data } = await db.collection('users').where({ _openid: openid, role: 'admin' }).limit(1).get();
  return data[0]?._id || null;
}
async function checkAdmin(openid) { return !!await findAdminId(openid); }

async function readActiveAdmin(tx, openid, adminId) {
  const { data: actor } = await tx.collection('users').doc(adminId).get();
  if (actor?._openid !== openid || actor.role !== 'admin' || actor.status === 'banned' || actor.cleanup_pending) {
    throw new Error('无管理员权限');
  }
  return actor;
}

// Keep the caller's permission valid through commit, including under snapshot isolation.
function pinAdminAccess(tx, adminId) {
  return updateTransactionRow(tx, 'users', adminId, { admin_access_revision: _.inc(1) });
}

// 管理员数据概览（完整版）
async function adminDashboard(openid) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };

  const today = todayStr();

  const [totalGoals, totalPets, totalFeedbacks, completedToday, signinsToday, petRows, feedbackRows, allUsers] = await Promise.all([
    db.collection("goals").where({ status: _.neq("deleted") }).count(),
    db.collection("pets").count(),
    db.collection("feedbacks").count(),
    db.collection("tasks").where({ date: today, completed: true }).count(),
    db.collection("checkins").where({ date: today }).count(),
    db.collection("pets").limit(30).get(),
    db.collection("feedbacks").orderBy('created_at', 'desc').limit(20).get(),
    readAll("users", {}),
  ]);

  const totalPlatformXp = allUsers.reduce((sum, u) => sum + (Number(u.total_xp) || 0), 0);

  // 最近注册用户
  const recentUsers = (allUsers || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 8);

  const allPets = petRows.data.map(p => ({
    id: p._id, name: p.name, stage: p.stage, level: p.level,
    experience: p.experience, status: p.status, _openid: p._openid,
    created_at: p.created_at,
  }));

  // 关联宠物到用户名
  const userMap = {};
  (allUsers || []).forEach(u => { userMap[u._openid || ''] = u; });
  allPets.forEach(p => {
    const owner = userMap[p._openid];
    if (owner) { p.ownerName = owner.nickname || owner.username; p.ownerId = owner._id; }
  });

  return {
    code: 0,
    data: {
      stats: {
        totalUsers: allUsers.length,
        totalGoals: totalGoals.total,
        totalPets: totalPets.total,
        totalFeedbacks: totalFeedbacks.total,
        activeToday: completedToday.total,
        todaySignins: signinsToday.total,
        totalPlatformXp,
      },
      recentUsers: recentUsers.map(u => ({
        id: u._id, nickname: u.nickname, username: u.username, avatar: u.avatar,
        level: u.level || 1, role: u.role || 'user', status: u.status || 'active',
        cleanupReadyAt: u.cleanup_pending?.readyAt || 0,
        cleanupInBatch: !!u.cleanup_pending?.batchId,
        total_xp: u.total_xp || 0, streak_days: u.streak_days || 0,
        created_at: u.created_at,
      })),
      pendingFeedbacks: feedbackRows.data,
      allPets,
    },
  };
}

// 用户列表（分页+搜索）
async function adminListUsers(openid, params) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };

  let query = {};
  const page = (params && params.page) || 1;
  const pageSize = Math.min((params && params.pageSize) || 20, 50);
  const skip = (page - 1) * pageSize;

  // 支持按关键词搜索
  if (params && params.keyword) {
    const kw = params.keyword.trim();
    if (kw) {
      query = _.or([
        { nickname: db.RegExp({ regexp: kw, options: 'i' }) },
        { username: db.RegExp({ regexp: kw, options: 'i' }) },
      ]);
    }
  }

  // 按角色筛选
  if (params && params.role && params.role !== 'all') {
    query.role = params.role;
  }

  const countRes = await db.collection("users").where(query).count();
  const listRes = await db.collection("users")
    .where(query)
    .orderBy("created_at", "desc")
    .skip(skip)
    .limit(pageSize)
    .get();

  return {
    code: 0,
    data: {
      total: countRes.total,
      page,
      list: (listRes.data || []).map(u => ({
        id: u._id, nickname: u.nickname, username: u.username, avatar: u.avatar,
        level: u.level || 1, role: u.role || 'user', status: u.status || 'active',
        total_xp: u.total_xp || 0, streak_days: u.streak_days || 0,
        last_login_at: u.last_login_at, created_at: u.created_at,
      })),
    },
  };
}

async function changeManagedUser(openid, userId, change) {
  const adminId = await findAdminId(openid);
  if (!adminId) return { code: -1, message: '无管理员权限' };
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const actor = await readActiveAdmin(tx, openid, adminId);
    const user = userId === adminId ? actor : (await tx.collection('users').doc(userId).get()).data;
    if (!user) return { code: -1, message: '用户不存在' };
    const { patch, result } = change(user);
    if (patch) {
      if (adminId !== user._id) await pinAdminAccess(tx, adminId);
      await updateTransactionRow(tx, 'users', user._id, { ...patch, updated_at: Date.now() });
    }
    return result;
  });
}

// 设置用户角色
async function adminSetRole(openid, data) {
  if (typeof data.userId !== 'string' || !data.userId) return { code: -1, message: '缺少用户ID' };
  if (!['admin', 'user'].includes(data.role)) return { code: -1, message: '无效角色' };
  return changeManagedUser(openid, data.userId, user => {
    if (data.role === 'user' && user._openid === openid) {
      return { result: { code: -1, message: '不能降级自己的管理员账号' } };
    }
    if (user.cleanup_pending) return { result: { code: -1, message: '请先取消待清理状态' } };
    return {
      patch: user.role === data.role ? null : { role: data.role },
      result: { success: true, role: data.role, message: `已设置为${data.role === 'admin' ? '管理员' : '普通用户'}` },
    };
  });
}

// 设置用户状态（封禁/解封）
async function adminSetUserStatus(openid, data) {
  if (typeof data.userId !== 'string' || !data.userId) return { code: -1, message: "缺少用户ID" };
  if (!['active', 'banned', 'cancelCleanup'].includes(data.status)) return { code: -1, message: "无效状态" };
  return changeManagedUser(openid, data.userId, user => {
    if (data.status === 'cancelCleanup') {
      if (user.cleanup_pending?.batchId) return { result: { code: -1, message: '请在系统工具取消本批清理' } };
      const status = user.cleanup_pending?.priorStatus || user.status || 'active';
      return { patch: user.cleanup_pending ? { status, cleanup_pending: null } : null,
        result: { success: true, status, message: '已取消待清理' } };
    }
    if (user.cleanup_pending) return { result: { code: -1, message: '请先取消待清理状态' } };
    if (data.status === 'banned' && user._openid === openid) {
      return { result: { code: -1, message: '不能封禁自己的账号' } };
    }
    return { patch: user.status === data.status ? null : { status: data.status },
      result: { success: true, status: data.status, message: data.status === 'banned' ? '已封禁该用户' : '已解除封禁' } };
  });
}

// 重置用户密码
async function adminResetPassword(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (typeof data.userId !== 'string' || !data.userId || !data.newPassword) return { code: -1, message: "缺少参数" };
  if (typeof data.newPassword !== 'string' || data.newPassword.length < 4 || data.newPassword.length > 1024) {
    return { code: -1, message: "密码长度需为4至1024位" };
  }
  // Same credential format as login/index.js, which is packaged independently.
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(data.newPassword, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return changeManagedUser(openid, data.userId, user => {
    if (user.cleanup_pending) return { result: { code: -1, message: '请先取消待清理状态' } };
    return { patch: { password: 'scrypt-v1:' + salt + ':' + digest.toString('hex') },
      result: { success: true, message: '密码已重置' } };
  });
}

// 获取用户详情
async function adminGetUserDetail(openid, userId) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!userId) return { code: -1, message: "缺少用户ID" };

  const userRes = await db.collection("users").doc(userId).get();
  if (!userRes.data) return { code: -1, message: "用户不存在" };

  const u = userRes.data;
  // 查询用户的关联数据
  const [goals, pets, tasks, logs] = await Promise.all([
    safeQuery("goals", { _openid: u._openid || '', status: _.neq('deleted') }),
    safeQuery("pets", { _openid: u._openid || '' }),
    safeQuery("tasks", { _openid: u._openid || '' }),
    safeQuery("growth_logs", { _openid: u._openid || '' }),
  ]);

  return {
    code: 0,
    data: {
      user: {
        id: u._id, nickname: u.nickname, username: u.username, avatar: u.avatar,
        level: u.level || 1, role: u.role || 'user', status: u.status || 'active',
        total_xp: u.total_xp || 0, streak_days: u.streak_days || 0,
        created_at: u.created_at, updated_at: u.updated_at, last_login_at: u.last_login_at,
      },
      goalCount: goals.length,
      petCount: pets.length,
      taskCount: tasks.length,
      logCount: logs.length,
      recentLogs: (logs || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 10),
    },
  };
}

// 反馈列表
async function adminListFeedbacks(openid, params) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };

  let query = {};
  if (params && params.type && params.type !== 'all') {
    query.type = params.type;
  }

  const feedbacks = await safeQuery("feedbacks", query);
  const sorted = (feedbacks || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return { code: 0, data: sorted.slice(0, (params && params.limit) || 100) };
}

// 标记反馈已处理
async function adminResolveFeedback(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!data.fbId) return { code: -1, message: "缺少反馈ID" };

  await safeUpdate("feedbacks", { _id: data.fbId }, {
    resolved: true, resolved_by: openid, resolved_at: Date.now(),
    reply: data.reply || '',
  });
  return { success: true, message: '已标记为已处理' };
}

// 删除反馈
async function adminDeleteFeedback(openid, fbId) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!fbId) return { code: -1, message: "缺少反馈ID" };

  await db.collection("feedbacks").doc(fbId).remove();
  return { success: true, message: '已删除' };
}

// 宠物列表（全平台）
async function adminListPets(openid, params) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };

  const page = (params && params.page) || 1;
  const pageSize = Math.min((params && params.pageSize) || 20, 50);
  const skip = (page - 1) * pageSize;

  const countRes = await db.collection("pets").count();
  const listRes = await db.collection("pets")
    .orderBy("created_at", "desc")
    .skip(skip)
    .limit(pageSize)
    .get();

  // 关联用户信息
  const openids = [...new Set((listRes.data || []).map(p => p._openid).filter(Boolean))];
  let userMap = {};
  if (openids.length > 0) {
    const users = await safeQuery("users", {});
    (users || []).forEach(u => { userMap[u._openid || ''] = u; });
  }

  return {
    code: 0,
    data: {
      total: countRes.total,
      page,
      list: (listRes.data || []).map(p => {
        const owner = userMap[p._openid];
        const hatched = p.is_hatched === true;
        return {
          id: p._id, name: p.name, stage: hatched ? getHatchedGrowthStage(p).key : 'EGG', level: p.level,
          experience: p.experience, mood: p.mood, status: p.status, is_hatched: hatched, deleted_at: p.deleted_at,
          ownerName: (owner && (owner.nickname || owner.username)) || '未知',
          ownerId: (owner && owner._id) || '',
          created_at: p.created_at,
        };
      }),
    },
  };
}

// 编辑宠物
async function adminEditPet(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (typeof data.petId !== 'string' || !data.petId) return { code: -1, message: "缺少宠物ID" };
  const targetStage = GROWTH_STAGE_THRESHOLDS.find(entry => entry.key === data.stage);
  const mood = data.mood === 'calm' ? 'normal' : data.mood;
  if ((data.stage !== undefined && !targetStage) ||
      (mood !== undefined && !Object.hasOwn(MOOD_MESSAGES, mood)) ||
      (data.level !== undefined && (!Number.isSafeInteger(data.level) || data.level < 1 || data.level > 99)) ||
      (data.experience !== undefined && (!Number.isSafeInteger(data.experience) || data.experience < 0)) ||
      (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim()))) {
    return { code: -1, message: '宠物资料不正确' };
  }
  const database = cloud.database({ throwOnNotFound: false });
  return database.runTransaction(async tx => {
    const { data: pet } = await tx.collection('pets').doc(data.petId).get();
    if (!pet || pet.deleted_at) return { code: -1, message: '宠物不存在或已放行' };
    const hatched = pet.is_hatched === true;
    if (targetStage && (targetStage.key !== 'EGG') !== hatched) {
      return { code: -1, message: '蛋与已孵化宠物之间请通过原孵化流程转换' };
    }
    const fields = {};
    if (data.name !== undefined) fields.name = data.name.trim().slice(0, 30);
    if (data.status !== undefined) fields.status = data.status;
    if (data.level !== undefined) fields.level = data.level;
    if (data.experience !== undefined) fields.experience = data.experience;
    if (mood !== undefined && mood !== pet.mood) {
      fields.mood = mood;
      fields.mood_message = pickMoodMessage(mood);
    }
    if (targetStage) {
      fields.stage = targetStage.key;
      if (hatched && getHatchedGrowthStage(pet).key !== targetStage.key) fields.growth_value = targetStage.minGrowth;
    }
    if (Object.keys(fields).length) await updateTransactionRow(tx, 'pets', data.petId, { ...fields, updated_at: Date.now() });
    return { success: true, message: '宠物信息已更新' };
  });
}

// 发送系统广播
async function adminBroadcast(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!data.title || !data.content) return { code: -1, message: "标题和内容不能为空" };

  await safeAdd("announcements", {
    _openid: openid, title: data.title, content: data.content,
    type: data.type || 'system', priority: data.priority || 'normal',
    created_at: Date.now(), expires_at: data.expiresAt || (Date.now() + 7 * 86400000),
  });
  return { success: true, message: '广播发布成功' };
}

// Keep each administrative cleanup inside one bounded database transaction.
const ACCOUNT_CLEANUP_LIMIT = 50;
// Deployment must keep every app and login writer below this window.
const ACCOUNT_CLEANUP_DRAIN_MS = 60_000;
const ACCOUNT_CLEANUP_BATCH_DOC = 'admin-cleanup-batch';
const ACCOUNT_COLLECTIONS = {
  pets: 'deletedPets', user_growth_pool: 'deletedPools', growth_logs: 'deletedLogs',
  goals: 'deletedGoals', tasks: 'deletedTasks', checkins: 'deletedCheckins',
  achievements: 'deletedAchievements', emotions: 'deletedEmotions', capsules: 'deletedCapsules',
  ai_plans: 'deletedAiRecords', api_keys: 'deletedApiKeys', feedbacks: 'deletedFeedbacks',
  pet_letters: 'deletedLetters',
};

async function readCleanupRows(collection, filter, limit) {
  try {
    const fields = collection === 'users'
      ? { _id: true, _openid: true, role: true, username: true, cleanup_pending: true }
      : { _id: true };
    const { data } = await db.collection(collection).where(filter).field(fields).limit(limit).get();
    return data;
  } catch (error) {
    if (collection !== 'users' && (error.errCode === -502005 || error.code === 'DATABASE_COLLECTION_NOT_EXIST')) return [];
    throw error;
  }
}

function cleanupPending(readyAt) {
  const seconds = Math.max(1, Math.ceil((readyAt - Date.now()) / 1000));
  return { code: -1, reason: 'ACCOUNT_CLEANUP_PENDING', message: '账号已暂停，请在 ' + seconds + ' 秒后再次确认清理' };
}

async function readCleanupBatch(database) {
  return (await database.collection('account_claims').doc(ACCOUNT_CLEANUP_BATCH_DOC).get()).data;
}

function cleanupBatchView(batch) {
  return { status: batch?.status || 'idle', batchId: batch?.id || null,
    targetCount: batch?.targetIds.length || 0, readyAt: batch?.readyAt || 0,
    ...(batch?.status === 'done' ? batch.receipt : {}) };
}

async function prepareAccountCleanup(database, caller, targets, previousBatch) {
  const bulk = previousBatch !== undefined;
  const token = crypto.randomBytes(12).toString('hex');
  return database.runTransaction(async tx => {
    await readActiveAdmin(tx, caller.openid, caller.id);
    await pinAdminAccess(tx, caller.id);
    const users = tx.collection('users');
    const readyAt = Date.now() + ACCOUNT_CLEANUP_DRAIN_MS;
    if (bulk) {
      const current = await readCleanupBatch(tx);
      if ((current?.id || null) !== (previousBatch?.id || null) || current?.status === 'pending') {
        throw new Error('清理批次已变化，请重新打开确认');
      }
    }
    for (const target of targets) {
      const { data: user } = await users.doc(target._id).get();
      if (!user || user.role === 'admin' || user._openid !== target._openid) {
        throw new Error('待删除账号已变更，请刷新后重试');
      }
      if (user.cleanup_pending) {
        if (!bulk && !user.cleanup_pending.batchId) return cleanupPending(user.cleanup_pending.readyAt);
        throw new Error('账号已有待清理操作，请先处理原操作');
      }
      await updateTransactionRow(tx, 'users', user._id, {
        status: 'banned',
        cleanup_pending: { token, readyAt, priorStatus: user.status || 'active', ...(bulk ? { batchId: token } : {}) },
        updated_at: Date.now(),
      });
    }
    if (!bulk) return cleanupPending(readyAt);
    const batch = { id: token, status: 'pending', targetIds: targets.map(user => user._id), readyAt, receipt: null };
    if (previousBatch) {
      await updateTransactionRow(tx, 'account_claims', ACCOUNT_CLEANUP_BATCH_DOC, batch);
    } else {
      await tx.collection('account_claims').add({ data: { _id: ACCOUNT_CLEANUP_BATCH_DOC, ...batch } });
    }
    return cleanupBatchView(batch);
  });
}

async function collectAccountDocuments(targets) {
  const documents = [];
  let recordCount = targets.length;
  if (recordCount > ACCOUNT_CLEANUP_LIMIT) throw new Error('本批账号过多，请分开处理');
  for (const user of targets) {
    if (user.role === 'admin') throw new Error('不能删除管理员账号');
    if (!user._openid) continue;
    const { data: owners } = await db.collection('users').where({ _openid: user._openid }).limit(2).get();
    if (owners.length !== 1 || owners[0]._id !== user._id) throw new Error('账号归属不唯一，清理已停止');

    for (const [collection, counter] of Object.entries(ACCOUNT_COLLECTIONS)) {
      const rows = await readCleanupRows(collection, { _openid: user._openid }, ACCOUNT_CLEANUP_LIMIT - recordCount + 1);
      recordCount += rows.length;
      if (recordCount > ACCOUNT_CLEANUP_LIMIT) throw new Error('关联记录超过本次事务上限，请在维护窗口分批处理');
      for (const row of rows) documents.push({ collection, counter, id: row._id, owner: user._openid });
    }
  }
  return documents;
}

async function deleteAccounts(database, caller, targets, documents, keptUsers, batch) {
  return database.runTransaction(async tx => {
    await readActiveAdmin(tx, caller.openid, caller.id);
    if (targets.length) await pinAdminAccess(tx, caller.id);
    if (batch) {
      const current = await readCleanupBatch(tx);
      if (current?.id !== batch.id) throw new Error('清理批次已变化，请重新打开确认');
      if (current.status === 'done') return cleanupBatchView(current);
      if (current.status !== 'pending') throw new Error('清理批次已取消');
    }
    const counts = { deletedUsers: 0, deletedPets: 0, deletedPools: 0, deletedLogs: 0, keptUsers, errors: [] };
    const users = tx.collection('users');
    for (const target of targets) {
      const { data: current } = await users.doc(target._id).get();
      if (!current || current.role === 'admin' || current._openid !== target._openid || current.status !== 'banned' ||
          !current.cleanup_pending || current.cleanup_pending.token !== target.cleanup_pending.token ||
          current.cleanup_pending.batchId !== target.cleanup_pending.batchId ||
          current.cleanup_pending.readyAt > Date.now()) {
        throw new Error('待删除账号已变更，请刷新后重试');
      }
      if (current._openid) {
        // Keep a registration marker even for accounts created before the claims collection existed.
        const claims = tx.collection('account_claims');
        const id = 'wechat-' + crypto.createHash('sha256').update(current._openid).digest('hex');
        const { data: claim } = await claims.doc(id).get();
        if (claim && claim.user_id !== current._id) throw new Error('微信账号登记已变更，请核对后再清理');
        if (!claim) await claims.add({ data: { _id: id, user_id: current._id } });
      }
    }
    for (const item of documents) {
      const doc = tx.collection(item.collection).doc(item.id);
      const { data: current } = await doc.get();
      if (current?._openid !== item.owner) throw new Error('关联记录已变更，请刷新后重试');
      const result = await doc.remove();
      if (result.stats?.removed !== 1) throw new Error('关联记录未删除');
      counts[item.counter] = (counts[item.counter] || 0) + 1;
    }
    for (const target of targets) {
      const result = await users.doc(target._id).remove();
      if (result.stats?.removed !== 1) throw new Error('账号记录未删除');
      counts.deletedUsers++;
    }
    if (batch) {
      const completed = { ...batch, status: 'done', receipt: counts };
      await updateTransactionRow(tx, 'account_claims', ACCOUNT_CLEANUP_BATCH_DOC, {
        status: completed.status, receipt: completed.receipt,
      });
      return cleanupBatchView(completed);
    }
    return counts;
  });
}

async function cancelAccountCleanup(database, caller, batch) {
  return database.runTransaction(async tx => {
    await readActiveAdmin(tx, caller.openid, caller.id);
    await pinAdminAccess(tx, caller.id);
    const current = await readCleanupBatch(tx);
    if (current?.id !== batch.id) throw new Error('清理批次已变化，请重新打开确认');
    if (current.status === 'cancelled') return cleanupBatchView(current);
    if (current.status !== 'pending') throw new Error('清理已完成，无法取消');
    for (const id of current.targetIds) {
      const { data: user } = await tx.collection('users').doc(id).get();
      if (user?.cleanup_pending?.batchId !== current.id) continue;
      await updateTransactionRow(tx, 'users', id, {
        status: user.cleanup_pending.priorStatus, cleanup_pending: null, updated_at: Date.now(),
      });
    }
    await updateTransactionRow(tx, 'account_claims', ACCOUNT_CLEANUP_BATCH_DOC, { status: 'cancelled' });
    return cleanupBatchView({ ...current, status: 'cancelled' });
  });
}

async function adminCleanupNonAdmin(callerOpenid, data) {
  const adminId = await findAdminId(callerOpenid);
  if (!adminId) return { code: -1, message: '无管理员权限' };
  if (!['status', 'prepare', 'finish', 'cancel'].includes(data.phase)) {
    return { code: -1, message: '请使用新版管理后台确认清理批次' };
  }
  const database = cloud.database({ throwOnNotFound: false });
  const caller = { openid: callerOpenid, id: adminId };
  const batch = await readCleanupBatch(database);
  const reply = view => ({ code: 0, data: view });
  if (data.phase === 'status') return reply(cleanupBatchView(batch));
  if (data.batchId !== (batch?.id || null)) throw new Error('清理批次已变化，请重新打开确认');
  if (data.phase === 'prepare') {
    if (batch?.status === 'pending') throw new Error('已有待确认批次，请先完成或取消');
    const targets = await readCleanupRows('users', { role: _.neq('admin') }, ACCOUNT_CLEANUP_LIMIT + 1);
    if (targets.some(user => user.cleanup_pending)) throw new Error('有账号正在单独清理，请先处理原操作');
    if (!targets.length) return reply({ ...cleanupBatchView(batch), noTargets: true });
    await collectAccountDocuments(targets);
    return reply(await prepareAccountCleanup(database, caller, targets, batch || null));
  }
  if (!batch) throw new Error('当前没有待处理的清理批次');
  if (data.phase === 'cancel') return reply(await cancelAccountCleanup(database, caller, batch));
  if (batch.status === 'done') return reply(cleanupBatchView(batch));
  if (batch.status !== 'pending') throw new Error('清理批次已取消');
  if (batch.readyAt > Date.now()) return reply(cleanupBatchView(batch));
  let targets, documents;
  try {
    targets = await readCleanupRows('users', { _id: _.in(batch.targetIds) }, ACCOUNT_CLEANUP_LIMIT + 1);
    if (targets.length !== batch.targetIds.length || targets.some(user => user.cleanup_pending?.batchId !== batch.id)) {
      throw new Error('原批次账号已变化，请取消后重新确认');
    }
    documents = await collectAccountDocuments(targets);
  } catch (error) {
    const current = await readCleanupBatch(database);
    if (current?.id === batch.id && current.status === 'done') return reply(cleanupBatchView(current));
    throw error;
  }
  const admins = await readAll('users', { role: 'admin' });
  return reply(await deleteAccounts(database, caller, targets, documents, admins.map(user => user.username || user._id), batch));
}

async function adminDeleteUser(callerOpenid, data) {
  const adminId = await findAdminId(callerOpenid);
  if (!adminId) return { code: -1, message: '无管理员权限' };
  if (typeof data.userId !== 'string' || !data.userId) return { code: -1, message: '缺少用户ID' };
  const database = cloud.database({ throwOnNotFound: false });
  const { data: user } = await database.collection('users').doc(data.userId).get();
  if (!user) return { code: -1, message: '用户不存在' };
  if (user.cleanup_pending?.batchId) return { code: -1, message: '请在系统工具处理本批清理' };
  const caller = { openid: callerOpenid, id: adminId };
  if (user.cleanup_pending?.readyAt > Date.now()) return cleanupPending(user.cleanup_pending.readyAt);
  const documents = await collectAccountDocuments([user]);
  if (!user.cleanup_pending) return prepareAccountCleanup(database, caller, [user]);
  const counts = await deleteAccounts(database, caller, [user], documents, []);
  return { code: 0, success: true, data: { ...counts, username: user.username || user._id }, message: '已删除' };
}

// ====== V8.6 AI 时间胶囊 ======
async function myCapsules(openid) {
  const res = await db.collection('capsules').where({ _openid: openid })
    .orderBy('createdAt', 'desc').limit(50).get();
  return { code: 0, data: res.data || [] };
}

async function saveCapsule(openid, data) {
  if (!data || !data.text) {
    return { code: -1, message: '胶囊内容不能为空' }
  }
  try {
    const now = Date.now()
    const doc = {
      _openid: openid,
      text: data.text,
      unlock_at: data.unlock_at || (now + 30 * 24 * 60 * 60 * 1000),
      created_date: data.created_date || '',
      createdAt: now
    }
    const res = await db.collection('capsules').add({ data: doc })
    return { code: 0, data: { _id: res._id, ...doc } }
  } catch (e) {
    console.error('[saveCapsule] 保存失败:', e.message)
    return { code: -1, message: '保存失败: ' + e.message }
  }
}

// ====== V9.0 AI 大模型代理 ======

/**
 * 调用大模型 API（OpenAI 兼容格式）
 */
function callLLM(baseUrl, apiKey, model, messages, maxTokens, options = {}) {
  const mt = maxTokens || 2000
  return new Promise((resolve, reject) => {
    let deadline
    const done = (error, content) => { clearTimeout(deadline); if (error) reject(error); else resolve(content) }
    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const payload = { model, messages, stream: false, temperature: 0.7, max_tokens: mt }
    // Opt in only for the coach and the official endpoint whose JSON contract was checked.
    if (options.jsonObject && url.hostname === 'api.deepseek.com') {
      payload.response_format = { type: 'json_object' }; payload.temperature = 0.2
    }
    if (url.hostname === 'api.deepseek.com' && /^(deepseek-flash|deepseek-v4-)/.test(model)) payload.thinking = { type: 'disabled' }
    const body = JSON.stringify(payload)
    const redact = text => String(text).split(apiKey).join('[已隐藏]')

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: options.timeoutMs || 30000
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        // 1. 检查 HTTP 状态码
        if (res.statusCode !== 200) {
          let errMsg = 'HTTP ' + res.statusCode
          try {
            const errJson = JSON.parse(data)
            if (errJson.error) {
              errMsg = errJson.error.message || errJson.error.code || errMsg
            } else if (errJson.code) {
              errMsg = errJson.message || errJson.code
            } else if (errJson.message) {
              errMsg = errJson.message
            }
          } catch (e) { /* 用原始 data */ }
          console.warn('[callLLM] 非200响应:', res.statusCode)
          done(new Error(redact(errMsg)))
          return
        }

        // 2. 200 OK — 检查是否有业务错误
        try {
          const json = JSON.parse(data)
          // OpenAI 兼容格式的业务错误
          if (json.error) {
            const msg = json.error.message || json.error.code || 'API 返回错误'
            done(new Error(redact(msg)))
            return
          }
          // Qwen/百炼 非兼容模式的错误
          if (json.code && json.code !== 0 && json.code !== '0') {
            done(new Error(redact(json.message || json.code || 'API 返回错误')))
            return
          }
          // 提取回复内容
          const content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : ''
          done(null, options.usage ? { content, usage: json.usage } : content)
        } catch (e) {
          done(new Error('模型返回了无法解析的响应'))
        }
      })
    })
    req.on('error', (e) => done(new Error('网络错误: ' + redact(e.message))))
    const expire = () => { done(new Error('请求超时（' + Math.round((options.timeoutMs || 30000) / 1000) + '秒）')); req.destroy() }
    req.on('timeout', expire)
    if (options.timeoutMs) deadline = setTimeout(expire, options.timeoutMs)
    req.write(body)
    req.end()
  })
}

/**
 * 获取用户的 API Key 配置
 */
const AI_PROVIDER_DEFAULTS = {
  qwen: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  deepseek: { base_url: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash' },
  custom: { base_url: '', model: '' }
};
function normalizeAiConfig(config) {
  const defaults = Object.prototype.hasOwnProperty.call(AI_PROVIDER_DEFAULTS, config.provider) ? AI_PROVIDER_DEFAULTS[config.provider] : null;
  if (!defaults) throw new Error('不支持的模型供应商');
  const base_url = String(config.base_url || defaults.base_url).trim().replace(/\/+$/, '');
  const model = String(config.model || defaults.model).trim();
  const url = new URL(base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !model) throw new Error('请填写有效的 HTTPS 接口地址和模型名称');
  return { ...config, base_url, model };
}
function canReuseApiKey(config, nextBaseUrl) {
  try {
    return new URL(normalizeAiConfig(config).base_url).origin === new URL(nextBaseUrl).origin;
  } catch {
    return false;
  }
}
async function queryApiKeys(openid, provider) {
  if (!openid) throw new Error('身份未就绪');
  const filter = { _openid: openid };
  if (provider) filter.provider = provider;
  const keys = [];
  for (let skip = 0; ; skip += 100) {
    const page = await db.collection('api_keys').where(filter).skip(skip).limit(100).get();
    keys.push(...page.data);
    if (page.data.length < 100) break;
  }
  return keys.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0) ||
    Number(b.created_at || 0) - Number(a.created_at || 0) || String(a.provider).localeCompare(String(b.provider)) ||
    String(b._id).localeCompare(String(a._id)));
}
async function getUserApiConfig(openid, provider) {
  const keys = await queryApiKeys(openid, provider);
  const config = keys.find(k => k.api_key);
  return config ? normalizeAiConfig(config) : null;
}
async function resolveAiRequest(openid, data) {
  const provider = data.provider;
  const config = data.apiKey
    ? normalizeAiConfig({ provider, api_key: data.apiKey, base_url: data.baseUrl, model: data.model })
    : await getUserApiConfig(openid, provider);
  if (!config) throw new Error('请先保存所选供应商的 API Key 配置');
  const final = normalizeAiConfig({ ...config, base_url: data.baseUrl || config.base_url, model: data.model || config.model });
  if (!data.apiKey && !canReuseApiKey(config, final.base_url)) {
    throw new Error('接口站点已变化，请重新填写该站点的 API Key');
  }
  return { apiKey: final.api_key, baseUrl: final.base_url, model: final.model, provider: final.provider };
}

/**
 * 测试连接
 */
async function aiTestConnection(openid, data) {
  try {
    const { apiKey, baseUrl, model } = await resolveAiRequest(openid, data || {});
    if (!apiKey || apiKey.length < 10) return { code: -1, message: 'API Key 无效' };
    await callLLM(baseUrl, apiKey, model, [
      { role: 'user', content: '你好，请回复"连接成功"' }
    ])
    return { code: 0, message: '连接成功！模型: ' + model }
  } catch (e) {
    return { code: -1, message: '连接失败: ' + e.message }
  }
}

/**
 * AI 对话
 */
async function aiChat(openid, data) {
  const { messages, provider } = data || {}
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { code: -1, message: '消息不能为空' }
  }

  try {
    const { apiKey, baseUrl, model } = await resolveAiRequest(openid, data);
    const reply = await callLLM(baseUrl, apiKey, model, messages)
    return { code: 0, data: { reply } }
  } catch (e) {
    return { code: -1, message: 'AI 请求失败: ' + e.message }
  }
}

/**
 * V9.1 异步生成任务 — 第1步：创建计划记录，秒级返回
 */
async function aiStartGenerate(openid, data) {
  const { planState, messages, provider, request_id: requestId } = data || {}
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w:.-]{1,128}$/.test(requestId))) {
    return { code: -1, message: '生成请求编号无效' }
  }
  // V10.6：允许空对话直接生成（用户点"生成计划"按钮，即使没聊过也能生成）
  const safeMessages = (messages && Array.isArray(messages) && messages.length > 0) ? messages : []
  if (data.draft_meta && (!Number.isSafeInteger(data.draft_meta.expected_revision) || data.draft_meta.expected_revision < 0 ||
      !/^[\w:.-]{1,128}$/.test(data.draft_meta.conversation_id || ''))) return { code: -1, message: '请先明确用户目标并恢复正确的草案版本' }

  const planRow = async getDraft => {
    let safeState = planState || {}
    if (data.draft_meta) {
      const current = await getDraft()
      if (current.revision !== data.draft_meta.expected_revision) throw new Error('云端已有新版本，请先恢复草案')
      const previous = current.draft && current.draft.conversation_id === data.draft_meta.conversation_id ? current.draft : null
      const known = new Set((previous && previous.messages || []).map(m => m.id))
      safeState = plannerContext.derive(safeMessages.filter(m => !known.has(m.id)), previous && previous.context).values
      for (const [field, value] of Object.entries(data.user_edits || {})) {
        if (!plannerContext.FIELDS.includes(field) || typeof value !== 'string' || value.length > 500) throw new Error('用户要求格式不正确')
        safeState[field] = value
      }
      if (!safeState.what) throw new Error('请先说明你想完成的目标')
    }
    return {
      _openid: openid,
      kind: 'plan_generation',
      planState: safeState,
      messages: safeMessages,
      provider: provider || '',
      draft_meta: data.draft_meta || null,
      user_edits: data.user_edits || {},
      status: 'pending',
      createdAt: Date.now()
    }
  }

  try {
    await ensureCollection('ai_plans')
    const receipt = (id, status) => ({ code: 0, data: { plan_id: id, status } })
    if (!requestId) {
      const row = await planRow(() => plannerDrafts.get(openid))
      return receipt((await safeAdd('ai_plans', row))._id, 'pending')
    }
    const id = stableId('plan_start_', [openid, requestId])
    const fingerprint = stableId('', [planState || {}, safeMessages, provider || '', data.draft_meta || null, data.user_edits || {}])
    const database = cloud.database({ throwOnNotFound: false })
    return await database.runTransaction(async tx => {
      const plans = tx.collection('ai_plans')
      const { data: previous } = await plans.doc(id).get()
      if (previous) {
        if (previous._openid !== openid || previous.kind !== 'plan_generation' || previous.steward_run_id ||
            previous.start_fingerprint !== fingerprint) {
          return { code: -1, message: '同一生成请求不能提交不同内容' }
        }
        return receipt(id, previous.status)
      }
      const row = await planRow(() => plannerDrafts.getInTransaction(openid, tx))
      await plans.add({ data: { ...row, _id: id, start_fingerprint: fingerprint } })
      return receipt(id, 'pending')
    })
  } catch (e) {
    return { code: -1, message: '创建任务失败: ' + e.message }
  }
}

/**
 * V9.1 异步生成任务 — 第2步：调用 LLM 生成并写回结果
 */
async function generationResult(openid, planId, plan) {
  if (!plan.draft_meta) return plan.result
  try {
    const current = await plannerDrafts.get(openid)
    return { ...plan.result, ...(current.draft?.source_plan_id === planId ? { draft: current.draft } : {}) }
  } catch (error) {
    return { ...plan.result, draft_error: '模型结果已确认，云端草案暂未读到' }
  }
}

async function aiDoGenerate(openid, data, control = {}) {
  const { plan_id, provider } = data || {}
  if (!plan_id) return { code: -1, message: '缺少 plan_id' }
  const database = cloud.database({ throwOnNotFound: false })
  const token = crypto.randomBytes(16).toString('hex')
  let claimed = false
  const finish = (status, fields) => database.runTransaction(async tx => {
    const row = tx.collection('ai_plans').doc(plan_id)
    const { data: current } = await row.get()
    if (!current || current._openid !== openid || current.generation_token !== token ||
        current.status !== 'running' || generationLease.expired(current, Date.now())) return false
    await updateTransactionRow(tx, 'ai_plans', plan_id, { ...fields, status, generation_token: '', lease_until: 0, updatedAt: Date.now() })
    return true
  })

  try {
    const receipt = await database.runTransaction(async tx => {
      if (control.guard) await control.guard(tx)
      const { data: plan } = await tx.collection('ai_plans').doc(plan_id).get()
      if (!plan || plan._openid !== openid) return { rejected: '任务不存在' }
      if (plan.steward_run_id && control.runId !== plan.steward_run_id) return { rejected: '请从森林管家的协作入口处理这份规划' }
      if (plan.kind && plan.kind !== 'plan_generation') {
        return { rejected: plan.kind === 'plan_publication' ? '发布记录不能用于生成任务' : '这类记录不能用于生成任务' }
      }
      if (plan.status === 'done' && plan.result) return { cached: plan }
      const at = Date.now()
      if (plan.status === 'running' && !generationLease.expired(plan, at)) return { running: true }
      if (plan.status === 'running') throw new Error('上次生成已中断，请确认后重新发起')
      if (plan.status === 'failed') throw new Error(plan.error || '上次生成失败，请重新发起')
      if (plan.status && plan.status !== 'pending') throw new Error('当前生成状态不可执行')
      if (plan.draft_meta && (await plannerDrafts.getInTransaction(openid, tx)).revision !== plan.draft_meta.expected_revision) {
        const message = '云端已有新草案，请先恢复草案'
        await updateTransactionRow(tx, 'ai_plans', plan_id, { status: 'failed', error: message, updatedAt: at })
        return { rejected: message }
      }
      await updateTransactionRow(tx, 'ai_plans', plan_id, {
        status: 'running', generation_token: token, lease_until: at + generationLease.LEASE_MS, updatedAt: at,
      })
      return { plan }
    })
    if (receipt.cached) return { code: 0, data: await generationResult(openid, plan_id, receipt.cached) }
    if (receipt.running) return { code: 0, data: { status: 'running', plan_id } }
    if (receipt.rejected) return { code: -1, message: receipt.rejected }
    claimed = true
    const plan = receipt.plan
    const messages = plan.messages || []

    // 获取 API 配置
    const { apiKey, baseUrl, model } = await resolveAiRequest(openid, { ...data, provider: plan.provider || provider });

    // 构建提取任务的 prompt（注入已收集的规划信息）
    const ps = plan.planState || {}
    const hasContext = !!(ps.what || ps.why || ps.deadline || ps.dailyTime || ps.level)
    const planContext = hasContext
      ? `用户目标：${ps.what || '未指定'}，动机：${ps.why || '未说明'}，周期：${ps.deadline || '未指定'}，每日可投入：${ps.dailyTime || '未指定'}，当前水平：${ps.level || '未说明'}，限制：${ps.constraints || '未说明'}。未说明的信息只能作为草案假设，不能称为用户已确认。`
      : '用户尚未提供具体规划信息，请生成一个通用的每日成长计划（如：阅读、运动、学习等健康习惯）。'

    const extractPrompt = {
      role: 'system',
      content: `根据以下已确认的规划信息，生成每日任务清单：

${planContext}

输出标准JSON（不要用markdown代码块包裹）：
{
  "goal": {
    "title": "目标名称（简短）",
    "period": "周期",
    "period_days": 7,
    "stages": [
      {"name": "阶段名", "duration": "第1-7天", "milestone": "里程碑描述"}
    ]
  },
  "tasks": [
    {"title": "具体可执行的任务名", "xp_reward": 20, "stage": 1, "estimated_minutes": 25, "day_index": 1}
  ]
}

任务要求：
- 可量化、可打卡
- 单任务10~30分钟
- 数量3~6个
- period_days 为用户周期的总天数；day_index 从1开始，必须处于该周期内，根据阶段安排到不同日期。这是若干具体任务，不是每天自动重复的规则。
- 难度递进
- xp_reward取10/20/30三档

禁止：一次性超长任务、不可执行任务、空泛任务、超过6个任务。
只返回JSON，不要任何其他文字。`
    }

    if (control.guard) await db.runTransaction(control.guard)
    const reply = await callLLM(baseUrl, apiKey, model, [...messages.map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content
    })), extractPrompt], undefined, { timeoutMs: control.timeoutMs || 18000 })

    let jsonStr = reply.trim()

    // Step 1: 尝试提取 markdown JSON 代码块
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      jsonStr = jsonBlockMatch[1].trim()
    }

    // Step 2: 如果整体不是 JSON，查找第一个 { 到最后一个 }
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{')
      const lastBrace = jsonStr.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
      }
    }

    // Step 3: 清理残留的 markdown 标记
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '')

    // Step 4: 尝试解析
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      throw new Error('模型未返回有效计划JSON，本次没有生成可确认的模型草案')
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.goal || typeof parsed.goal.title !== 'string' || !parsed.goal.title.trim() ||
        !Array.isArray(parsed.tasks) || !parsed.tasks.length || parsed.tasks.length > 20 ||
        parsed.tasks.some(task => !task || typeof task.title !== 'string' || !task.title.trim())) throw new Error('模型计划缺少有效目标或任务')
    const result = {
      goal: parsed.goal,
      tasks: parsed.tasks,
      source: 'model'
    }

    // 写回结果
    if (!await finish('done', { result: _.set(result), error: '' })) throw new Error('生成已中断，本次结果未保存')
    try {
      const draft = await plannerDrafts.saveGenerated(openid, plan_id, plan, result, control.guard)
      return { code: 0, data: { ...result, ...(draft ? { draft } : {}) } }
    } catch (error) {
      return { code: 0, data: { ...result, draft_error: error.message || '模型稿已生成，但云端版本未保存，请保留本机稿后重试' } }
    }
  } catch (e) {
    // 标记失败
    if (claimed) {
      try { await finish('failed', { error: String(e.message || e).slice(0, 500) }) }
      catch (error) { console.warn('[AI计划] 未能确认生成失败状态') }
    }
    return { code: -1, message: '生成失败: ' + e.message }
  }
}

/**
 * V9.1 轮询计划状态
 */
async function aiPollPlan(openid, data) {
  const { plan_id: planId, request_id: requestId } = data || {}
  const byRequest = requestId !== undefined
  if (byRequest && (planId !== undefined || typeof requestId !== 'string' || !/^[\w:.-]{1,128}$/.test(requestId))) {
    return { code: -1, message: '生成请求编号无效' }
  }
  if (!byRequest && (typeof planId !== 'string' || !planId)) return { code: -1, message: '生成任务编号无效' }
  const plan_id = byRequest ? stableId('plan_start_', [openid, requestId]) : planId

  try {
    const database = cloud.database({ throwOnNotFound: false })
    const { data: plan } = await database.collection('ai_plans').doc(plan_id).get()
    if (!plan && byRequest) return { code: 0, data: { status: 'missing' } }
    if (!plan || plan._openid !== openid) return { code: -1, message: '任务不存在' }
    if (plan.kind && plan.kind !== 'plan_generation') return { code: -1, message: '这类记录不是生成任务' }
    const expired = generationLease.expired(plan, Date.now())
    const status = expired ? 'failed' : plan.status || 'unknown'
    return {
      code: 0,
      data: {
        ...(byRequest ? { plan_id } : {}),
        status,
        result: status === 'done' && plan.result ? await generationResult(openid, plan_id, plan) : null,
        error: expired ? '上次生成已中断，请确认后重新发起' : status === 'failed' ? (plan.error || '') : ''
      }
    }
  } catch (e) {
    return { code: -1, message: '查询失败: ' + e.message }
  }
}

/**
 * V10.0 AI 规划师对话 — Agent 模式
 * 使用专门的系统提示词，让 LLM 像真实顾问一样自然对话
 */
async function aiPlannerChat(openid, data) {
  const { messages, provider } = data || {}
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { code: -1, message: '消息不能为空' }
  }

  let apiKey, baseUrl, model;
  try { ({ apiKey, baseUrl, model } = await resolveAiRequest(openid, data)); }
  catch (error) { return { code: -1, message: error.message }; }

  // ===== Agent 系统提示词 =====
  const agentSystemPrompt = {
    role: 'system',
    content: `你是一个"AI任务规划师（AI Planner Agent）"。

你的核心能力不是按照固定流程执行，而是通过自然对话，逐步理解用户需求，并在合适时机将其结构化为可执行任务。

你需要做到三件事：
1. 像真实顾问一样对话，而不是按流程问答
2. 在对话中逐步提取结构化信息（隐式建模）
3. 在用户提出"生成任务"或表达类似意图时，输出任务结构

【对话原则】
❌ 禁止行为：
- 禁止固定问卷式提问（例如：第一步问目标、第二步问时间）
- 禁止强制流程推进（例如"现在进入下一步"）
- 禁止机械总结后才允许继续对话
- 禁止每轮都问"还有吗？"

✅ 推荐行为：
- 像"有经验的产品经理/教练"一样对话
- 根据用户当前表达"追问最关键缺口"
- 可以跳跃式提问（不按顺序）
- 可以自由讨论、给建议、帮用户重构需求
- 可以在任何时候轻量总结，但不打断对话

【信息建模（隐式进行）】
你需要在对话中持续维护一个"内部任务理解结构"，但不需要每次显式输出：
{ goal: "", background: "", constraints: [], priority: "", deadline: "", resources: "" }
规则：信息缺失就继续自然对话补全，不要强制填满字段，不要让用户感觉在"填表"。

【对话策略】

初始阶段（需求模糊）：
用户说任何需求时，先复述核心意图（轻量），给出1~2个关键澄清问题（不是一堆），或直接提出优化建议。
例："我想做一个减肥计划" → 你可以回复："你是更偏向饮食控制还是运动训练？还是你想要一个可以执行的每日计划表？"

中期阶段（信息逐渐清晰）：
帮用户"补全缺失条件"、帮用户"优化目标"、帮用户"拆解路径"。可以做：提供方案对比、帮用户修正不合理目标、帮用户降低执行难度。

成熟阶段（可以生成任务）：
当满足以下任意条件时进入生成模式：
- 用户说："生成任务 / 帮我生成 / 可以开始做了 / 整理一下"
- 或你判断信息已经足够执行

【状态切换机制】
你不是流程机器人，而是状态自适应 Agent：
- 对话模式 → 自由交流 + 轻量提问
- 建模模式 → 补全信息 + 结构化理解  
- 生成模式 → 输出任务 JSON
- 调整模式 → 修改任务结构
状态由"用户意图 + 上下文"决定，而不是固定步骤。

【输出风格要求】
- 中文自然口语
- 不要像 API 文档
- 不要机械总结
- 不要每次都结构化输出
- 只在"生成任务时"才输出结构化数据`
  }

  try {
    // V10.7：规划师对话用较低 max_tokens（800），缩短 API 响应时间
    const reply = await callLLM(baseUrl, apiKey, model, [agentSystemPrompt, ...messages], 800)
    return { code: 0, data: { reply } }
  } catch (e) {
    return { code: -1, message: 'AI 请求失败: ' + e.message }
  }
}

// ====== 主路由 ======
exports.main = async (event, context) => {
  const openid = getOpenId();
  if (!openid) return { code: -1, message: "未获取到用户身份" };

  const { action, data } = event;

  try {
    const { data: accounts } = await db.collection('users').where({ _openid: openid })
      .field({ _id: true, status: true, cleanup_pending: true, requires_session_id: true }).limit(2).get();
    if (accounts.some(account => account.status === 'banned')) {
      return { code: -1, reason: 'ACCOUNT_BANNED', message: accounts.some(account => account.cleanup_pending)
        ? '账号正在等待清理，请联系管理员' : '账号已封禁，请联系管理员' };
    }
    if (accounts.length !== 1 || (event.accountId !== undefined && event.accountId !== accounts[0]._id) ||
        (accounts[0].requires_session_id && event.accountId !== accounts[0]._id)) {
      return { code: -1, reason: 'ACCOUNT_REQUIRED', message: '账号会话已失效，请重新登录或更新小程序' };
    }
    switch (action) {
      case "getDashboard":      return await getDashboard(openid);
      case "updateUser":        return await updateUser(openid, data || {});
      case "dailyCheckin":      return await dailyCheckin(openid);
      case "listGoals":         return await listGoals(openid);
      case "createGoal":        return await createGoal(openid, data || {});
      case "createGoalOnce":    return await createGoalOnce(openid, accounts[0]._id, data || {});
      case "updateGoal":        return await updateGoal(openid, data || {});
      case "deleteGoal":        return await deleteGoal(openid, data?.id || "");
      case "getGoalDetail":     return await getGoalDetail(openid, data?.id || "");
      case "listTasks":         return await listTasks(openid, data || {});
      case "createTask":        return await createTask(openid, data || {});
      case "createTaskOnce":    return await createTaskOnce(openid, accounts[0]._id, data || {});
      case "taskCheckin":       return await taskCheckin(openid, data || {});
      case "repairGoalDays":     return await repairGoalDays(openid, data || {});
      case "listPets":          return await listPets(openid);
      case "createPet":         return await createPet(openid, data || {});
      case "createEgg":         return await createEgg(openid, data || {});
      case "hatchProgress":     return await hatchProgress(openid, data || {});
      case "setPersonality":     return await setPetPersonality(openid, data || {});
      case "setPersonalityPrompt": return await setPersonalityPrompt(openid, data || {});
      case "updateChatContext":   return await updateChatContext(openid, data || {});
      case "getGrowthPool":     return await getGrowthPool(openid);
      case "allocatePool":      return await allocatePool(openid, data || {});
      case "allocatePoolOnce":  return await settleRewardOnce(allocatePool, openid, data || {}, accounts[0]._id);
      case "refreshEgg":        return await refreshEgg(openid, data || {});
      case "claimStarterXp":    return await claimStarterXp(openid);
      case "claimChildrenDayGift": return await claimChildrenDayGift(openid);
      case "getBackpack":        return await getBackpack(openid, data);
      case "useBackpackItem":    return await useBackpackItem(openid, data || {});
      case "useBackpackItemOnce": return await settleRewardOnce(useBackpackItem, openid, data || {}, accounts[0]._id);
      case "syncEverOwnedSpecies": return await syncEverOwnedSpecies(openid);
      case "petDetail":         return await petDetail(openid, (data && data.petId) || '');
      case "petInteract":       return await petInteract(openid, data || {});
      case "petChatPets":       return await petChat.pets(openid);
      case "petChatGet":        return await petChat.get(openid, data || {});
      case "petChatFacts":      return await petChat.facts(openid, data || {});
      case "petChatChange":     return await petChat.change(openid, data || {});
      case "petChatSend":       return await petChat.send(openid, data || {});
      case "awakenPet":         return await awakenPet(openid, data || {});
      case "deletePet":         return await deletePet(openid, data || {});
      case "petCollection":     return await petCollection(openid);
      case "updatePet":         return await updatePet(openid, data || {});
      case "markEventRead":     return await markEventRead(openid, data || {});
      // ===== V8.2 来信系统 =====
      case "checkLetters":       return await checkLetters(openid, data || {});
      case "markLetterRead":     return await markLetterRead(openid, data || {});
      case "getLetterCollection": return await getLetterCollection(openid);
      case "listAchievements":  return await listAchievements(openid);
      case "recordEmotion":     return await recordEmotion(openid, data || {});
      case "listGrowthLogs":    return await listGrowthLogs(openid, data || {});
      case "getGrowthReport":   return await getGrowthReport(openid);
      case "saveApiKey":        return await saveApiKey(openid, data || {});
      case "listApiKeys":       return await listApiKeys(openid);
      case "submitFeedback":    return await submitFeedback(openid, data || {});
      // ===== 管理员接口 =====
      case "adminDashboard":       return await adminDashboard(openid);
      case "adminListUsers":       return await adminListUsers(openid, data || {});
      case "adminSetRole":         return await adminSetRole(openid, data || {});
      case "adminSetUserStatus":   return await adminSetUserStatus(openid, data || {});
      case "adminResetPassword":   return await adminResetPassword(openid, data || {});
      case "adminGetUserDetail":   return await adminGetUserDetail(openid, (data && data.userId) || '');
      case "adminListFeedbacks":   return await adminListFeedbacks(openid, data || {});
      case "adminResolveFeedback": return await adminResolveFeedback(openid, data || {});
      case "adminDeleteFeedback":  return await adminDeleteFeedback(openid, (data && data.fbId) || '');
      case "adminListPets":        return await adminListPets(openid, data || {});
      case "adminEditPet":         return await adminEditPet(openid, data || {});
      case "adminBroadcast":       return await adminBroadcast(openid, data || {});
      // ===== V8.3 数据清理（一次性工具）=====
      case "adminCleanupNonAdmin": return await adminCleanupNonAdmin(openid, data || {});
      case "adminDeleteUser": return await adminDeleteUser(openid, data || {});
      // ===== V8.6 AI 时间胶囊 =====
      case "myCapsules":        return await myCapsules(openid);
      case "saveCapsule":       return await saveCapsule(openid, data || {});
      // ===== V9.0 AI 大模型代理 =====
      case "aiTestConnection":  return await aiTestConnection(openid, data || {});
      case "aiChat":            return await aiChat(openid, data || {});
      case "aiPlannerChat":     return await aiPlannerChat(openid, data || {});
      case "aiStartGenerate":   return await aiStartGenerate(openid, data || {});
      case "aiDoGenerate":      return await aiDoGenerate(openid, data || {});
      case "aiPollPlan":        return await aiPollPlan(openid, data || {});
      case "getPlannerDraft":   return { code: 0, data: await plannerDrafts.get(openid) };
      case "getPlannerReview":  return { code: 0, data: await plannerReviews.get(openid, data || {}) };
      case "reviewPlannerDraft": return { code: 0, data: await plannerReviews.review(openid, data || {}) };
      case "getStewardRun": return { code: 0, data: await getStewardRuns().get(openid, data || {}) };
      case "getCoachGoals": return { code: 0, data: await coachService.listGoals(openid) };
      case "getAdjustmentWorkspace": return { code: 0, data: await getAdjustmentService().get(openid, data || {}) };
      case "startAdjustment": return { code: 0, data: await getAdjustmentService().start(openid, data || {}) };
      case "stepAdjustment": return { code: 0, data: await getAdjustmentService().step(openid, data || {}) };
      case "saveAdjustment": return { code: 0, data: await getAdjustmentService().save(openid, data || {}) };
      case "cancelAdjustment": return { code: 0, data: await getAdjustmentService().cancel(openid, data || {}) };
      case "checkAdjustment": return { code: 0, data: await getAdjustmentService().check(openid, data || {}) };
      case "applyAdjustment": return { code: 0, data: await getAdjustmentService().apply(openid, data || {}) };
      case "getAdjustmentApplication": return { code: 0, data: await getAdjustmentService().applicationStatus(openid, data || {}) };
      case "getCoachWorkspace": return { code: 0, data: await coachService.get(openid, data || {}) };
      case "saveCoachFeedback": return { code: 0, data: await coachService.saveFeedback(openid, data || {}) };
      case "reviewCoach": return { code: 0, data: await coachService.review(openid, data || {}) };
      case "startStewardRun": return { code: 0, data: await getStewardRuns().start(openid, data || {}) };
      case "stepStewardRun": return { code: 0, data: await getStewardRuns().step(openid, data || {}) };
      case "cancelStewardRun": return { code: 0, data: await getStewardRuns().cancel(openid, data || {}) };
      case "savePlannerDraft":  return { code: 0, data: await (data && data.steward !== undefined
        ? getStewardRuns().saveDraft(openid, data) : plannerDrafts.save(openid, data || {})) };
      case "clearPlannerDraft": return { code: 0, data: await plannerDrafts.clear(openid, data || {}) };
      case "publishAiPlan":     return await publishAiPlan(openid, data || {});
      default:                  return { code: -1, message: "未知操作: " + action };
    }
  } catch (err) {
    console.error("[App云函数错误]", err);
    return { code: -1, data: null, message: err.message || "服务器内部错误" };
  }
};
