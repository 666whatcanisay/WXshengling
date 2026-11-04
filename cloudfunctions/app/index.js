const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const https = require('https');
const taskRules = require('./lib/taskRules');

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
    return await db.collection(collectionName).add({ data });
  } catch (e) {
    console.warn(`[安全写入] 集合 ${collectionName} 写入失败:`, e.message);
    throw e;
  }
}

async function safeUpdate(collectionName, query, data) {
  // 【诊断】打印最终传给 db.update() 的 data，确认是否被转换为点路径
  var keys = Object.keys(data || {});
  console.log('[SAFEUPDATE-FINAL] 集合=' + collectionName + ' | keys=' + JSON.stringify(keys));
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = data[k];
    console.log('[SAFEUPDATE-FINAL]   ' + k + ': type=' + typeof v + ', isDotPath=' + (k.indexOf('.') >= 0) + ', value=', JSON.stringify(v));
  }
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
  const [users] = await safeQuery("users", { _openid: openid });
  const user = users || {};

  const activeGoals = await safeQuery("goals", { _openid: openid, status: _.neq("deleted") });
  const petsListRaw = await safeQuery("pets", { _openid: openid });
  // 【V8.3修复】过滤已软删除的宠物，避免仪表盘显示幽灵宠物
  const petsList = (petsListRaw || []).filter(p => !p.deleted_at);
  const activePet = petsList[0] || null;

  const today = todayStr();
  const todayTasks = await safeQuery("tasks", { _openid: openid, date: today });
  const completedCount = todayTasks.filter(t => t.completed).length;
  const totalCount = todayTasks.length;
  const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const todayXp = todayTasks.filter(t => t.completed).reduce((s, t) => s + (t.xp_reward || 0), 0);

  const checkins = await safeQuery("checkins", { _openid: openid, date: today });
  const signedIn = checkins.length > 0;

  const achievements = await safeQuery("achievements", { _openid: openid });

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
    goals: activeGoals.map(g => ({ id: g._id, title: g.title, progress: g.progress || 0, emoji: g.emoji || "🎯" })),
    signedIn,
    todayTasks: todayTasks.map(t => ({ id: t._id, title: t.title, completed: t.completed, xp_reward: t.xp_reward })),
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
  const fields = { updated_at: Date.now() };
  if (data.nickname !== undefined) fields.nickname = data.nickname;
  if (data.avatar !== undefined) fields.avatar = data.avatar;
  await safeUpdate("users", { _openid: openid }, fields);
  return { success: true };
}

// ====== 签到 ======
async function dailyCheckin(openid) {
  const today = todayStr();
  const checkins = await safeQuery("checkins", { _openid: openid, date: today });
  if (checkins.length > 0) return { success: true, already_signed: true, message: "今日已签到" };

  const xpReward = 10;
  await safeAdd("checkins", { _openid: openid, date: today, xp_earned: xpReward, created_at: Date.now() });

  const users = await safeQuery("users", { _openid: openid });
  const user = users[0];
  if (user) {
    const yesterday = taskRules.addDays(today, -1);
    const newStreak = user.last_checkin_date === yesterday ? (user.streak_days || 0) + 1 : 1;
    await safeUpdate("users", { _openid: openid }, {
      total_xp: _.inc(xpReward), streak_days: newStreak, last_checkin_date: today, updated_at: Date.now(),
    });

    // ===== 宠物事件：连续签到检查 =====
    if (newStreak === 7 || newStreak === 30) {
      var eventType = newStreak === 30 ? 'streak_30' : 'streak_7';
      var checkinPets = await safeQuery("pets", { _openid: openid });
      var activeCheckinPet = checkinPets.find(function(p) { return p.is_hatched === true && !p.deleted_at; });
      if (activeCheckinPet) {
        checkAndGeneratePetEvent(openid, activeCheckinPet, eventType).catch(function(err) {
          console.warn('[签到事件] 生成失败:', err.message);
        });
      }
    }
  }
  return { success: true, xp_earned: xpReward };
}

// ====== 目标 ======
async function listGoals(openid) {
  const data = await safeQuery("goals", { _openid: openid, status: _.neq("deleted") });
  return { success: true, data: data.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)) };
}

async function createGoal(openid, data) {
  if (!data.title) return { code: -1, message: "目标标题不能为空" };
  const days = taskRules.positiveInteger(data.target_days === undefined ? (data.target_value === undefined ? 30 : data.target_value) : data.target_days);
  const startDate = data.start_date || todayStr();
  if (!days || !taskRules.validDate(startDate)) return { code: -1, message: "目标周期或开始日期不正确" };
  let endDate;
  try { endDate = taskRules.addDays(startDate, days - 1); } catch (e) { return { code: -1, message: "目标周期超出日期范围" }; }
  if (!taskRules.validDate(endDate)) return { code: -1, message: "目标周期超出日期范围" };
  const now = Date.now();
  const res = await safeAdd("goals", {
    _openid: openid, title: data.title, description: data.description || "",
    emoji: data.emoji || "🎯", progress: 0, target_value: days, target_days: days,
    start_date: startDate, end_date: endDate, time_zone: 'Asia/Shanghai',
    stages: Array.isArray(data.stages) ? data.stages.filter(s => s && typeof s === 'object').map(s => ({ name: String(s.name || ''), duration: String(s.duration || ''), milestone: String(s.milestone || '') })) : [],
    current_value: 0, unit: data.unit || "", status: "active", created_at: now, updated_at: now,
  });
  // 【V8.5修复】创建目标后自动生成当天任务，解决目标页 todayTasks 永远为空的问题
  const goalId = res._id;
  console.log('[GOAL-CREATE] goal res=', JSON.stringify(res));
  if (data.create_initial_task !== false) {
    await safeAdd("tasks", {
      _openid: openid,
      goal_id: goalId,
      title: data.title,
      completed: false,
      xp_reward: 10,
      date: startDate,
      created_at: now,
      updated_at: now,
    });
    console.log('[TASK-CREATE] task created, goal_id=', goalId);
  }
  return { success: true, id: goalId };
}

async function updateGoal(openid, data) {
  if (!data.id) return { code: -1, message: "缺少目标ID" };
  const fields = { updated_at: Date.now() };
  ["title", "description", "emoji", "progress", "current_value", "status"].forEach(k => {
    if (data[k] !== undefined) fields[k] = data[k];
  });
  await safeUpdate("goals", { _id: data.id, _openid: openid }, fields);
  return { success: true };
}

async function deleteGoal(openid, id) {
  await safeUpdate("goals", { _id: id, _openid: openid }, { status: "deleted", updated_at: Date.now() });
  return { success: true };
}

async function getGoalDetail(openid, id) {
  const data = await safeQuery("goals", { _id: id });
  if (!data[0] || data[0]._openid !== openid) return { code: -1, message: "目标不存在" };
  return { success: true, data: data[0] };
}

// ====== 任务 ======
async function queryTasks(filter) {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.collection('tasks').where(filter).skip(offset).limit(100).get();
    const rows = page.data || [];
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}

async function listTasks(openid, params) {
  const options = typeof params === 'string' ? { date: params } : (params || {});
  const queryDate = options.date || todayStr();
  if (!taskRules.validDate(queryDate)) return { code: -1, message: "任务日期不正确" };
  const filter = { _openid: openid, date: queryDate };
  if (options.goal_id) filter.goal_id = options.goal_id;
  const data = await queryTasks(filter);
  return { success: true, data: data.map(t => ({ id: t._id, title: t.title, completed: t.completed,
    xp_reward: t.xp_reward, goal_id: t.goal_id, date: t.date, stage: t.stage,
    estimated_minutes: t.estimated_minutes, completed_at: t.completed_at })) };
}

async function createTask(openid, data) {
  if (!data.title) return { code: -1, message: "任务标题不能为空" };
  const date = data.date || todayStr();
  if (!taskRules.validDate(date)) return { code: -1, message: "任务日期不正确" };
  const minutes = data.estimated_minutes === undefined ? null : taskRules.positiveInteger(data.estimated_minutes);
  if (data.estimated_minutes !== undefined && (!minutes || minutes > 1440)) return { code: -1, message: "任务时长需为1至1440分钟" };
  if (data.stage !== undefined && !['string', 'number'].includes(typeof data.stage)) return { code: -1, message: "任务阶段不正确" };
  if (data.goal_id) {
    const goals = await safeQuery('goals', { _id: data.goal_id, _openid: openid });
    const goal = goals[0];
    if (!goal || goal.status === 'deleted') return { code: -1, message: "目标不存在" };
    if ((goal.start_date && date < goal.start_date) || (goal.end_date && date > goal.end_date)) return { code: -1, message: "任务日期超出目标周期" };
  }
  const scheduling = {};
  if (minutes !== null) scheduling.estimated_minutes = minutes;
  if (data.stage !== undefined) scheduling.stage = data.stage;
  const res = await safeAdd("tasks", {
    _openid: openid, title: data.title, goal_id: data.goal_id || "",
    xp_reward: data.xp_reward || 10, completed: false, date, ...scheduling,
    created_at: Date.now(), updated_at: Date.now(),
  });
  return { success: true, id: res._id };
}

