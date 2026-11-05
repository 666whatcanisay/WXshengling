const cloudApi = require("./utils/cloudApi");
const cloudConfig = require("./utils/cloudConfig");

App({
  globalData: {
    env: cloudConfig.env,
    apiBase: "",
    userInfo: null,
    cloudReady: false,
    // 当前用户的 openid（登录后由云端返回）
    currentOpenid: '',
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }

    try {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
      this.globalData.cloudReady = true;
      console.log("[App] 云开发初始化成功");
    } catch (err) {
      console.error("[App] 云开发初始化失败:", err);
      this.globalData.cloudReady = false;
    }

    // 不再自动登录！登录由用户在登录页面主动触发
    // 仅从本地缓存恢复（用于展示已登录状态，不做数据加载）
    const cached = wx.getStorageSync("cloud_userInfo");
    if (cached) {
      this.globalData.userInfo = cached;
      // 恢复缓存的openid
      if (cached.openid) {
        this.globalData.currentOpenid = cached.openid;
      }
    }
  },

  /**
   * 【核心安全方法】清除用户会话所有缓存
   * 每次切换用户（登录/注册/退出）时必须调用
   * 确保不会出现上一个用户的数据残留
   */
  clearUserSession() {
    console.log('[App] clearUserSession: 清除用户会话缓存');

    // 1. 清除全局用户信息
    this.globalData.userInfo = null;
    this.globalData.currentOpenid = '';

    // 2. 清除本地存储的用户信息
    wx.removeStorageSync('cloud_userInfo');

    // 3. 清除所有页面级缓存（通过事件通知各页面刷新）
    try {
      // 清除可能存在的其他用户相关缓存key
      var keysToClear = [
        'last_dashboard_data',
        'last_pets_data',
        'last_goals_data',
        'cached_tasks',
        'cached_checkin',
      ];
      keysToClear.forEach(function(key) {
        try { wx.removeStorageSync(key); } catch(e) {}
      });
    } catch(e) {}

    console.log('[App] clearUserSession: 会话已清除');
  },

  /**
   * 设置当前登录用户信息（统一入口）
   * @param {object} userInfo - 用户信息对象
   */
  setUserInfo(userInfo) {
    if (!userInfo) return;

    this.globalData.userInfo = userInfo;

    // 存储openid供后续校验使用
    if (userInfo.openid) {
      this.globalData.currentOpenid = userInfo.openid;
    }

    // 持久化到本地
    wx.setStorageSync('cloud_userInfo', userInfo);

    console.log('[App] setUserInfo: 用户已设置', userInfo.nickname || userInfo.username, 'openid:', userInfo.openid || '(未提供)');
  },

  updateToken() {},

  // 开发者工具 Console：getApp().checkCloudConnection().then(console.log)
  // 只查询现有身份/今日任务，不登录注册、不写业务数据，不输出 openid。
  async checkCloudConnection() {
    const user = await cloudApi.login();
    if (!user || !user.id || !user.openid) throw new Error('云端身份尚未确认');
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const tasks = await cloudApi.tasks({ date });
    if (!Array.isArray(tasks)) throw new Error('任务读取返回格式异常');
    return { env: cloudConfig.env, functions: cloudConfig.functions,
      username: user.username, role: user.role,
      cachedOffline: this.isOfflineMode, loginVerified: true, tasksReadable: true };
  },
  
  /** 旧接口兼容：调用 clearUserSession */
  clearSession() {
    this.clearUserSession();
  },

  get isLoggedIn() { return !!this.globalData.userInfo; },

  /** 判断是否为离线模式（云函数超时时使用的本地管理员模式） */
  get isOfflineMode() {
    return !!(this.globalData.userInfo && this.globalData.userInfo._offlineMode);
  },
});
