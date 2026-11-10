const cloudApi = require('../../utils/cloudApi')

const { parseUserSession } = require('../../utils/userSession')

function saveCloudSession(result) {
  const user = parseUserSession(result)
  const app = getApp()
  app.clearUserSession()
  app.setUserInfo(user)
  return user
}

function errorMessage(error, fallback, registration = false) {
  const raw = typeof error === 'string' ? error : error && (error.errMsg || error.message)
  const message = typeof raw === 'string' && raw.trim() ? raw : fallback
  if (/timeout|超时|-504003/i.test(message)) {
    return registration ? '请求超时，注册结果未确认，请先尝试登录' : '请求超时，请重试'
  }
  return message
}

Page({
  data: {
    // 模式切换
    mode: 'login',
    // 登录表单
    username: '',
    password: '',
    showPwd: false,
    loading: false,
    // 注册表单
    regUsername: '',
    regPassword: '',
    regPassword2: '',
    regNickname: '',
    showRegPwd: false,
    showRegPwd2: false,
    regLoading: false,
    // 协议
    agreed: false,
    showProtocolModal: false,
    // 微信登录
    hasCachedUser: false,
    wxLoginLoading: false,
  },

  onLoad(options) {
    if (options?.reason === 'account-banned') {
      wx.showToast({ title: '账号已封禁，请联系管理员', icon: 'none' })
    }
    const cached = wx.getStorageSync('cloud_userInfo')
    if (cached && cached.nickname) {
      this.setData({ hasCachedUser: true })
    }
  },

  onShow() {},

  // ===== 模式切换 =====
  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  // ===== 登录表单输入 =====
  onUsernameInput(e) { this.setData({ username: e.detail.value.trim() }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },
  togglePwd() { this.setData({ showPwd: !this.data.showPwd }) },
  toggleRegPwd() { this.setData({ showRegPwd: !this.data.showRegPwd }) },
  toggleRegPwd2() { this.setData({ showRegPwd2: !this.data.showRegPwd2 }) },

  // ===== 注册表单输入 =====
  onRegUsernameInput(e) { this.setData({ regUsername: e.detail.value.trim() }) },
  onRegPasswordInput(e) { this.setData({ regPassword: e.detail.value }) },
  onRegPassword2Input(e) { this.setData({ regPassword2: e.detail.value }) },
  onRegNicknameInput(e) { this.setData({ regNickname: e.detail.value.trim() }) },

  // 三个入口都只接受云端完整身份；失败不保存新会话、不跳转。
  async handleAccountLogin() {
    if (this.data.loading || this.data.regLoading || this.data.wxLoginLoading) return
    const { username, password, agreed } = this.data
    if (!agreed) return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    if (!username) return wx.showToast({ title: '请输入用户名', icon: 'none' })
    if (!password) return wx.showToast({ title: '请输入密码', icon: 'none' })
    this.setData({ loading: true })
    try {
      const user = saveCloudSession(await cloudApi.accountLogin({ username, password }))
      this.setData({ password: '' })
      wx.showToast({ title: (user.role === 'admin' ? '👑 管理员，' : '') + '欢迎回来，' + (user.nickname || user.username || '') + ' 🌿', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800)
    } catch (error) {
      wx.showToast({ title: errorMessage(error, '登录失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async handleAccountRegister() {
    if (this.data.loading || this.data.regLoading || this.data.wxLoginLoading) return
    const { regUsername, regPassword, regPassword2, regNickname, agreed } = this.data
    if (!agreed) return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    if (!regUsername) return wx.showToast({ title: '请设置用户名', icon: 'none' })
    if (regUsername.length < 2) return wx.showToast({ title: '用户名至少2个字符', icon: 'none' })
    if (!regPassword) return wx.showToast({ title: '请设置密码', icon: 'none' })
    if (regPassword.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' })
    if (regPassword !== regPassword2) return wx.showToast({ title: '两次密码不一致', icon: 'none' })
    this.setData({ regLoading: true })
    try {
      const user = saveCloudSession(await cloudApi.accountRegister({ username: regUsername, password: regPassword, nickname: regNickname || regUsername }))
      this.setData({ regPassword: '', regPassword2: '' })
      wx.showToast({ title: (user.is_new ? '注册成功！' : '欢迎回来') + (user.role === 'admin' ? '（管理员）🎉' : ' 🌿'), icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800)
    } catch (error) {
      wx.showToast({ title: errorMessage(error, '注册失败，请重试', true), icon: 'none' })
    } finally {
      this.setData({ regLoading: false })
    }
  },

  async handleWechatLoginQuick() {
    if (this.data.loading || this.data.regLoading || this.data.wxLoginLoading) return
    if (!this.data.agreed) return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    this.setData({ wxLoginLoading: true })
    try {
      const login = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }))
      if (!login.code) throw new Error('微信登录失败，请重试')
      // 微信身份继续由云函数getWXContext确认，前端不传入openid/role。
      const user = saveCloudSession(await cloudApi.authLogin({ nickname: '森林伙伴', avatar: '' }))
      wx.showToast({ title: user.is_new ? '欢迎加入AI自律森林！🎉' : (user.role === 'admin' ? '👑 管理员，欢迎回来 🌿' : '欢迎回来 🌿'), icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800)
    } catch (error) {
      wx.showToast({ title: errorMessage(error, '登录失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ wxLoginLoading: false })
    }
  },

  // ===== 旧版兼容：保留但不作为主要入口 =====
  handleWechatLogin() {
    return this.handleWechatLoginQuick()
  },

  // ===== 协议相关 =====
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },
  showProtocol() {
    this.setData({ showProtocolModal: true })
  },
  closeProtocol() {
    this.setData({ showProtocolModal: false })
  },
})