// 核心奖励原子结算；事务外只定位旧随机 ID，结算依据均在事务内重读。
async function taskCheckin(openid, data) {
  if (typeof data.task_id !== 'string' || !data.task_id) return { code: -1, message: "缺少任务ID" };
  if (!openid) return { code: -1, message: "未登录" };
  // 仅本流程允许 doc.get 返回 null，不改变其它接口的缺失文档行为。
  const checkinDb = cloud.database({ throwOnNotFound: false });
  // 不能用吞错的 safeQuery：读取失败不等于用户/成长池不存在。
  const [userRows, poolRows] = await Promise.all([
    checkinDb.collection("users").where({ _openid: openid }).limit(2).get(),
    checkinDb.collection("user_growth_pool").where({ _openid: openid }).limit(2).get(),
  ]);
  if (userRows.data.length !== 1) return { code: -1, message: "用户记录异常，请重新登录或联系管理员" };
  if (poolRows.data.length > 1) return { code: -1, message: "成长池记录重复，请联系管理员" };
  const userId = userRows.data[0]._id;
  const legacyPool = poolRows.data[0];
  const poolId = legacyPool ? legacyPool._id : 'pool:' + openid;
  const settlement = await checkinDb.runTransaction(async tx => {
    const task = (await tx.collection("tasks").doc(data.task_id).get()).data;
    if (!task || task._openid !== openid) return { code: -1, message: "任务不存在" };
    if (task.date && task.date > todayStr()) return { code: -1, message: "未来任务请到当天再打卡" };
    if (task.completed) return { success: true, already_completed: true, xp_earned: 0, message: "任务已完成" };
    const user = (await tx.collection("users").doc(userId).get()).data;
    const pool = (await tx.collection("user_growth_pool").doc(poolId).get()).data;
    if (!user || user._openid !== openid) throw new Error("用户记录已变更，请刷新后重试");
    if ((pool && pool._openid !== openid) || (legacyPool && !pool)) throw new Error("成长池记录已变更，请刷新后重试");
    const xpReward = task.xp_reward || 10;
    if (!Number.isFinite(xpReward) || xpReward < 0) throw new Error("任务奖励异常");
    const now = Date.now();
    const updateOne = async (name, id, patch) => {
      const res = await tx.collection(name).doc(id).update({ data: patch });
      if (!res.stats || res.stats.updated !== 1) throw new Error("结算记录未更新: " + name);
    };
    await updateOne("tasks", task._id, { completed: true, completed_at: now, updated_at: now });
    await updateOne("users", userId, { total_xp: _.inc(xpReward), updated_at: now });
    // wx-server-sdk 只转交 options.data，自定义 _id 必须在 data 内。
    await tx.collection("growth_logs").add({ data: {
      _id: 'checkin-log:' + task._id, _openid: openid, xp_change: xpReward,
      reason: '完成任务: ' + task.title, source: "task", created_at: now, updated_at: now,
    }});
    if (pool) {
      await updateOne("user_growth_pool", poolId, {
        growth_pool: _.inc(xpReward), total_earned: _.inc(xpReward), updated_at: now,
      });
    } else {
      await tx.collection("user_growth_pool").add({ data: {
        _id: poolId, _openid: openid, growth_pool: xpReward, total_earned: xpReward,
        created_at: now, updated_at: now,
      }});
    }
    return { success: true, xp_earned: xpReward, goal_id: task.goal_id, date: task.date };
  });
  if (!settlement.success || settlement.already_completed) return settlement;
  // 派生统计在核心结算后幂等修复；不把它的失败当成奖励回滚。
  let completedDays;
  try {
    if (settlement.goal_id && (!settlement.date || settlement.date === todayStr())) {
      const result = await repairGoalDays(openid, { goal_id: settlement.goal_id });
      if (result.success) completedDays = result.completed_days;
    }
  } catch (e) { console.warn('[TASK-CHECKIN] 更新目标天数失败（非致命）:', e.message); }
  const result = { success: true, xp_earned: settlement.xp_earned };
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
  const data = await safeQuery("pets", { _openid: openid });
  // 【V8.3修复】过滤已软删除的宠物（deleted_at存在），避免释放后的宠物重新出现在列表
  const activeData = data.filter(p => !p.deleted_at);
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
  const exist = await safeQuery("pets", { _openid: openid });
  // 只统计未删除且非已释放的
  const activeCount = exist.filter(p => !p.deleted_at).length;
  if (activeCount >= 3) return { code: -1, message: "最多拥有3只宠物" };
  const hasEgg = exist.find(p => p.is_hatched === false && !p.deleted_at);
  if (hasEgg) return { code: -1, message: "已有正在孵化的蛋" };

  // 确定蛋类型：传入的 或 随机
  var eggTypeKeys = Object.keys(EGG_TYPES);
  var eggType = (data && data.egg_type && EGG_TYPES[data.egg_type])
    ? data.egg_type
    : eggTypeKeys[Math.floor(Math.random() * eggTypeKeys.length)];

  var eggInfo = EGG_TYPES[eggType];

  const res = await safeAdd("pets", {
    _openid: openid,
    name: eggInfo.name || '神秘成长蛋',
    stage: "egg",
    egg_stage: "egg",
    level: 1,
    experience: 0,
    species: "",
    egg_type: eggType,
    growth_value: 0,          // V6: 使用 growth_value 替代 hatch_progress
    is_hatched: false,
    rarity: 'unknown',
    attributes: {},           // 【V8.3修复】初始化为空对象，避免MongoDB对null写子属性崩溃
    bond: 0,
    mood: 'sleepy',
    mood_message: '正在沉睡中...',
    awakened: false,
    personality: '',
    titles: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  return { success: true, id: res._id, egg_type: eggType, egg_name: eggInfo.name };
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
async function hatchProgress(openid, data) {
  // 【安全】确保集合存在
  await ensureCollection("user_growth_pool");

  var source = (data && data.source) || 'checkin';
  var addValue = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].value) || 5;

  // ===== P1：统一入池 =====
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var poolRecord = pool[0];
  if (!poolRecord) {
    poolRecord = await safeAdd("user_growth_pool", {
      _openid: openid,
      growth_pool: 0,
      total_earned: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    poolRecord = { growth_pool: 0 };
  }

  // 池子增加
  var newPoolValue = (poolRecord.growth_pool || 0) + addValue;
  await safeUpdate("user_growth_pool", { _openid: openid }, {
    growth_pool: newPoolValue,
    total_earned: (poolRecord.total_earned || 0) + addValue,
    updated_at: Date.now(),
  });

  // ===== 获取当前宠物 =====
  const pets = await safeQuery("pets", { _openid: openid });
  // 优先找未孵化的蛋，否则找已孵化宠物继续成长
  var egg = pets.find(p => p.is_hatched === false && !p.deleted_at);
  var activePet = egg || pets.find(p => p.is_hatched === true && !p.deleted_at);

  if (!activePet) {
    // 没有任何宠物，仅入池
    var srcLabel = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].label) || '成长';
    return { success: true, pool_only: true, pool_value: newPoolValue, added: addValue, message: srcLabel + ' +' + addValue + '，已存入成长池' };
  }

  var isEgg = !(activePet.is_hatched === true);
  var oldGrowth = activePet.growth_value || 0;

  // ===== 从池子消费到宠物 =====
  var consumeValue = Math.min(addValue, newPoolValue); // 最多消费本次获得的量
  var newValue = oldGrowth + consumeValue;
  var remainingPool = newPoolValue - consumeValue;

  // 更新池子剩余
  await safeUpdate("user_growth_pool", { _openid: openid }, {
    growth_pool: Math.max(0, remainingPool),
    updated_at: Date.now(),
  });

  // ===== 孵化逻辑（蛋 → 幼年）— V8.2：统一调用 performPetHatch() =====
  if (isEgg && newValue >= 100) {
    newValue = 100; // 蛋阶段最大100
    var hatchData = performPetHatch(activePet.egg_type || 'forest_egg');

    // 【V8.4诊断】临时恢复为 safeUpdate，验证新蛋(attributes:{})是否仍报错
    await safeUpdate("pets", { _id: activePet._id }, hatchData.updateFields);

    // 成长日志记录（孵化特有）
    await safeAdd("growth_logs", {
      _openid: openid, xp_change: 0,
      reason: '🎉 蛋孵化了！获得了【' + (hatchData.rarityText[hatchData.result.rarity] || '') + hatchData.result.name + '】',
      source: "hatch", created_at: Date.now(),
    });

    var tags = hatchData.buildDisplayTags();
    return {
      success: true,
      hatched: true,
      pet: { id: activePet._id, ...hatchData.result, is_shiny: hatchData.result.is_shiny },
      stage_up: { from: 'EGG', to: 'BABY', name: '幼年' },
      need_personality: true,
      message: '恭喜！你的蛋孵化成了' + (hatchData.rarityText[hatchData.result.rarity] || '') + hatchData.result.name +
        tags.colorTag + tags.talentTag + '！进入幼年期',
    };
  }

  // ===== 已孵化宠物的成长逻辑（支持跨阶段）=====
  if (!isEgg) {
    var newStageInfo = getGrowthStage(newValue);
    var oldStageInfo = getGrowthStage(oldGrowth);
    var stageUpResult = null;

    // 检查是否跨阶段
    if (oldStageInfo.key !== newStageInfo.key) {
      stageUpResult = {
        from: oldStageInfo.key,
        to: newStageInfo.key,
        name: newStageInfo.name,
        // P3：生成四维属性随机奖励
        attrBonus: generateStageUpBonus(),
      };

      // 累加属性奖励到宠物
      // 【V8.3修复】attributes可能为null（旧数据），MongoDB不允许对null写子属性
      var currentAttrs = activePet.attributes;
      if (!currentAttrs || typeof currentAttrs !== 'object' || Array.isArray(currentAttrs)) {
        currentAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
      }
      var newAttrs = {};
      Object.keys(stageUpResult.attrBonus).forEach(function(key) {
        newAttrs[key] = (currentAttrs[key] || 0) + stageUpResult.attrBonus[key];
      });

      // 【V8.3修复2】growth_records可能为null，_.push对null会报错，改为整体替换
      var currentGrowthRecords2 = activePet.growth_records;
      if (!currentGrowthRecords2 || !Array.isArray(currentGrowthRecords2)) {
        currentGrowthRecords2 = [];
      }
      await safeUpdate("pets", { _id: activePet._id }, {
        growth_value: newValue,
        stage: newStageInfo.key,
        attributes: newAttrs,
        growth_records: currentGrowthRecords2.concat({
          time: Date.now(),
          stage: newStageInfo.key,
          message: '成长为【' + newStageInfo.name + '】',
        }),
        updated_at: Date.now(),
      });

      // 记录成长日志
      var attrText = Object.keys(stageUpResult.attrBonus).map(function(k) {
        var labels = { vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' };
        return (labels[k] || k) + '+' + stageUpResult.attrBonus[k];
      }).join(' ');
      await safeAdd("growth_logs", {
        _openid: openid, xp_change: 0,
        reason: '⬆️ 成长升级：' + oldStageInfo.name + ' → ' + newStageInfo.name + '（' + attrText + '）',
        source: "stage_up", created_at: Date.now(),
      });

      // ===== 宠物事件：跨阶段检查 =====
      if (newStageInfo.key === 'ADULT') {
        checkAndGeneratePetEvent(openid, activePet, 'reach_adult').catch(function(err) {
          console.warn('[成长事件] reach_adult 生成失败:', err.message);
        });
      }
      if (newStageInfo.key === 'PERFECT') {
        checkAndGeneratePetEvent(openid, activePet, 'reach_perfect').catch(function(err) {
          console.warn('[成长事件] reach_perfect 生成失败:', err.message);
        });
      }

      var srcLabel = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].label) || '成长';
      return {
        success: true,
        progress: newValue,
        stage: newStageInfo.key,
        stage_name: newStageInfo.name,
        stage_up: stageUpResult,
        growth_source: source,
        added_value: consumeValue,
        attr_bonus: stageUpResult.attrBonus,
        pool_remaining: Math.max(0, remainingPool),
        need_personality_prompt: true,  // P4: 需要用户输入性格期望
        message: srcLabel + ' +' + consumeValue + '，🎉 升级为【' + newStageInfo.name + '】！' + attrText,
      };
    }

    // 未跨阶段，正常增加成长值
    await safeUpdate("pets", { _id: activePet._id }, {
      growth_value: newValue,
      updated_at: Date.now(),
    });

    var srcLabel2 = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].label) || '成长';
    return {
      success: true,
      progress: newValue,
      stage: newStageInfo.key,
      stage_name: newStageInfo.name,
      growth_source: source,
      added_value: consumeValue,
      pool_remaining: Math.max(0, remainingPool),
      message: srcLabel2 + ' +' + consumeValue + '，当前阶段【' + newStageInfo.name + '】' + newValue + '/' + newStageInfo.minGrowth,
    };
  }

  // ===== 蛋未孵化，正常增加 =====
  var newEggStage = getEggStage(newValue);
  await safeUpdate("pets", { _id: activePet._id }, {
    growth_value: newValue,
    egg_stage: newEggStage,
    updated_at: Date.now(),
  });

  var srcLabel3 = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].label) || '成长';
  return {
    success: true,
    progress: newValue,
    egg_stage: newEggStage,
    growth_source: source,
    added_value: consumeValue,
    pool_remaining: Math.max(0, remainingPool),
    message: srcLabel3 + ' +' + consumeValue + '，孵化进度 ' + newValue + '/100',
  };
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
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  if (pool && pool[0]) {
    return {
      success: true,
      growth_pool: pool[0].growth_pool || 0,
      total_earned: pool[0].total_earned || 0,
    };
  }
  // 没有池子记录时返回默认值（首次使用会自动创建）
  return { success: true, growth_pool: 0, total_earned: 0 };
}

