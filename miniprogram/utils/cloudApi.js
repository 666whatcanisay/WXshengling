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

        // 判断是否需要重试
        const isNetworkError = rawMsg.indexOf('timeout') >= 0 ||
          rawMsg.indexOf('fail') >= 0 ||
          rawMsg.indexOf('network') >= 0 ||
          rawMsg.indexOf('abort') >= 0;

        if (attempt < MAX_RETRIES && isNetworkError) {
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
          const friendlyMsg = rawMsg.indexOf('timeout') >= 0 ? '请求超时，请检查网络后重试' : rawMsg;
          reject(friendlyMsg);
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

  // ===== 宠物 =====
  pets: () => callCloud('app', 'listPets'),
  createPet: (data) => callCloud('app', 'createPet', data),
  petUpdate: (id, data) => callCloud('app', 'updatePet', { id, ...data }),
  petDetail: (id) => callCloud('app', 'listPets').then(d => {
    const list = Array.isArray(d) ? d : (d.data || d || []);
    return list.find(p => p.id === id) || null;
  }),
  petOverview: () => callCloud('app', 'listPets'),

  // ===== 成就 =====
  myAchievements: () => callCloud('app', 'listAchievements'),

  // ===== 情绪 =====
  emotions: (data) => callCloud('app', 'recordEmotion', data),

  // ===== 成长日志 =====
  growthLogs: (params) => callCloud('app', 'listGrowthLogs', params || {}),

  // ===== API Keys =====
  myApiKeys: () => callCloud('app', 'listApiKeys'),
  saveApiKey: (data) => callCloud('app', 'saveApiKey', data),

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

  // ===== 兼容占位 =====
  health: () => Promise.resolve({ status: 'ok' }),
  refreshToken: () => Promise.reject('无需 refresh，云开发自动鉴权'),
};

module.exports = cloudApi;
