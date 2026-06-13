const cloudApi = require('../../utils/cloudApi')

// ===== 管理员账号完整数据模板 =====
function buildAdminUserInfo(baseInfo) {
  const now = Date.now()
  return {
    ...baseInfo,
    id: baseInfo.id || ('admin_' + now),
    openid: baseInfo.openid || '',
    username: baseInfo.username || 'lzk',
    nickname: baseInfo.nickname || 'lzk',
    avatar: baseInfo.avatar || '',
    level: baseInfo.level || 5,
    total_xp: baseInfo.total_xp || 2680,
    streak_days: baseInfo.streak_days || 7,
    role: 'admin',
    is_new: baseInfo.is_new || false,
    created_at: baseInfo.created_at || now,
    // 扩展字段（供管理后台使用）
    _isLocalAdmin: true,
  }
}

// ===== 普通用户数据模板 =====
function buildNormalUserInfo(baseInfo) {
  return {
    ...baseInfo,
    role: baseInfo.role || 'user',
    _isLocalAdmin: false,
  }
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
  },

  onLoad() {
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

  // ===== 注册表单输入 =====
  onRegUsernameInput(e) { this.setData({ regUsername: e.detail.value.trim() }) },
  onRegPasswordInput(e) { this.setData({ regPassword: e.detail.value }) },
  onRegPassword2Input(e) { this.setData({ regPassword2: e.detail.value }) },
  onRegNicknameInput(e) { this.setData({ regNickname: e.detail.value.trim() }) },

  // ===== 账号密码登录 =====
  async handleAccountLogin() {
    const { username, password, agreed } = this.data

    if (!agreed) return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    if (!username) return wx.showToast({ title: '请输入用户名', icon: 'none' })
    if (!password) return wx.showToast({ title: '请输入密码', icon: 'none' })

    this.setData({ loading: true })

    try {
      let userInfo = await cloudApi.accountLogin({ username, password })

      if (userInfo) {
        // 管理员账号：补全本地数据
        if (userInfo.role === 'admin' || username === 'lzk') {
          userInfo = buildAdminUserInfo(userInfo)
        } else {
          userInfo = buildNormalUserInfo(userInfo)
        }

        const app = getApp()
        app.globalData.userInfo = userInfo
        wx.setStorageSync('cloud_userInfo', userInfo)

        wx.showToast({
          title: (userInfo.role === 'admin' ? '👑 管理员，' : '') + '欢迎回来，' + (userInfo.nickname || userInfo.username || '') + ' 🌿',
          icon: 'success',
        })
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' })
        }, 800)
      }
    } catch (err) {
      console.error('[Login] 账号登录失败:', err)
      const msg = typeof err === 'string' ? err : (err.message || '登录失败')

      // 云端超时时，如果是 lzk 则用本地管理员数据放行
      if ((msg.indexOf('timeout') >= 0 || msg.indexOf('超时') >= 0) && username === 'lzk') {
        console.warn('[Login] 云端超时，使用本地管理员模式')
        const localInfo = buildAdminUserInfo({ username: 'lzk', nickname: 'lzk' })
        const app = getApp()
        app.globalData.userInfo = localInfo
        wx.setStorageSync('cloud_userInfo', localInfo)
        wx.showToast({ title: '👑 管理员模式（离线）', icon: 'success' })
        setTimeout(() => { wx.switchTab({ url: '/pages/home/home' }) }, 800)
        return
      }

      const displayMsg = msg.indexOf('timeout') >= 0 ? '请求超时，请确认云函数已部署' : msg
      wx.showToast({ title: displayMsg, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // ===== 账号注册 =====
  async handleAccountRegister() {
    const { regUsername, regPassword, regPassword2, regNickname, agreed } = this.data

    if (!agreed) return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    if (!regUsername) return wx.showToast({ title: '请设置用户名', icon: 'none' })
    if (regUsername.length < 2) return wx.showToast({ title: '用户名至少2个字符', icon: 'none' })
    if (!regPassword) return wx.showToast({ title: '请设置密码', icon: 'none' })
    if (regPassword.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' })
    if (regPassword !== regPassword2) return wx.showToast({ title: '两次密码不一致', icon: 'none' })

    this.setData({ regLoading: true })

    try {
      let userInfo = await cloudApi.accountRegister({
        username: regUsername,
        password: regPassword,
        nickname: regNickname || regUsername,
      })

      if (userInfo) {
        // 第一个注册用户或 lzk → 管理员
        if (userInfo.role === 'admin' || userInfo.is_new || regUsername === 'lzk') {
          userInfo = buildAdminUserInfo(userInfo)
        } else {
          userInfo = buildNormalUserInfo(userInfo)
        }

        const app = getApp()
        app.globalData.userInfo = userInfo
        wx.setStorageSync('cloud_userInfo', userInfo)

        const roleTag = userInfo.role === 'admin' ? '（管理员）🎉' : ' 🌿'
        wx.showToast({
          title: (userInfo.is_new ? '注册成功！' : '欢迎回来') + roleTag,
          icon: 'success',
        })
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' })
        }, 800)
      }
    } catch (err) {
      console.error('[Login] 注册失败:', err)
      const msg = typeof err === 'string' ? err : (err.message || '注册失败')

      // 云端超时时，如果是 lzk 注册 → 本地创建管理员
      if ((msg.indexOf('timeout') >= 0 || msg.indexOf('超时') >= 0) && regUsername === 'lzk') {
        console.warn('[Login] 云端超时，本地创建管理员账号')
        const localInfo = buildAdminUserInfo({
          username: 'lzk', nickname: regNickname || 'lzk', is_new: true,
        })
        const app = getApp()
        app.globalData.userInfo = localInfo
        wx.setStorageSync('cloud_userInfo', localInfo)
        wx.showToast({ title: '🎉 注册成功！（管理员·离线模式）', icon: 'success' })
        setTimeout(() => { wx.switchTab({ url: '/pages/home/home' }) }, 800)
        return
      }

      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ regLoading: false })
    }
  },

  // ===== 微信一键登录 =====
  handleWechatLogin() {
    // getUserProfile 通过 open-type 触发，这里做协议检查
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    }
    // open-type="getUserProfile" 会自动弹出授权框，不需要手动调用
  },

  onGetUserProfile(e) {
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先同意用户协议', icon: 'none' })
    }

    const userProfile = e.detail
    if (!userProfile || !userProfile.userInfo) {
      return wx.showToast({ title: '需要授权才能使用', icon: 'none' })
    }

    const { nickName, avatarUrl } = userProfile.userInfo
    this.doWechatAuth(nickName, avatarUrl)
  },

  async doWechatAuth(nickName, avatarUrl) {
    this.setData({ loading: true })

    try {
      const userInfo = await cloudApi.authLogin({
        nickname: nickName,
        avatar: avatarUrl,
      })

      if (userInfo) {
        const app = getApp()
        app.globalData.userInfo = userInfo
        wx.setStorageSync('cloud_userInfo', userInfo)

        const welcomeMsg = userInfo.is_new ? '欢迎加入森林营地！🎉' : '欢迎回来 🌿'
        wx.showToast({ title: welcomeMsg, icon: 'success' })

        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' })
        }, 800)
      }
    } catch (err) {
      console.error('[Login] 微信登录失败:', err)
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
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