/**
 * 【泉水系统】从经验池分配经验到指定宠物
 * data: { pet_id: string, amount: number }  (amount=0 表示全部倒入)
 *
 * 流程：校验池子余额 → 校验宠物归属 → 扣减池子 → 增加growth_value → 检查跨阶段
 */
async function allocatePool(openid, data) {
  console.log('[ALLOCATE-DEBUG] ===== 开始分配 =====');
  console.log('[ALLOCATE-DEBUG] data.pet_id=', data.pet_id);
  console.log('[ALLOCATE-DEBUG] data.amount=', data.amount);

  // 【安全】确保集合存在
  await ensureCollection("user_growth_pool");

  if (!data.pet_id) return { code: -1, message: "请选择目标宠物" };

  // 1. 获取池子
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  if (!pool || !pool[0]) return { code: -1, message: "经验池不存在" };
  var poolValue = pool[0].growth_pool || 0;
  if (poolValue <= 0) return { code: -1, message: "经验池是空的，先去签到或完成任务吧" };

  // 2. 获取目标宠物（必须属于当前用户）
  var targetPets = await safeQuery("pets", { _id: data.pet_id, _openid: openid });
  if (!targetPets || !targetPets[0]) return { code: -1, message: "目标宠物不存在" };
  var pet = targetPets[0];

  // 3. 计算分配数量
  var amount = parseInt(data.amount) || 0;
  if (amount <= 0) amount = poolValue; // 全部倒入
  if (amount > poolValue) amount = poolValue; // 不能超过余额

  var oldGrowth = pet.growth_value || 0;
  var newGrowth = oldGrowth + amount;
  var remainingPool = poolValue - amount;

  console.log('[ALLOCATE-DEBUG] oldGrowth=' + oldGrowth + ' newGrowth=' + newGrowth + ' amount=' + amount);
  console.log('[ALLOCATE-DEBUG] pet.is_hatched=' + pet.is_hatched);
  console.log('[ALLOCATE-DEBUG] pet.attributes type=' + typeof pet.attributes);
  console.log('[ALLOCATE-DEBUG] pet.attributes value=', JSON.stringify(pet.attributes));

  // 4. 更新池子（先扣）
  console.log('[ALLOCATE-DEBUG] >>> safeUpdate #1: user_growth_pool');
  console.log('[ALLOCATE-DEBUG]     data keys:', Object.keys({ growth_pool: remainingPool, updated_at: Date.now() }));
  await safeUpdate("user_growth_pool", { _openid: openid }, {
    growth_pool: remainingPool,
    updated_at: Date.now(),
  });

  // 5. 更新宠物 + 孵化优先级检查（V8.2修复：孵化 > 阶段升级）
  var newStageInfo = getGrowthStage(newGrowth);
  var oldStageInfo = getGrowthStage(oldGrowth);

  // ===== V8.2 P0修复：孵化优先级最高 =====
  // 只要蛋的 growth_value 从 <100 跨到 >=100，必须先孵化，再考虑阶段升级
  // 原Bug：跨阶段检查在L1508先执行，return后L1574的孵化永远无法到达
  if (pet.is_hatched === false && newGrowth >= 100) {
    console.log('[ALLOCATE-DEBUG] >>> 进入孵化分支 (newGrowth=' + newGrowth + ' >= 100)');
    // 【V8.4修复说明】不再需要预清理 attributes:{} 
    // 原因: 微信云SDK将{attributes:{}}视为空$set而报错
    // 但performPetHatch()的updateFields已包含完整的非空attributes对象
    // MongoDB整字段替换(null→{vitality:3,...})不会报错(只有子路径写入才报错)

    var allocHatchData = performPetHatch(pet.egg_type || 'forest_egg');
    // 触发诊断日志
    if (allocHatchData._debug !== undefined) { /* 触发getter */ }

    console.log('[ALLOCATE-DEBUG] >>> performPetHatch 返回');
    console.log('[ALLOCATE-DEBUG]     updateFields keys:', Object.keys(allocHatchData.updateFields));
    console.log('[ALLOCATE-DEBUG]     updateFields JSON:', JSON.stringify(allocHatchData.updateFields, null, 2));
    console.log('[ALLOCATE-DEBUG] >>> safeUpdate #3: 孵化写入 (诊断：恢复safeUpdate测试)');
    await safeUpdate("pets", { _id: data.pet_id }, allocHatchData.updateFields);
    console.log('[ALLOCATE-DEBUG]     safeUpdate #3 完成');

    // V8.2补充：allocatePool 也记录成长日志
    await safeAdd("growth_logs", {
      _openid: openid, xp_change: 0,
      reason: '💧 泉水灌注使蛋孵化了！获得了【' + (allocHatchData.rarityText[allocHatchData.result.rarity] || '') + allocHatchData.result.name + '】',
      source: "hatch_pool", created_at: Date.now(),
    });

    var tags2 = allocHatchData.buildDisplayTags();
    return {
      success: true, allocated: amount, pool_remaining: remainingPool,
      hatched: true, pet: { id: data.pet_id, ...allocHatchData.result, is_shiny: allocHatchData.result.is_shiny },
      need_personality: true,
      message: '💧 泉水灌注使蛋孵化了！获得了【' + (allocHatchData.rarityText[allocHatchData.result.rarity] || '') + allocHatchData.result.name +
        tags2.colorTag + tags2.talentTag + '】',
    };
  }

  // ===== 已孵化宠物的阶段升级检查（仅对非蛋生效）=====
  var stageUpResult = null;
  var updateFields = {
    growth_value: newGrowth,
    updated_at: Date.now(),
  };

  // 跨阶段检查（此时已确认 pet 不是蛋，或虽是蛋但 newGrowth < 100）
  if (oldStageInfo.key !== newStageInfo.key) {
    stageUpResult = {
      from: oldStageInfo.key,
      to: newStageInfo.key,
      name: newStageInfo.name,
      attrBonus: generateStageUpBonus(),
    };

    // 累加属性奖励
    // 【V8.3修复】attributes可能为null，MongoDB不允许对null字段写子属性，必须先初始化为对象
    var currentAttrs = pet.attributes;
    if (!currentAttrs || typeof currentAttrs !== 'object' || Array.isArray(currentAttrs)) {
      currentAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
    }
    var newAttrs = {};
    Object.keys(stageUpResult.attrBonus).forEach(function(key) {
      newAttrs[key] = (currentAttrs[key] || 0) + stageUpResult.attrBonus[key];
    });
    updateFields.stage = newStageInfo.key;
    updateFields.attributes = newAttrs;
    // 【V8.3修复2】growth_records可能为null，_.push对null会报错，改为整体替换
    var currentGrowthRecords = pet.growth_records;
    if (!currentGrowthRecords || !Array.isArray(currentGrowthRecords)) {
      currentGrowthRecords = [];
    }
    updateFields.growth_records = currentGrowthRecords.concat({
      time: Date.now(),
      stage: newStageInfo.key,
      message: '💧 泉水灌注成长为【' + newStageInfo.name + '】',
    });

    console.log('[ALLOCATE-DEBUG] >>> safeUpdate #4: 阶段升级写入');
    console.log('[ALLOCATE-DEBUG]     updateFields keys:', Object.keys(updateFields));
    await safeUpdate("pets", { _id: data.pet_id }, updateFields);
    console.log('[ALLOCATE-DEBUG]     safeUpdate #4 完成');

    // 成长日志
    var attrText = Object.keys(stageUpResult.attrBonus).map(function(k) {
      var labels = { vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' };
      return (labels[k] || k) + '+' + stageUpResult.attrBonus[k];
    }).join(' ');
    await safeAdd("growth_logs", {
      _openid: openid, xp_change: 0,
      reason: '💧 泉水灌注：' + oldStageInfo.name + ' → ' + newStageInfo.name + '（' + attrText + '）',
      source: "fountain_allocate",
      created_at: Date.now(),
    });

    // ===== 宠物事件：泉水灌注跨阶段检查 =====
    if (newStageInfo.key === 'ADULT') {
      checkAndGeneratePetEvent(openid, pet, 'reach_adult').catch(function(err) {
        console.warn('[成长事件] reach_adult 生成失败:', err.message);
      });
    }
    if (newStageInfo.key === 'PERFECT') {
      checkAndGeneratePetEvent(openid, pet, 'reach_perfect').catch(function(err) {
        console.warn('[成长事件] reach_perfect 生成失败:', err.message);
      });
    }

    return {
      success: true,
      allocated: amount,
      pool_remaining: remainingPool,
      pet_new_growth: newGrowth,
      stage: newStageInfo.key,
      stage_name: newStageInfo.name,
      stage_up: stageUpResult,
      attr_bonus: stageUpResult.attrBonus,
      need_personality_prompt: true,  // P4: 需要用户输入性格期望
      message: '💧 灌注 +' + amount + '，升级为【' + newStageInfo.name + '】！' + attrText,
    };
  }

  // 未跨阶段，正常增加
  console.log('[ALLOCATE-DEBUG] >>> safeUpdate #5: 正常增加写入');
  console.log('[ALLOCATE-DEBUG]     updateFields keys:', Object.keys(updateFields));
  await safeUpdate("pets", { _id: data.pet_id }, updateFields);
  console.log('[ALLOCATE-DEBUG]     safeUpdate #5 完成');

  return {
    success: true,
    allocated: amount,
    pool_remaining: remainingPool,
    pet_new_growth: newGrowth,
    stage: newStageInfo.key,
    stage_name: newStageInfo.name,
    message: '💧 灌入 +' + amount + ' 点经验，当前【' + newStageInfo.name + '】' + newGrowth + '/' + newStageInfo.minGrowth,
  };
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
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };

  // 获取目标宠物
  var pets = await safeQuery("pets", { _id: data.pet_id, _openid: openid });
  if (!pets || !pets[0]) return { code: -1, message: "宠物不存在" };
  // 【V8.3修复】排除已软删除的宠物
  var pet = pets[0];
  if (pet.deleted_at) return { code: -1, message: "该宠物已释放" };

  // 必须是未孵化的蛋
  if (pet.is_hatched === true) return { code: -1, message: "已孵化的宠物不能更换蛋类型哦" };

  // 确定新蛋类型
  var allEggTypes = Object.keys(EGG_TYPES);
  var currentType = pet.egg_type || 'forest_egg';
  var newType = data.target_egg_type;

  if (newType && EGG_TYPES[newType]) {
    // 指定了目标类型
    if (newType === currentType) {
      return { code: -1, message: "当前就是这个类型哦～换一个吧" };
    }
  } else {
    // 随机切换（排除当前）
    var otherTypes = allEggTypes.filter(function(t) { return t !== currentType; });
    newType = otherTypes[Math.floor(Math.random() * otherTypes.length)];
  }

  var eggInfo = EGG_TYPES[newType];

  await safeUpdate("pets", { _id: data.pet_id }, {
    egg_type: newType,
    updated_at: Date.now(),
  });

  return {
    success: true,
    new_egg_type: newType,
    new_egg_name: eggInfo.name,
    new_egg_color: eggInfo.color,
    new_egg_emoji: eggInfo.emoji,
    message: '🔄 已更换为【' + eggInfo.name + '】！',
  };
}

