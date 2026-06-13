const cloudApi = require('../../utils/cloudApi')

function getPetEmoji(stage) {
  return { egg: '🥚', baby: '🐥', adult: '🦦' }[stage] || '🥚'
}
function getStageText(stage) {
  return { egg: '蛋', baby: '幼年', adult: '成年' }[stage] || '蛋'
}

Page({
  data: {
    isLoading: true,
    userInfo: {},
    levelInfo: {},
    achievementCount: 0,
    avatarText: '',
    totalXp: 0,
    signInDays: 0,
    myPet: null,
    petEmoji: '',
    petStageText: '',
    isAdmin: false,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 })
    }
    this.loadUserData()
  },

  async loadUserData() {
    wx.showLoading({ title: '加载中...' })
    this.setData({ isLoading: true })

    try {
      const dashboard = await cloudApi.dashboard()
      const user = dashboard.user || {}
      const activePet = dashboard.activePet || null
      const totalXp = user.total_xp || 0
      const signInDays = user.streak_days || 0
      const level = Math.floor(totalXp / 100) + 1
      const nickname = user.nickname || user.username || '森林居民'
      const username = user.username || ''
      const avatar = user.avatar || ''

      // 宠物信息
      let myPet = null, petEmoji = '', petStageText = ''
      if (activePet) {
        myPet = activePet
        petEmoji = getPetEmoji(activePet.stage)
        petStageText = getStageText(activePet.stage)
      }

      // 角色判断：优先用 dashboard 返回的，兜底用缓存中的
      let isAdmin = (user.role === 'admin')
      if (!isAdmin) {
        const cached = wx.getStorageSync('cloud_userInfo') || {}
        isAdmin = (cached.role === 'admin' || cached._isLocalAdmin)
      }

      this.setData({
        userInfo: { nickname, username, avatar },
        levelInfo: { level, total_xp: totalXp },
        achievementCount: (dashboard.achievements || []).length,
        avatarText: (nickname[0] || '森'),
        totalXp,
        signInDays,
        myPet,
        petEmoji,
        petStageText,
        isAdmin,
      })
    } catch (err) {
      console.warn('[Mine] 云端加载失败，使用本地缓存:', err)
      // 云端失败 → 使用本地缓存数据
      const cached = wx.getStorageSync('cloud_userInfo') || {}
      if (cached.nickname || cached.username) {
        const totalXp = cached.total_xp || 0
        const level = cached.level || Math.floor(totalXp / 100) + 1
        const nickname = cached.nickname || cached.username || '森林居民'
        this.setData({
          userInfo: { nickname, username: cached.username || '', avatar: cached.avatar || '' },
          levelInfo: { level, total_xp: totalXp },
          achievementCount: 0,
          avatarText: (nickname[0] || '森'),
          totalXp,
          signInDays: cached.streak_days || 0,
          isAdmin: (cached.role === 'admin' || cached._isLocalAdmin),
        })
      }
    } finally {
      this.setData({ isLoading: false })
      wx.hideLoading()
    }
  },

  // ===== 头像上传 =====
  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: async (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        try {
          // 上传到云存储
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
            filePath: tempFilePath,
          })
          const fileID = uploadRes.fileID
          // 获取临时 URL 用于显示（云存储 fileID 可直接作为 image src）
          await cloudApi.updateMe({ avatar: fileID })

          this.setData({
            'userInfo.avatar': fileID,
          })
          // 同步更新缓存
          const cached = wx.getStorageSync('cloud_userInfo') || {}
          cached.avatar = fileID
          wx.setStorageSync('cloud_userInfo', cached)

          wx.showToast({ title: '头像更新成功', icon: 'success' })
        } catch (e) {
          console.error('[Mine] 上传头像失败:', e)
          wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      },
    })
  },

  goGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }) },
  goGrowthReport() { wx.navigateTo({ url: '/pages/growth-report/growth-report' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/pets' }) },
  goAdmin() {
    // 进入管理后台前，确保本地缓存有管理员标识
    const cached = wx.getStorageSync('cloud_userInfo') || {}
    if (cached.role !== 'admin') {
      cached.role = 'admin'
      wx.setStorageSync('cloud_userInfo', cached)
    }
    wx.navigateTo({ url: '/pages/admin/admin' })
  },
  goAchievements() { wx.navigateTo({ url: '/pages/achievements/achievements' }) },
  goEmotion() { wx.navigateTo({ url: '/pages/emotion/emotion' }) },
  goAIConfig() { wx.navigateTo({ url: '/pages/ai-config/ai-config' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/feedback' }) },

  logout() {
    const app = getApp()
    app.clearSession()
    wx.reLaunch({ url: '/pages/login/login' })
  },
})
