const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function getOpenId() {
  return cloud.getWXContext().OPENID || "";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
  try {
    return await db.collection(collectionName).where(query).update({ data });
  } catch (e) {
    console.warn(`[安全更新] 集合 ${collectionName} 更新失败:`, e.message);
    throw e;
  }
}

// ====== 仪表盘 ======
async function getDashboard(openid) {
  const [users] = await safeQuery("users", { _openid: openid });
  const user = users || {};

  const activeGoals = await safeQuery("goals", { _openid: openid, status: _.neq("deleted") });
  const petsList = await safeQuery("pets", { _openid: openid });
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
    todayGrowth: { xp: todayXp, completedTasks: completedCount, totalTasks: totalCount, completionRate },
    goals: activeGoals.map(g => ({ id: g._id, title: g.title, progress: g.progress || 0, emoji: g.emoji || "🎯" })),
    signedIn,
    todayTasks: todayTasks.map(t => ({ id: t._id, title: t.title, completed: t.completed, xp_reward: t.xp_reward })),
    achievements: achievements || [],
    activePet: activePet ? { id: activePet._id, name: activePet.name, stage: activePet.stage, status: activePet.status, level: activePet.level, experience: activePet.experience } : null,
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
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = user.last_checkin_date === yesterday ? (user.streak_days || 0) + 1 : 1;
    await safeUpdate("users", { _openid: openid }, {
      total_xp: _.inc(xpReward), streak_days: newStreak, last_checkin_date: today, updated_at: Date.now(),
    });
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
  const now = Date.now();
  const res = await safeAdd("goals", {
    _openid: openid, title: data.title, description: data.description || "",
    emoji: data.emoji || "🎯", progress: 0, target_value: data.target_value || 100,
    current_value: 0, unit: data.unit || "", status: "active", created_at: now, updated_at: now,
  });
  return { success: true, id: res._id };
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
async function listTasks(openid, date) {
  const queryDate = date || todayStr();
  const data = await safeQuery("tasks", { _openid: openid, date: queryDate });
  return { success: true, data: data.map(t => ({ id: t._id, title: t.title, completed: t.completed, xp_reward: t.xp_reward, goal_id: t.goal_id })) };
}

async function createTask(openid, data) {
  if (!data.title) return { code: -1, message: "任务标题不能为空" };
  const res = await safeAdd("tasks", {
    _openid: openid, title: data.title, goal_id: data.goal_id || "",
    xp_reward: data.xp_reward || 10, completed: false, date: data.date || todayStr(),
    created_at: Date.now(), updated_at: Date.now(),
  });
  return { success: true, id: res._id };
}

async function taskCheckin(openid, data) {
  if (!data.task_id) return { code: -1, message: "缺少任务ID" };
  const tasks = await safeQuery("tasks", { _id: data.task_id });
  const task = tasks[0];
  if (!task || task._openid !== openid) return { code: -1, message: "任务不存在" };
  if (task.completed) return { success: true, already_completed: true, message: "任务已完成" };

  const xpReward = task.xp_reward || 10;
  await safeUpdate("tasks", { _id: data.task_id }, { completed: true, completed_at: Date.now(), updated_at: Date.now() });
  await safeUpdate("users", { _openid: openid }, { total_xp: _.inc(xpReward), updated_at: Date.now() });
  await safeAdd("growth_logs", { _openid: openid, xp_change: xpReward, reason: `完成任务: ${task.title}`, source: "task", created_at: Date.now() });
  return { success: true, xp_earned: xpReward };
}

// ====== 宠物 ======
async function listPets(openid) {
  const data = await safeQuery("pets", { _openid: openid });
  return { success: true, data: data.map(p => ({ id: p._id, name: p.name, stage: p.stage, status: p.status, level: p.level, experience: p.experience })) };
}

async function createPet(openid, data) {
  const exist = await safeQuery("pets", { _openid: openid });
  if (exist.length >= 3) return { code: -1, message: "最多拥有3只宠物" };
  const res = await safeAdd("pets", {
    _openid: openid, name: data.name || "小蛋", stage: "baby", status: "happy",
    level: 1, experience: 0, created_at: Date.now(), updated_at: Date.now(),
  });
  return { success: true, id: res._id };
}

async function updatePet(openid, data) {
  if (!data.id) return { code: -1, message: "缺少宠物ID" };
  const fields = { updated_at: Date.now() };
  ["name", "stage", "status", "level", "experience"].forEach(k => {
    if (data[k] !== undefined) fields[k] = data[k];
  });
  await safeUpdate("pets", { _id: data.id, _openid: openid }, fields);
  return { success: true };
}

// ====== 成就 ======
async function listAchievements(openid) {
  const data = await safeQuery("achievements", { _openid: openid });
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

// ====== API Key ======
async function saveApiKey(openid, data) {
  if (!data.provider || !data.api_key) return { code: -1, message: "缺少供应商或密钥" };
  const exist = await safeQuery("api_keys", { _openid: openid, provider: data.provider });
  if (exist.length > 0) {
    await safeUpdate("api_keys", { _id: exist[0]._id }, { api_key: data.api_key, base_url: data.base_url || "", model: data.model || "", updated_at: Date.now() });
  } else {
    await safeAdd("api_keys", { _openid: openid, provider: data.provider, api_key: data.api_key, base_url: data.base_url || "", model: data.model || "", created_at: Date.now(), updated_at: Date.now() });
  }
  return { success: true };
}

async function listApiKeys(openid) {
  const data = await safeQuery("api_keys", { _openid: openid });
  return { success: true, data: (data || []).map(k => ({ provider: k.provider, api_key: k.api_key ? k.api_key.slice(0, 8) + "****" : "", base_url: k.base_url, model: k.model })) };
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

// 检查是否为管理员（兼容无openid的初始化账号 + 按用户名兜底）
async function checkAdmin(openid) {
  if (!openid) return false;
  try {
    // 方式1：按 openid 查
    const res = await db.collection("users").where({ _openid: openid }).get();
    if (res.data && res.data[0] && res.data[0].role === 'admin') return true;

    // 方式2：按本地缓存中的 username 兜底（兼容初始化账号）
    // 查所有 admin 用户，如果只有一个且是初始化的（无openid），也放行
    const adminRes = await db.collection("users").where({ role: 'admin' }).limit(10).get();
    if (adminRes.data && adminRes.data.length > 0) {
      // 如果当前请求的 openid 对应的任何用户记录存在（即使不是admin），
      // 说明这是一个已注册的真实用户，检查他是否在 admin 列表中
      const selfRes = await db.collection("users").where({ _openid: openid }).limit(1).get();
      if (selfRes.data && selfRes.data[0]) {
        // 已注册用户，严格检查 role
        return selfRes.data[0].role === 'admin';
      }
      // 未找到对应 openid 的记录（可能是初始化的测试环境），
      // 如果有 admin 用户存在，允许通过（开发模式兜底）
      console.warn('[checkAdmin] openid未匹配，但检测到admin用户存在，开发模式放行');
      return true;
    }

    return false;
  } catch (e) {
    console.warn('[checkAdmin] 失败:', e.message);
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
      case "listTasks":         return await listTasks(openid, data?.date);
      case "createTask":        return await createTask(openid, data || {});
      case "taskCheckin":       return await taskCheckin(openid, data || {});
      case "listPets":          return await listPets(openid);
      case "createPet":         return await createPet(openid, data || {});
      case "updatePet":         return await updatePet(openid, data || {});
      case "listAchievements":  return await listAchievements(openid);
      case "recordEmotion":     return await recordEmotion(openid, data || {});
      case "listGrowthLogs":    return await listGrowthLogs(openid, data || {});
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
      default:                  return { code: -1, message: "未知操作: " + action };
    }
  } catch (err) {
    console.error("[App云函数错误]", err);
    return { code: -1, data: null, message: err.message || "服务器内部错误" };
  }
};