/**
 * 【新手礼包】领取800点初始经验
 * 每个用户只能领取一次
 */
async function claimStarterXp(openid) {
  // 【安全】确保集合存在
  await ensureCollection("user_growth_pool");

  // 检查是否已领取
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var poolRecord = pool && pool[0];
  var hasClaimed = false;
  if (poolRecord) {
    hasClaimed = !!(poolRecord.starter_claimed || poolRecord.starter_claimed_at);
  }

  if (hasClaimed) {
    return { code: -1, message: "已经领取过新手经验了哦～", already_claimed: true };
  }

  // 发放800点
  var bonusAmount = 800;

  if (poolRecord) {
    // 更新现有池子
    var newValue = (poolRecord.growth_pool || 0) + bonusAmount;
    await safeUpdate("user_growth_pool", { _openid: openid }, {
      growth_pool: newValue,
      total_earned: (poolRecord.total_earned || 0) + bonusAmount,
      starter_claimed: true,
      starter_claimed_at: Date.now(),
      updated_at: Date.now(),
    });
  } else {
    // 创建池子记录并发放
    await safeAdd("user_growth_pool", {
      _openid: openid,
      growth_pool: bonusAmount,
      total_earned: bonusAmount,
      starter_claimed: true,
      starter_claimed_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  }

  // 记录日志
  await safeAdd("growth_logs", {
    _openid: openid,
    xp_change: 0,
    reason: '🎁 新手礼包：获得 ' + bonusAmount + ' 点初始经验',
    source: "starter_bonus",
    created_at: Date.now(),
  });

  return {
    success: true,
    claimed_amount: bonusAmount,
    total_pool: bonusAmount,
    message: '🎁 领取成功！+' + bonusAmount + ' 点经验已存入泉水',
  };
}

// ===== 儿童节礼包 + 背包云端持久化（V10.4）=====

/** 儿童节礼包：每人一次，送各20个道具 */
async function claimChildrenDayGift(openid) {
  await ensureCollection("user_growth_pool");

  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var poolRecord = pool && pool[0];

  // 检查是否已领取（兼容两种标记）
  if (poolRecord && (poolRecord.children_day_claimed || poolRecord.children_day_claimed_at)) {
    return { code: -1, message: "已经领取过儿童节礼包了哦～", already_claimed: true };
  }

  // 礼包内容：每种道具 x20
  var giftBackpack = [
    { name: '普通饲料', count: 20 },
    { name: '高级饲料', count: 20 },
    { name: '成长药水', count: 20 },
    { name: '补签卡', count: 20 },
  ];

  if (poolRecord) {
    // 合并到现有背包
    var existing = poolRecord.backpack || [];
    for (var i = 0; i < giftBackpack.length; i++) {
      var gift = giftBackpack[i];
      var found = existing.find(function(e) { return e.name === gift.name; });
      if (found) found.count += gift.count;
      else existing.push({ name: gift.name, count: gift.count });
    }
    await safeUpdate("user_growth_pool", { _openid: openid }, {
      backpack: existing,
      children_day_claimed: true,
      children_day_claimed_at: Date.now(),
      updated_at: Date.now(),
    });
  } else {
    await safeAdd("user_growth_pool", {
      _openid: openid,
      growth_pool: 0,
      total_earned: 0,
      backpack: giftBackpack,
      children_day_claimed: true,
      children_day_claimed_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  }

  return { success: true, backpack: giftBackpack, message: '🎈 儿童节快乐！道具x20 已放入背包' };
}

/** 获取当前背包（从云端同步） */
async function getBackpack(openid) {
  await ensureCollection("user_growth_pool");
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var record = pool && pool[0];
  if (!record || !record.backpack) return null;
  return record.backpack;
}

/** 获取/同步历史拥有物种（V10.5：图鉴永久解锁）*/
async function syncEverOwnedSpecies(openid, data) {
  await ensureCollection("user_growth_pool");
  var currentSpecies = (data && data.speciesList) || [];
  if (!Array.isArray(currentSpecies)) currentSpecies = [];

  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var record = pool && pool[0];

  // 历史记录
  var everOwned = (record && record.all_ever_owned_species)
    ? JSON.parse(JSON.stringify(record.all_ever_owned_species))
    : [];

  // 合并：追加新物种（去重）
  var everSet = {};
  everOwned.forEach(function(s) { everSet[s] = true; });
  var added = 0;
  for (var i = 0; i < currentSpecies.length; i++) {
    if (currentSpecies[i] && !everSet[currentSpecies[i]]) {
      everOwned.push(currentSpecies[i]);
      everSet[currentSpecies[i]] = true;
      added++;
    }
  }

  // 写回云端
  if (added > 0 || !record) {
    var updateData = { all_ever_owned_species: everOwned, updated_at: Date.now() };
    if (record) {
      await safeUpdate("user_growth_pool", { _openid: openid }, updateData);
    } else {
      await safeAdd("user_growth_pool", {
        _openid: openid,
        growth_pool: 0,
        total_earned: 0,
        all_ever_owned_species: everOwned,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }
  }

  return { success: true, all_ever_owned_species: everOwned, added: added };
}

/** 使用物品（云端扣减，返回新背包状态） */
async function useBackpackItem(openid, data) {
  if (!data.itemName) return { code: -1, message: "缺少物品名" };

  await ensureCollection("user_growth_pool");
  var pool = await safeQuery("user_growth_pool", { _openid: openid });
  var record = pool && pool[0];

  // 没有记录 → 用默认背包初始化（兼容老用户）
  var backpack = (record && record.backpack)
    ? JSON.parse(JSON.stringify(record.backpack))
    : [
        { name: '普通饲料', count: 3 },
        { name: '高级饲料', count: 1 },
        { name: '成长药水', count: 0 },
        { name: '补签卡', count: 1 },
      ];

  var target = backpack.find(function(item) { return item.name === data.itemName; });
  if (!target || target.count <= 0) {
    return { code: -1, message: "物品数量不足" };
  }

  target.count -= 1;

  if (record) {
    await safeUpdate("user_growth_pool", { _openid: openid }, {
      backpack: backpack,
      updated_at: Date.now(),
    });
  } else {
    // 首次使用但没有记录 → 创建记录
    await safeAdd("user_growth_pool", {
      _openid: openid,
      growth_pool: 0,
      total_earned: 0,
      backpack: backpack,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  }

  return { success: true, backpack: backpack };
}

/** 宠物互动（V3：含反馈文案 + bond增加 + mood变化） */
async function petInteract(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  const action = data.action || 'pet'; // feed / play / pet
  const xpMap = { feed: 10, play: 15, pet: 5 };
  const bondMap = { feed: 2, play: 4, pet: 3 };
  const xp = xpMap[action] || 5;
  const bondAdd = bondMap[action] || 2;

  const pets = await safeQuery("pets", { _openid: openid });
  // 【V8.3修复】排除已软删除的宠物
  const pet = pets.find(p => p._id === data.pet_id && p.is_hatched === true && !p.deleted_at);
  if (!pet) return { code: -1, message: "宠物不存在或未孵化" };

  // 获取反馈文案
  const feedback = getInteractionFeedback(action, pet.species);

  // 更新 XP 和亲密度
  const newExp = (pet.experience || 0) + xp;
  let newBond = Math.min(1000, (pet.bond || 0) + bondAdd);

  // 阶段升级检测
  let newStage = pet.stage;
  let newLevel = pet.level || 1;
  if (pet.stage === 'BABY' && newExp >= 300) {
    newStage = 'ADULT';
    newLevel++;
  } else {
    const stageMaxXp = newStage === 'ADULT' ? 9999 : 300;
    if (newExp >= stageMaxXp) { newLevel++; }
  }

  // 心情变化：互动后倾向于 happy/exited
  const moodPool = ['excited', 'happy', 'happy', 'normal'];
  const newMood = moodPool[Math.floor(Math.random() * moodPool.length)];
  const newMoodMsg = pickMoodMessage(newMood);

  await safeUpdate("pets", { _id: data.pet_id }, {
    experience: newExp, level: newLevel, stage: newStage,
    bond: newBond, mood: newMood, mood_message: newMoodMsg,
    updated_at: Date.now(),
  });

  // 记录成长日志
  const actionNames = { feed: '喂食', play: '玩耍', pet: '抚摸' };
  await safeAdd("growth_logs", {
    _openid: openid, xp_change: xp,
    reason: `${actionNames[action] || '互动'} ${feedback}`,
    source: `interact_${action}`, created_at: Date.now(),
  });

  const bondLv = getBondLevel(newBond);
  return {
    success: true,
    xp_earned: xp,
    bond_added: bondAdd,
    new_bond: newBond,
    bond_level: bondLv,
    feedback,
    mood: newMood,
    mood_message: newMoodMsg,
    level_up: newLevel > (pet.level || 1),
    new_level: newLevel,
    stage_changed: newStage !== pet.stage,
    new_stage: newStage,
  };
}

async function updatePet(openid, data) {
  if (!data.id) return { code: -1, message: "缺少宠物ID" };
  const fields = { updated_at: Date.now() };
  ["name","stage","level","experience","species","attribute_type","personality",
   "egg_stage","hatch_progress","is_hatched","rarity","attributes",
   "bond","mood","mood_message","awakened",
   "growth_value"].forEach(k => {
    if (data[k] !== undefined) fields[k] = data[k];
  });
  await safeUpdate("pets", { _id: data.id, _openid: openid }, fields);
  return { success: true };
}

/** 觉醒宠物 */
async function awakenPet(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  const pets = await safeQuery("pets", { _openid: openid });
  // 【V8.3修复】排除已软删除的宠物
  const pet = pets.find(p => p._id === data.pet_id && !p.deleted_at);
  if (!pet) return { code: -1, message: "宠物不存在" };
  if (pet.awakened) return { code: -1, message: "已经觉醒过了" };
  if (pet.stage !== 'ADULT' && pet.stage !== 'PERFECT') return { code: -1, message: "只有成年宠物才能觉醒" };

  const prefix = AWAKEN_PREFIX[pet.species] || '觉醒';
  const awakenedName = prefix + pet.name;

  await safeUpdate("pets", { _id: data.pet_id }, {
    awakened: true,
    name: awakenedName,
    updated_at: Date.now(),
  });

  await safeAdd("growth_logs", {
    _openid: openid, xp_change: 0,
    reason: `✨ 【${pet.name}】觉醒了！进化为【${awakenedName}】`,
    source: "awaken", created_at: Date.now(),
  });

  return { success: true, awakened_name: awakenedName, message: `${pet.name} 觉醒成为了 ${awakenedName}！` };
}

/** 释放/删除宠物（软删除，保留历史记录） */
async function deletePet(openid, data) {
  if (!data.pet_id) return { code: -1, message: "缺少宠物ID" };
  const pets = await safeQuery("pets", { _openid: openid });
  const pet = pets.find(p => p._id === data.pet_id);
  if (!pet) return { code: -1, message: "宠物不存在" };
  // 【V8.3修复】防止重复删除已释放的宠物
  if (pet.deleted_at) return { code: -1, message: "该宠物已释放，无需重复操作" };

  // 软删除：标记 deleted_at，保留数据用于图鉴
  await safeUpdate("pets", { _id: data.pet_id }, {
    deleted_at: Date.now(),
    is_hatched: false, // 标记为非活跃
    updated_at: Date.now(),
  });

  const rarityText = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
  await safeAdd("growth_logs", {
    _openid: openid, xp_change: 0,
    reason: `👋 放行了【${rarityText[pet.rarity] || ''}${pet.name}】，它回到了大自然`,
    source: "release", created_at: Date.now(),
  });

  return { success: true, message: `已放行【${pet.name}】` };
}

/** 宠物图鉴：获取全部宠物（含已释放的） */
async function petCollection(openid) {
  const allPets = await safeQuery("pets", { _openid: openid });

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
  const ownedSpeciesSet = new Set();
  allPets.forEach(p => { if (p.species) ownedSpeciesSet.add(p.species); });
  const ownedSpeciesList = [...ownedSpeciesSet];
  const allSpeciesList = SPECIES_LIST;  // V6: 使用15种物种
  const collectedSpecies = allSpeciesList.filter(s => ownedSpeciesSet.has(s));
  const uncollectedSpecies = allSpeciesList.filter(s => !ownedSpeciesSet.has(s));

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
        owned_species: ownedSpeciesList,
        collected_species: collectedSpecies,
        uncollected_species: uncollectedSpecies,
        is_complete: collectedSpecies.length >= allSpeciesList.length,
      },
    },
  };
}

// 宠物详情（V3：含全部字段 + 成长记录）
async function petDetail(openid, petId) {
  const pets = await safeQuery("pets", { _openid: openid });
  // 【V8.3修复】排除已软删除的宠物
  const pet = pets.find(p => p._id === petId && !p.deleted_at);
  if (!pet) return { code: -1, message: "宠物不存在" };

  const stageXpMap = { EGG: 100, BABY: 300, YOUTH: 600, ADULT: 9999, PERFECT: 9999 };
  const stageMaxXp = stageXpMap[pet.stage] || 300;
  const bondLv = getBondLevel(pet.bond || 0);

  // 计算陪伴天数
  const hatchTime = pet.hatch_time || pet.created_at || Date.now();
  const companionDays = Math.max(0, Math.floor((Date.now() - hatchTime) / 86400000));

  // 成长记录
  const logs = await safeQuery("growth_logs", { _openid: openid });
  const sortedLogs = (logs || [])
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, 50)
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
async function recordEmotion(openid, data) {
  if (data.mood_index === undefined) return { code: -1, message: "缺少情绪值" };
  const today = todayStr();
  const exist = await safeQuery("emotions", { _openid: openid, date: today });
  if (exist.length > 0) {
    await safeUpdate("emotions", { _id: exist[0]._id }, { mood_index: data.mood_index, mood_label: data.mood_label || "", updated_at: Date.now() });
  } else {
    await safeAdd("emotions", { _openid: openid, mood_index: data.mood_index, mood_label: data.mood_label || "", date: today, created_at: Date.now() });
  }
  return { success: true };
}

// ====== 成长日志 ======
async function listGrowthLogs(openid, params) {
  const query = { _openid: openid };
  if (params && params.source) query.source = params.source;
  const data = await safeQuery("growth_logs", query);
  return { success: true, data: (data || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, (params && params.limit) || 50) };
}

/** 添加成长记录（供道具使用等场景调用） */
async function addGrowthLog(openid, data) {
  await safeAdd("growth_logs", {
    _openid: openid,
    xp_change: data.xp_change || 0,
    reason: data.reason || '使用了道具',
    source: data.source || 'item_use',
    created_at: Date.now(),
  });
  return { success: true };
}

// ====== API Key ======
async function saveApiKey(openid, data) {
  if (!data.provider) return { code: -1, message: "缺少供应商" };
  const exist = await safeQuery("api_keys", { _openid: openid, provider: data.provider });
  // V10.7：api_key 为空时只更新 baseUrl/model，不覆盖已存储的 key
  const hasNewKey = data.api_key && data.api_key.length >= 10
  if (exist.length > 0) {
    const updateFields = { base_url: data.base_url || "", model: data.model || "", updated_at: Date.now() }
    if (hasNewKey) updateFields.api_key = data.api_key
    await safeUpdate("api_keys", { _id: exist[0]._id }, updateFields);
  } else {
    if (!hasNewKey) return { code: -1, message: "首次配置必须提供 API Key" };
    await safeAdd("api_keys", { _openid: openid, provider: data.provider, api_key: data.api_key, base_url: data.base_url || "", model: data.model || "", created_at: Date.now(), updated_at: Date.now() });
  }
  return { success: true };
}

async function listApiKeys(openid) {
  const data = await safeQuery("api_keys", { _openid: openid });
  // V10.7：返回完整 key（不再遮蔽），由前端决定如何显示。数据库查询已限定 _openid，用户只能看到自己的 key
  return { success: true, data: (data || []).map(k => ({
    provider: k.provider,
    api_key: k.api_key || '',
    api_key_masked: k.api_key ? k.api_key.slice(0, 8) + '****' : '',
    base_url: k.base_url || '',
    model: k.model || '',
    has_key: !!(k.api_key)
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
async function checkAdmin(openid) {
  if (!openid) return false;
  try {
    const res = await db.collection("users").where({ _openid: openid }).get();
    if (res.data && res.data.length > 0) {
      const adminRecord = res.data.find(u => u.role === 'admin');
      if (adminRecord) {
        console.log('[checkAdmin] ✅ 通过(openid)', adminRecord.username);
        return true;
      }
      console.log('[checkAdmin] ❌ openid匹配但无admin, 用户列表:', res.data.map(u => u.username + '(' + u.role + ')'));
    }
    console.warn('[checkAdmin] 权限校验失败，openid:', (openid || '').substring(0, 10) + '...');
    return false;
  } catch (e) {
    console.warn('[checkAdmin] 异常:', e.message);
    return false;
  }
}

// 管理员数据概览（完整版）
async function adminDashboard(openid) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };

  const today = todayStr();

  // 并行查询所有统计数据（用 count + safeQuery）
  const [userCount, goalRes, petRes, fbRes, taskList, checkinList] = await Promise.all([
    db.collection("users").count(),
    safeQuery("goals", { status: _.neq("deleted") }),
    safeQuery("pets", {}),
    safeQuery("feedbacks", {}),
    safeQuery("tasks", { date: today }),
    safeQuery("checkins", { date: today }),
  ]);

  const totalGoals = await db.collection("goals").where({ status: _.neq("deleted") }).count();

  const activeToday = taskList.filter(t => t.completed).length;
  const todaySignins = checkinList.length;

  // 平台总XP
  const allUsers = await safeQuery("users", {});
  const totalPlatformXp = allUsers.reduce((sum, u) => sum + (u.total_xp || 0), 0);

  // 最近注册用户
  const recentUsers = (allUsers || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 8);

  // 所有反馈
  const feedbacks = (fbRes || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  // 所有宠物
  const allPets = (petRes || []).map(p => ({
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
        totalUsers: userCount.total,
        totalGoals: totalGoals.total,
        totalPets: petRes.length,
        totalFeedbacks: fbRes.length,
        activeToday,
        todaySignins,
        totalPlatformXp,
      },
      recentUsers: recentUsers.map(u => ({
        id: u._id, nickname: u.nickname, username: u.username, avatar: u.avatar,
        level: u.level || 1, role: u.role || 'user', status: u.status || 'active',
        total_xp: u.total_xp || 0, streak_days: u.streak_days || 0,
        created_at: u.created_at,
      })),
      pendingFeedbacks: feedbacks.slice(0, 20),
      allPets: allPets.slice(0, 30),
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

// 设置用户角色
async function adminSetRole(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!data.userId || !data.role) return { code: -1, message: "缺少参数" };
  if (data.role !== 'admin' && data.role !== 'user') return { code: -1, message: "无效角色" };

  const targetUser = await db.collection("users").doc(data.userId).get();
  if (!targetUser.data) return { code: -1, message: "用户不存在" };

  await safeUpdate("users", { _id: data.userId }, { role: data.role, updated_at: Date.now() });
  return { success: true, message: `已设置为${data.role === 'admin' ? '管理员' : '普通用户'}` };
}

// 设置用户状态（封禁/解封）
async function adminSetUserStatus(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!data.userId || !data.status) return { code: -1, message: "缺少参数" };
  if (data.status !== 'active' && data.status !== 'banned') return { code: -1, message: "无效状态" };

  await safeUpdate("users", { _id: data.userId }, { status: data.status, updated_at: Date.now() });
  return { success: true, message: data.status === 'banned' ? '已封禁该用户' : '已解除封禁' };
}

// 重置用户密码
async function adminResetPassword(openid, data) {
  if (!await checkAdmin(openid)) return { code: -1, message: "无管理员权限" };
  if (!data.userId || !data.newPassword) return { code: -1, message: "缺少参数" };
  if (data.newPassword.length < 4) return { code: -1, message: "密码至少4位" };

  await safeUpdate("users", { _id: data.userId }, { password: data.newPassword, updated_at: Date.now() });
  return { success: true, message: '密码已重置' };
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
        return {
          id: p._id, name: p.name, stage: p.stage, level: p.level,
          experience: p.experience, status: p.status,
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
  if (!data.petId) return { code: -1, message: "缺少宠物ID" };

  const fields = { updated_at: Date.now() };
  ['name', 'stage', 'status', 'level', 'experience'].forEach(k => {
    if (data[k] !== undefined) fields[k] = data[k];
  });

  await safeUpdate("pets", { _id: data.petId }, fields);
  return { success: true, message: '宠物信息已更新' };
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

/**
 * V8.3 管理员数据清理：删除所有非管理员账号及其关联数据
 * 仅保留 role='admin' 的用户（如 lzk）
 * 用途：测试阶段清理残留数据，正式上线前执行一次
 */
async function adminCleanupNonAdmin(callerOpenid) {
  if (!await checkAdmin(callerOpenid)) return { code: -1, message: "无管理员权限" };

  const _ = db.command;
  const result = {
    deletedUsers: 0, deletedPets: 0, deletedPools: 0, deletedLogs: 0,
    keptUsers: [], errors: []
  };

  try {
    // 1. 找出所有非管理员用户
    const allUsers = await safeQuery("users", {});
    const admins = allUsers.filter(u => u.role === 'admin');
    const nonAdmins = allUsers.filter(u => u.role !== 'admin');

    result.keptUsers = admins.map(u => u.username || u._id);

    console.log('[Cleanup] 管理员保留:', result.keptUsers.length, '非管理员待清理:', nonAdmins.length);

    // 2. 逐个清理非管理员数据
    for (const user of nonAdmins) {
      const uid = user._id;
      const uOpenid = user._openid;
      const uname = user.username || uid;

      try {
        // 删除该用户的宠物
        if (uOpenid) {
          const pets = await safeQuery("pets", { _openid: uOpenid });
          for (const pet of pets) {
            await db.collection("pets").doc(pet._id).remove();
            result.deletedPets++;
          }
        }

        // 删除该用户的经验池
        if (uOpenid) {
          const pools = await safeQuery("user_growth_pool", { _openid: uOpenid });
          for (const pool of pools) {
            await db.collection("user_growth_pool").doc(pool._id).remove();
            result.deletedPools++;
          }
        }

        // 删除该用户的成长日志
        if (uOpenid) {
          const logs = await safeQuery("growth_logs", { _openid: uOpenid });
          for (const log of logs) {
            await db.collection("growth_logs").doc(log._id).remove();
            result.deletedLogs++;
          }
        }

        // 删除用户记录
        await db.collection("users").doc(uid).remove();
        result.deletedUsers++;

      } catch (e) {
        result.errors.push(uname + ': ' + e.message);
      }
    }

    console.log('[Cleanup] 完成:', JSON.stringify(result));
    return { code: 0, success: true, data: result, message: '清理完成' };

  } catch (e) {
    return { code: -1, message: '清理失败: ' + e.message };
  }
}

/**
 * V8.3 管理员删除单个用户及其所有关联数据
 */
async function adminDeleteUser(callerOpenid, data) {
  if (!await checkAdmin(callerOpenid)) return { code: -1, message: "无管理员权限" };
  if (!data.userId) return { code: -1, message: "缺少用户ID" };

  const _ = db.command;
  const userId = data.userId;

  try {
    // 查找目标用户
    const userRes = await db.collection("users").doc(userId).get();
    if (!userRes.data) return { code: -1, message: "用户不存在" };
    const targetUser = userRes.data;

    // 不允许删除管理员
    if (targetUser.role === 'admin') {
      return { code: -1, message: "不能删除管理员账号" };
    }

    const uOpenid = targetUser._openid;
    const uname = targetUser.username || userId;
    let deletedPets = 0, deletedPools = 0, deletedLogs = 0;

    // 删除该用户的宠物
    if (uOpenid) {
      const pets = await safeQuery("pets", { _openid: uOpenid });
      for (const pet of pets) {
        await db.collection("pets").doc(pet._id).remove();
        deletedPets++;
      }
    }

    // 删除该用户的经验池
    if (uOpenid) {
      const pools = await safeQuery("user_growth_pool", { _openid: uOpenid });
      for (const pool of pools) {
        await db.collection("user_growth_pool").doc(pool._id).remove();
        deletedPools++;
      }
    }

    // 删除该用户的成长日志
    if (uOpenid) {
      const logs = await safeQuery("growth_logs", { _openid: uOpenid });
      for (const log of logs) {
        await db.collection("growth_logs").doc(log._id).remove();
        deletedLogs++;
      }
    }

    // 删除用户记录
    await db.collection("users").doc(userId).remove();

    console.log('[adminDeleteUser] 已删除:', uname, 'pets:', deletedPets, 'pools:', deletedPools, 'logs:', deletedLogs);
    return { code: 0, success: true, data: { username: uname, deletedPets, deletedPools, deletedLogs }, message: '已删除' };
  } catch (e) {
    return { code: -1, message: '删除失败: ' + e.message };
  }
}

// ====== V8.6 AI 时间胶囊 ======
async function myCapsules(openid) {
  try {
    const res = await db.collection('capsules')
      .where({ _openid: openid })
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
    return { code: 0, data: res.data || [] }
  } catch (e) {
    console.warn('[myCapsules] 查询失败:', e.message)
    return { code: 0, data: [] }
  }
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
function callLLM(baseUrl, apiKey, model, messages, maxTokens) {
  const mt = maxTokens || 2000
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const body = JSON.stringify({ model, messages, stream: false, temperature: 0.7, max_tokens: mt })

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
      timeout: 30000
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
          if (!errMsg.includes(data.slice(0, 80).trim())) {
            errMsg += ' | ' + data.slice(0, 200)
          }
          console.warn('[callLLM] 非200响应:', res.statusCode, errMsg)
          reject(new Error(errMsg))
          return
        }

        // 2. 200 OK — 检查是否有业务错误
        try {
          const json = JSON.parse(data)
          // OpenAI 兼容格式的业务错误
          if (json.error) {
            const msg = json.error.message || json.error.code || 'API 返回错误'
            reject(new Error(msg))
            return
          }
          // Qwen/百炼 非兼容模式的错误
          if (json.code && json.code !== 0 && json.code !== '0') {
            reject(new Error(json.message || json.code || 'API 返回错误'))
            return
          }
          // 提取回复内容
          const content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : ''
          resolve(content)
        } catch (e) {
          reject(new Error('解析响应失败: ' + data.slice(0, 200)))
        }
      })
    })
    req.on('error', (e) => reject(new Error('网络错误: ' + e.message)))
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（30秒）')) })
    req.write(body)
    req.end()
  })
}

/**
 * 获取用户的 API Key 配置
 */
async function getUserApiConfig(openid, provider) {
  try {
    const keys = await safeQuery('api_keys', { _openid: openid })
    if (Array.isArray(keys) && keys.length > 0) {
      // 如果指定了 provider，找对应那个
      if (provider) {
        const match = keys.find(k => k.provider === provider)
        if (match) return match
      }
      // 返回第一个有值的
      const any = keys.find(k => k.api_key)
      if (any) return any
    }
    return null
  } catch (e) {
    return null
  }
}

/**
 * 测试连接
 */
async function aiTestConnection(openid, data) {
  const { apiKey, baseUrl, model, provider } = data
  const key = apiKey || ''
  if (!key || key.length < 10) {
    return { code: -1, message: 'API Key 无效' }
  }
  const url = baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const mdl = model || 'qwen-plus'

  try {
    await callLLM(url, key, mdl, [
      { role: 'user', content: '你好，请回复"连接成功"' }
    ])
    return { code: 0, message: '连接成功！模型: ' + mdl }
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

  // 优先从请求中取配置，否则从数据库读取
  let apiKey = data.apiKey, baseUrl = data.baseUrl, model = data.model

  if (!apiKey) {
    const config = await getUserApiConfig(openid, provider)
    if (!config) return { code: -1, message: '请先在 AI 配置中设置 API Key' }
    apiKey = config.api_key
    baseUrl = config.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    model = config.model || 'qwen-plus'
  }

  try {
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
  const { planState, messages, provider } = data || {}
  // V10.6：允许空对话直接生成（用户点"生成计划"按钮，即使没聊过也能生成）
  const safeMessages = (messages && Array.isArray(messages) && messages.length > 0) ? messages : []

  try {
    // 自动创建集合（首次使用时 ai_plans 可能不存在）
    try { await db.createCollection('ai_plans') } catch (_) { /* 已存在 */ }
    const res = await safeAdd('ai_plans', {
      _openid: openid,
      planState: planState || {},
      messages: safeMessages,
      status: 'pending',
      createdAt: Date.now()
    })
    return { code: 0, data: { plan_id: res._id, status: 'pending' } }
  } catch (e) {
    return { code: -1, message: '创建任务失败: ' + e.message }
  }
}

/**
 * V9.1 异步生成任务 — 第2步：调用 LLM 生成并写回结果
 */
async function aiDoGenerate(openid, data) {
  const { plan_id, provider } = data || {}
  if (!plan_id) return { code: -1, message: '缺少 plan_id' }

  try {
    // 自动创建集合（首次使用时 ai_plans 可能不存在）
    try { await db.createCollection('ai_plans') } catch (_) { /* 已存在 */ }
    const docs = await safeQuery('ai_plans', { _id: plan_id, _openid: openid })
    if (!docs || docs.length === 0) return { code: -1, message: '任务不存在' }

    const plan = docs[0]
    const messages = plan.messages || []

    // 已生成过直接返回
    if (plan.status === 'done' && plan.result) {
      return { code: 0, data: plan.result }
    }

    // 获取 API 配置
    let apiKey = data.apiKey, baseUrl = data.baseUrl, model = data.model
    if (!apiKey) {
      const config = await getUserApiConfig(openid, provider)
      if (!config) return { code: -1, message: '请先在 AI 配置中设置 API Key' }
      apiKey = config.api_key
      baseUrl = config.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      model = config.model || 'qwen-plus'
    }

    // 构建提取任务的 prompt（注入已收集的规划信息）
    const ps = plan.planState || {}
    const hasContext = !!(ps.what || ps.why || ps.deadline || ps.dailyTime || ps.level)
    const planContext = hasContext
      ? `用户目标：${ps.what || '未指定'}，动机：${ps.why || '未说明'}，周期：${ps.deadline || '未指定'}，每日可投入：${ps.dailyTime || '未指定'}，当前水平：${ps.level || '新手'}。`
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

    const reply = await callLLM(baseUrl, apiKey, model, [...messages.map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content
    })), extractPrompt])

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
      console.warn('[aiDoGenerate] JSON解析失败，使用本地模板兜底', { rawPreview: reply.slice(0, 100) })
      // 返回本地模板
      const context = planContext || '通用成长计划'
      return { code: 0, data: {
        goal: { title: ps.what || '我的成长计划', period: ps.deadline || '30天', stages: [{ name: '适应期', duration: '第1-7天', milestone: '建立基础' }, { name: '提升期', duration: '第8-15天', milestone: '逐步增强' }, { name: '巩固期', duration: '第16-30天', milestone: '稳定执行' }] },
        tasks: [
          { title: '了解目标相关基础知识', xp_reward: 10, stage: 1, estimated_minutes: 15 },
          { title: '制定每日执行计划', xp_reward: 10, stage: 1, estimated_minutes: 10 },
          { title: '执行当日练习任务', xp_reward: 10, stage: 2, estimated_minutes: 20 },
          { title: '记录进度与心得', xp_reward: 10, stage: 2, estimated_minutes: 5 },
          { title: '回顾并优化方法', xp_reward: 20, stage: 3, estimated_minutes: 15 },
          { title: '完成阶段性目标并总结', xp_reward: 30, stage: 3, estimated_minutes: 30 }
        ]
      }}
    }
    const result = {
      goal: parsed.goal || { title: '我的成长计划' },
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
    }

    // 写回结果
    try {
      await db.collection('ai_plans').doc(plan_id).update({
        data: { result: result, status: 'done', updatedAt: Date.now() }
      })
    } catch (e) { console.warn('[aiDoGenerate] 写回失败:', e.message) }

    return { code: 0, data: result }
  } catch (e) {
    // 标记失败
    try {
      await db.collection('ai_plans').doc(plan_id).update({
        data: { status: 'failed', error: e.message, updatedAt: Date.now() }
      })
    } catch (e2) { /* 忽略 */ }
    return { code: -1, message: '生成失败: ' + e.message }
  }
}

/**
 * V9.1 轮询计划状态
 */
async function aiPollPlan(openid, data) {
  const { plan_id } = data || {}
  if (!plan_id) return { code: -1, message: '缺少 plan_id' }

  try {
    const docs = await safeQuery('ai_plans', { _id: plan_id, _openid: openid })
    if (!docs || docs.length === 0) return { code: -1, message: '任务不存在' }

    const plan = docs[0]
    return {
      code: 0,
      data: {
        status: plan.status || 'unknown',
        result: plan.status === 'done' ? (plan.result || null) : null,
        error: plan.status === 'failed' ? (plan.error || '') : ''
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

  let apiKey = data.apiKey, baseUrl = data.baseUrl, model = data.model

  if (!apiKey) {
    const config = await getUserApiConfig(openid, provider)
    if (!config) return { code: -1, message: '请先在 AI 配置中设置 API Key' }
    apiKey = config.api_key
    baseUrl = config.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    model = config.model || 'qwen-plus'
  }

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
    switch (action) {
      case "getDashboard":      return await getDashboard(openid);
      case "updateUser":        return await updateUser(openid, data || {});
      case "dailyCheckin":      return await dailyCheckin(openid);
      case "listGoals":         return await listGoals(openid);
      case "createGoal":        return await createGoal(openid, data || {});
      case "updateGoal":        return await updateGoal(openid, data || {});
      case "deleteGoal":        return await deleteGoal(openid, data?.id || "");
      case "getGoalDetail":     return await getGoalDetail(openid, data?.id || "");
      case "listTasks":         return await listTasks(openid, data || {});
      case "createTask":        return await createTask(openid, data || {});
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
      case "refreshEgg":        return await refreshEgg(openid, data || {});
      case "claimStarterXp":    return await claimStarterXp(openid);
      case "claimChildrenDayGift": return await claimChildrenDayGift(openid);
      case "getBackpack":        return await getBackpack(openid);
      case "useBackpackItem":    return await useBackpackItem(openid, data || {});
      case "syncEverOwnedSpecies": return await syncEverOwnedSpecies(openid, data || {});
      case "petDetail":         return await petDetail(openid, (data && data.petId) || '');
      case "petInteract":       return await petInteract(openid, data || {});
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
      case "addGrowthLog":      return await addGrowthLog(openid, data || {});
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
      case "adminCleanupNonAdmin": return await adminCleanupNonAdmin(openid);
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
      default:                  return { code: -1, message: "未知操作: " + action };
    }
  } catch (err) {
    console.error("[App云函数错误]", err);
    return { code: -1, data: null, message: err.message || "服务器内部错误" };
  }
};
