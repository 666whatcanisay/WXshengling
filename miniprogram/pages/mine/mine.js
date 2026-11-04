const cloudApi = require('../../utils/cloudApi')
const PetConst = require('../../utils/petConstants')

function getPetEmoji(stage) {
  return { egg: '🥚', baby: '🐥', youth: '🐾', adult: '🦦', perfect: '⭐' }[stage] || '🥚'
}
function getStageText(stage) {
  return { egg: '蛋', baby: '幼年', youth: '青年', adult: '成年', perfect: '完美' }[stage] || '蛋'
}

// 图鉴用到的映射（避免每次重新构建）
function buildCollectionMaps() {
  const speciesMap = {}
  for (const [k, v] of Object.entries(PetConst.SPECIES)) speciesMap[k] = v

  const rarityColorMap = {}
  for (const [k, v] of Object.entries(PetConst.RARITY)) rarityColorMap[k] = { name: v.name, color: v.color }

  const stageTextMap = { egg: '蛋', baby: '幼年', youth: '青年', adult: '成年', perfect: '完美' }
  const eggStageTextMap = { egg: '神秘蛋', crack: '裂纹蛋', glow: '发光蛋', shake: '晃动蛋', hatched: '已孵化' }

  // 亲密度快速映射
  const bondLevelMap = {}
  for (const lv of PetConst.BOND_LEVELS) bondLevelMap[lv.min] = `${lv.icon} ${lv.name}`
  for (let i = 1; i < 1000; i++) if (!bondLevelMap[i]) {
    const found = PetConst.BOND_LEVELS.filter(l => l.min <= i).pop()
    if (found) bondLevelMap[i] = `${found.icon} ${found.name}`
  }

  return { speciesMap, rarityColorMap, stageTextMap, eggStageTextMap, bondLevelMap }
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
    maxPets: 3,
    collectionCount: 0,
    myOpenid: '',

    // ===== 宠物图鉴 =====
    showCollection: false,
    colActiveTab: 'current',
    currentPets: [],
    releasedPets: [],
    stats: {},
    rarestDisplay: { icon: '🐾', rarityName: '普通', rarityColor: '#95A5A6' },
    speciesMap: {},
    rarityColorMap: {},
    stageTextMap: {},
    eggStageTextMap: {},
    bondLevelMap: {},

    // ===== 放行确认 =====
    showDeleteConfirm: false,
    deleteTargetId: '',
    deleteTargetName: '',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 })
    }
    // 【安全修复】离线模式不加载云端数据，避免串号
    var app = getApp()
    if (app.isOfflineMode) {
      console.warn('[Mine] 离线模式，跳过云端数据加载')
      this.setData({ isLoading: false })
      return
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

      let myPet = null, petEmoji = '', petStageText = ''
      if (activePet) {
        myPet = activePet
        if (activePet.is_hatched === false) {
          petEmoji = '🥚'
          const eggTypeInfo = PetConst.getEggTypeDisplay(activePet.egg_type)
          const eggName = eggTypeInfo ? eggTypeInfo.name : '神秘蛋'
          const gv = activePet.growth_value || 0
          petStageText = `${eggName} · 成长值 ${gv}/100`
        } else {
          const spInfo = PetConst.getSpeciesInfo(activePet.species)
          petEmoji = spInfo.icon || getPetEmoji(activePet.stage)
          const stageInfo = PetConst.getStageInfo(activePet.stage)
          petStageText = `${spInfo.name || ''} · ${stageInfo.name} · Lv${activePet.level || 1}`
        }
      }

      let isAdmin = (user.role === 'admin')
      if (!isAdmin) {
        const cached = wx.getStorageSync('cloud_userInfo') || {}
        isAdmin = (cached.role === 'admin' || cached._isLocalAdmin)
      }

      // 获取当前宠物数量用于图鉴徽章
      let collectionCount = 0
      try {
        const petsRaw = await cloudApi.pets()
        // 【V8.5修复】兼容 callCloud 双重解包
        const petsList = Array.isArray(petsRaw) ? petsRaw : (petsRaw && petsRaw.data ? petsRaw.data : [])
        collectionCount = Array.isArray(petsList) ? petsList.filter(p => !p.deleted_at).length : 0
      } catch (e) { /* ignore */ }

      this.setData({
        userInfo: { nickname, username: user.username || '', avatar: user.avatar || '' },
        levelInfo: { level, total_xp: totalXp },
        achievementCount: (dashboard.achievements || []).length,
        avatarText: (nickname[0] || '森'),
        totalXp,
        signInDays,
        myPet,
        petEmoji,
        petStageText,
        isAdmin,
        collectionCount,
        myOpenid: getApp().globalData.currentOpenid ||
          (getApp().globalData.userInfo || {}).openid ||
          (wx.getStorageSync('cloud_userInfo') || {}).openid ||
          '(未获取)',
      })
    } catch (err) {
      console.warn('[Mine] 云端加载失败，使用本地缓存:', err)
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
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: async (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        try {
          const uploadRes = await wx.cloud.uploadFile({ cloudPath: `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`, filePath: tempFilePath })
          await cloudApi.updateMe({ avatar: uploadRes.fileID })
          this.setData({ 'userInfo.avatar': uploadRes.fileID })
          const cached = wx.getStorageSync('cloud_userInfo') || {}
          cached.avatar = uploadRes.fileID
          wx.setStorageSync('cloud_userInfo', cached)
          wx.showToast({ title: '头像更新成功', icon: 'success' })
        } catch (e) {
          console.error('[Mine] 上传头像失败:', e)
          wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        } finally { wx.hideLoading() }
      },
    })
  },

  goGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }) },
  goGrowthReport() { wx.navigateTo({ url: '/pages/growth-report/growth-report' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/pets' }) },
  goAdmin() {
    // 仅当服务端已确认管理员身份时才允许进入
    if (!this.data.isAdmin) {
      wx.showToast({ title: '无管理员权限', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/admin/admin' })
  },
  goAchievements() { wx.navigateTo({ url: '/pages/achievements/achievements' }) },
  goEmotion() { wx.navigateTo({ url: '/pages/emotion/emotion' }) },
  goAIConfig() { wx.navigateTo({ url: '/pages/ai-config/ai-config' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/feedback' }) },
  logout() {
    const app = getApp(); app.clearSession()
    wx.reLaunch({ url: '/pages/login/login' })
  },

  /** 复制 OpenID 到剪贴板 */
  copyOpenid(e) {
    const id = e.currentTarget.dataset.id || ''
    wx.setClipboardData({ data: id, success: () => { wx.showToast({ title: '已复制', icon: 'success' }) } })
  },

  // ===== 宠物图鉴 =====

  /** 打开图鉴弹窗 */
  async openCollection() {
    wx.showLoading({ title: '加载图鉴...' })
    this.setData({ showCollection: true })

    try {
      const raw = await cloudApi.petCollection()
      console.log('[Mine-Dex] raw type=', typeof raw, 'keys=', raw ? Object.keys(raw).slice(0,5) : 'null')
      console.log('[Mine-Dex] raw=', JSON.stringify(raw).substring(0, 300))
      // 【V8.5修复】兼容 callCloud 双重解包：已解包时 raw 直接是数据对象
      const res = (raw && raw.success !== undefined) ? raw : { success: true, data: raw || {} }
      console.log('[Mine-Dex] res.success=', res.success, 'has data=', !!res.data)
      if (!res.success) throw new Error(res.message)

      const data = res.data || {}
      console.log('[Mine-Dex] data keys=', Object.keys(data), 'current=', Array.isArray(data.current) ? data.current.length : 'not array')
      const maps = buildCollectionMaps()
      const { speciesMap, rarityColorMap, stageTextMap, eggStageTextMap, bondLevelMap } = maps

      // 预计算当前宠物展示属性（WXML不支持复杂表达式）
      const currentPets = (data.current || []).map(p => {
        const spInfo = speciesMap[p.species] || {}
        const rInfo = rarityColorMap[p.rarity] || { name: '普通', color: '#95A5A6' }
        return {
          ...p,
          _icon: p.is_hatched ? (spInfo.icon || '🐾') : '🥚',
          _rarityName: rInfo.name || '',
          _rarityColor: rInfo.color || '#95A5A6',
          _stageText: p.is_hatched
            ? (stageTextMap[p.stage] || p.stage)
            : (eggStageTextMap[p.egg_stage] || '蛋'),
          _bondLevel: bondLevelMap[p.bond || 0] || '⚪陌生',
        }
      })

      // 预计算历史宠物展示属性
      const releasedPets = (data.released || []).map(p => {
        const spInfo = speciesMap[p.species] || {}
        const rInfo = rarityColorMap[p.rarity] || { name: '普通', color: '#95A5A6' }
        return {
          ...p,
          released_at_text: p.released_at ? formatRelativeTime(p.released_at) : '',
          _icon: spInfo.icon || '🐾',
          _rarityName: rInfo.name || '',
          _rarityColor: rInfo.color || '#95A5A6',
          _stageText: stageTextMap[p.stage] || p.stage,
        }
      })

      // 预计算最稀有宠物展示
      let rarestDisplay = { icon: '🐾', rarityName: '普通', rarityColor: '#95A5A6' }
      if (data.stats && data.stats.rarest_pet) {
        const rp = data.stats.rarest_pet
        const spInfo = speciesMap[rp.species] || {}
        const rInfo = rarityColorMap[rp.rarity] || { name: '普通', color: '#95A5A6' }
        rarestDisplay = {
          icon: spInfo.icon || '🐾',
          rarityName: rInfo.name || '普通',
          rarityColor: rInfo.color || '#95A5A6',
        }
      }

      this.setData({
        currentPets,
        releasedPets,
        stats: data.stats || {},
        rarestDisplay,
        colActiveTab: currentPets.length > 0 ? 'current' : 'released',
        ...maps,
      })
    } catch (e) {
      // 【V8.5诊断】输出真实错误信息
      console.log('[Mine-Dex] ERROR:', e.message || e, 'stack=', (e.stack || '').substring(0, 200))
      console.log('[Mine] 图鉴接口暂不可用，显示空状态')
      this.setData({
        currentPets: [],
        releasedPets: [],
        stats: { total: 0, current: 0, released: 0, awakened: 0 },
      })
    } finally {
      wx.hideLoading()
    }
  },

  closeCollection() {
    this.setData({ showCollection: false })
  },

  switchColTab(e) {
    this.setData({ colActiveTab: e.currentTarget.dataset.tab || 'current' })
  },

  /** 从图鉴跳转到宠物森林 */
  goPetsFromCollection() {
    this.closeCollection()
    setTimeout(() => wx.switchTab({ url: '/pages/pets/pets' }), 200)
  },

  /** 查看宠物详情 */
  goPetDetail(e) {
    const id = e.currentTarget.dataset.id
    this.closeCollection()
    setTimeout(() => wx.switchTab({ url: '/pages/pets/pets' }), 200)
  },

  // ===== 放行宠物 =====

  confirmDeletePet(e) {
    const { id, name } = e.currentTarget.dataset
    this.setData({
      showDeleteConfirm: true,
      deleteTargetId: id,
      deleteTargetName: name,
    })
  },

  cancelDelete() {
    this.setData({ showDeleteConfirm: false, deleteTargetId: '', deleteTargetName: '' })
  },

  async doDeletePet() {
    const petId = this.data.deleteTargetId
    if (!petId) return

    wx.showLoading({ title: '放行中...' })
    try {
      const raw = await cloudApi.deletePet(petId)
      // 【V8.5修复】兼容 callCloud 双重解包
      const res = (raw && raw.success !== undefined) ? raw : { success: !!raw, message: raw && raw.message ? raw.message : '' }
      wx.hideLoading()

      if (res.success) {
        wx.showToast({ title: res.message || '已放行', icon: 'success' })
        this.setData({ showDeleteConfirm: false, deleteTargetId: '', deleteTargetName: '' })
        // 刷新图鉴数据
        await this.openCollection()
        // 刷新主页面宠物信息
        this.loadUserData()
      } else {
        wx.showToast({ title: res.message || '放行失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '放行失败', icon: 'none' })
    }
  },
})

/** 相对时间格式化 */
function formatRelativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  const d = new Date(ts)
  return `${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`
}
