const cloudApi = require("./utils/cloudApi");

App({
  globalData: {
    env: "cloud1-d5gz9j6zh654f4b36",
    apiBase: "",
    userInfo: null,
    cloudReady: false,
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
    // 仅从本地缓存恢复（用于展示已登录状态，不做跳转）
    const cached = wx.getStorageSync("cloud_userInfo");
    if (cached) {
      this.globalData.userInfo = cached;
    }
  },

  updateToken() {},
  clearSession() {
    wx.removeStorageSync("cloud_userInfo");
    this.globalData.userInfo = null;
  },

  get isLoggedIn() { return !!this.globalData.userInfo; },
});
