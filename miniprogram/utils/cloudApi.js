/**
 * 云开发 API 适配层
 * 封装 wx.cloud.callFunction，替代原有的 HTTP request
 * 内置重试机制，解决网络不稳定问题
 */

const MAX_RETRIES = 2;
const RETRY_DELAY = 800; // ms

/**
 * 检查网络状态
 */
function checkNetwork() {
  return new Promise((resolve) => {
    wx.getNetworkType({
      success(res) {
        resolve(res.networkType !== 'none');
      },
      fail() {
        resolve(true); // 无法检测时假定网络可用
      },
    });
  });
}

/**
 * 调用云函数（带重试机制）
 * @param {string} name 云函数名
 * @param {string} action 操作名
 * @param {object} data 参数
 * @param {number} retryCount 当前重试次数（内部用）
 */
function callCloud(name, action, data, retryCount) {
  const attempt = retryCount || 0;
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data: { action, data },
      success: (res) => {
        const result = res.result || {};
        // code === -1 表示明确的业务错误
        if (result.code === -1) {
          const errMsg = result.message || `云函数 ${name}/${action} 返回异常`;
          console.error(`[CloudAPI] ${name}.${action} 业务错误:`, errMsg, result);
          reject(errMsg);
          return;
        }
        // code 为 0 或无 code 字段、success 为 true、或仅有 data 字段 → 均视为成功
        // 优先取 .data，没有则返回整体 result（去掉 code/message 等元信息）
        if (result.data !== undefined) {
          resolve(result.data);
        } else {
          // 可能返回的是 { code: 0, message: 'ok' } 这种无 data 的情况
          resolve(result);
        }
      },
      fail: async (err) => {
        // 云函数调用本身失败（网络/超时/未部署等）
        const rawMsg = err.errMsg || err.message || JSON.stringify(err);
        console.error(`[CloudAPI] ${name}.${action} 调用失败 (第${attempt + 1}次):`, rawMsg);

        // 云函数未部署的典型错误
        if (rawMsg.indexOf('not found') >= 0 || rawMsg.indexOf('FUNCTION_NOT_FOUND') >= 0) {
          wx.showToast({ title: `云函数 ${name} 未部署`, icon: 'none', duration: 3000 });
          return reject(`云函数 "${name}" 尚未部署，请在开发者工具中右键上传`);
        }

        // 【修复】业务逻辑错误不应重试（密码错误、用户不存在等）
        const businessErrorPatterns = ['密码错误', '用户不存在', '账号已存在', '参数错误', '权限不足', '非法操作'];
        const isBusinessError = businessErrorPatterns.some(function(p) { return rawMsg.indexOf(p) >= 0 });
        if (isBusinessError) {
          // 直接提取可读的业务错误信息
          var bizMsg = rawMsg;
          var errMsgMatch = rawMsg.match(/Error:\s*(.+?)(?:\s+at\s|$)/);
          if (errMsgMatch && errMsgMatch[1]) { bizMsg = errMsgMatch[1].trim(); }
          console.warn(`[CloudAPI] 业务错误，不重试:`, bizMsg);
          return reject(bizMsg);
        }

        // 判断是否为网络类错误（仅对真正的网络问题重试）
        // 【修复】云函数超时(-504003)是配置问题，不是网络波动，不重试
        const isNetworkError = rawMsg.indexOf('timeout') >= 0 ||
          rawMsg.indexOf('network') >= 0 ||
          rawMsg.indexOf('abort') >= 0 ||
          rawMsg.indexOf('-501000') >= 0 ||   // 网络断开
          rawMsg.indexOf('-502003') >= 0;      // 网络超时
        const isFunctionTimeout = rawMsg.indexOf('-504003') >= 0; // 云函数执行超时（非网络问题）

        if (attempt < MAX_RETRIES && isNetworkError && !isFunctionTimeout) {
          const online = await checkNetwork();
          if (!online) {
            console.warn(`[CloudAPI] 网络不可用，跳过重试`);
            return reject('当前网络不可用，请检查网络连接');
          }

          console.log(`[CloudAPI] ${name}.${action} 将在 ${RETRY_DELAY}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
          wx.showToast({ title: '网络波动，重试中...', icon: 'none', duration: 1500 });

          setTimeout(() => {
            callCloud(name, action, data, attempt + 1)
              .then(resolve)
              .catch(reject);
          }, RETRY_DELAY * (attempt + 1));
        } else {
          // 非网络错误：提取核心错误信息返回
          var finalMsg = rawMsg;
          var match = rawMsg.match(/Error:\s*(.+?)(?:\s+\|?\s*errMsg:|\s+at\s|$)/);
          if (match && match[1]) { finalMsg = match[1].trim(); }
          reject(finalMsg);
        }
      },
    });
  });
}

const cloudApi = {
  // ===== 登录 =====
  // 静默登录（检查是否已注册）
  login: () => callCloud('login', 'login'),
  // 授权登录（带头像昵称）
  authLogin: (data) => callCloud('login', 'authLogin', data),
  // 账号密码登录
  accountLogin: (data) => callCloud('login', 'accountLogin', data),
  // 账号注册
  accountRegister: (data) => callCloud('login', 'accountRegister', data),

  // ===== 首页仪表盘 =====
  dashboard: () => callCloud('app', 'getDashboard'),

  // ===== 用户 =====
  me: () => callCloud('app', 'getDashboard').then(d => d.user || d),
  userLevel: () => callCloud('app', 'getDashboard').then(d => ({ level: d.user?.level, total_xp: d.user?.total_xp })),
  updateMe: (data) => callCloud('app', 'updateUser', data),

  // ===== 签到 =====
  dailyCheckin: () => callCloud('app', 'dailyCheckin'),

  // ===== 目标 =====
  goals: () => callCloud('app', 'listGoals'),
  createGoal: (data) => callCloud('app', 'createGoal', data),
  goalDetail: (id) => callCloud('app', 'getGoalDetail', { id }),
  updateGoal: (id, data) => callCloud('app', 'updateGoal', { id, ...data }),
  deleteGoal: (id) => callCloud('app', 'deleteGoal', { id }),

  // ===== 任务 =====
  tasks: (params) => callCloud('app', 'listTasks', params || {}),
  createTask: (data) => callCloud('app', 'createTask', data),
  taskCheckin: (data) => callCloud('app', 'taskCheckin', data),
  repairGoalDays: (data) => callCloud('app', 'repairGoalDays', data),

  // ===== 宠物 V6 =====
  pets: () => callCloud('app', 'listPets'),
  /** @deprecated V8.2 已废弃 — 请使用 createEgg + allocatePool 替代 */
  createPet: (data) => callCloud('app', 'createPet', data),
  createEgg: (data) => callCloud('app', 'createEgg', data || {}),
  /** V6 成长值系统：传入 { source: 'checkin'|'complete_goal'|'streak_bonus'|'ai_focus' } */
  hatchProgress: (data) => callCloud('app', 'hatchProgress', data || {}),
  /** V6 设置宠物性格描述 */
  setPersonality: (data) => callCloud('app', 'setPersonality', data || {}),
  /** V6 P4：设置性格期望（跨阶段升级时） */
  setPersonalityPrompt: (data) => callCloud('app', 'setPersonalityPrompt', data),
  /** V6 获取成长池信息 */
  getGrowthPool: () => callCloud('app', 'getGrowthPool'),
  /** 泉水系统：从池子分配经验到指定宠物 */
  allocatePool: (data) => callCloud('app', 'allocatePool', data || {}),
  /** 刷新蛋类型（更换为其他蛋） */
  refreshEgg: (data) => callCloud('app', 'refreshEgg', data || {}),
  /** 领取新手800点经验 */
  claimStarterXp: () => callCloud('app', 'claimStarterXp'),
  petUpdate: (id, data) => callCloud('app', 'updatePet', { id, ...data }),
  petDetail: (id) => callCloud('app', 'petDetail', { petId: id }),
  petInteract: (petId, action) => callCloud('app', 'petInteract', { pet_id: petId, action }),
  awakenPet: (petId) => callCloud('app', 'awakenPet', { pet_id: petId }),
  deletePet: (petId) => callCloud('app', 'deletePet', { pet_id: petId }),
  /** 宠物事件：标记事件已读 */
  markEventRead: (data) => callCloud('app', 'markEventRead', data || {}),
  petCollection: () => callCloud('app', 'petCollection'),
  petOverview: () => callCloud('app', 'listPets'),

  // ===== 成就 =====
  myAchievements: () => callCloud('app', 'listAchievements'),

  // ===== AI 时间胶囊 =====
  myCapsules: () => callCloud('app', 'myCapsules'),
  saveCapsule: (data) => callCloud('app', 'saveCapsule', data),

  // ===== 情绪 =====
  emotions: (data) => callCloud('app', 'recordEmotion', data),

  // ===== 成长日志 =====
  growthLogs: (params) => callCloud('app', 'listGrowthLogs', params || {}),
  addGrowthLog: (data) => callCloud('app', 'addGrowthLog', data || {}),

  // ===== 背包系统（V10.4：云端持久化 + 儿童节礼包）=====
  claimChildrenDayGift: () => callCloud('app', 'claimChildrenDayGift'),
  getBackpack: () => callCloud('app', 'getBackpack'),
  useBackpackItem: (itemName) => callCloud('app', 'useBackpackItem', { itemName }),
  syncEverOwnedSpecies: (speciesList) => callCloud('app', 'syncEverOwnedSpecies', { speciesList }),

  // ===== API Keys =====
  myApiKeys: () => callCloud('app', 'listApiKeys'),
  saveApiKey: (data) => callCloud('app', 'saveApiKey', data),

  // ===== V9.0 AI 大模型代理 =====
  aiTestConnection: (data) => callCloud('app', 'aiTestConnection', data),
  aiChat: (data) => callCloud('app', 'aiChat', data),
  aiPlannerChat: (data) => callCloud('app', 'aiPlannerChat', data),
  aiStartGenerate: (data) => callCloud('app', 'aiStartGenerate', data),
  aiDoGenerate: (data) => callCloud('app', 'aiDoGenerate', data),
  aiPollPlan: (data) => callCloud('app', 'aiPollPlan', data),

  // ===== 反馈 =====
  submitFeedback: (data) => callCloud('app', 'submitFeedback', data),

  // ===== 管理员接口（云端校验权限） =====
  adminDashboard: () => callCloud('app', 'adminDashboard'),
  adminListUsers: (params) => callCloud('app', 'adminListUsers', params || {}),
  adminSetRole: (data) => callCloud('app', 'adminSetRole', data),
  adminSetUserStatus: (data) => callCloud('app', 'adminSetUserStatus', data),
  adminResetPassword: (data) => callCloud('app', 'adminResetPassword', data),
  adminGetUserDetail: (userId) => callCloud('app', 'adminGetUserDetail', { userId }),
  adminListFeedbacks: (params) => callCloud('app', 'adminListFeedbacks', params || {}),
  adminResolveFeedback: (data) => callCloud('app', 'adminResolveFeedback', data),
  adminDeleteFeedback: (fbId) => callCloud('app', 'adminDeleteFeedback', { fbId }),
  adminListPets: (params) => callCloud('app', 'adminListPets', params || {}),
  adminEditPet: (data) => callCloud('app', 'adminEditPet', data),
  adminBroadcast: (data) => callCloud('app', 'adminBroadcast', data),
  /** V8.3 数据清理：删除所有非管理员账号及关联数据 */
  adminCleanupNonAdmin: () => callCloud('app', 'adminCleanupNonAdmin'),
  /** V8.3 删除单个用户及其所有关联数据 */
  adminDeleteUser: (data) => callCloud('app', 'adminDeleteUser', data),

  // ===== 兼容占位 =====
  health: () => Promise.resolve({ status: 'ok' }),
  refreshToken: () => Promise.reject('无需 refresh，云开发自动鉴权'),
};

module.exports = cloudApi;
