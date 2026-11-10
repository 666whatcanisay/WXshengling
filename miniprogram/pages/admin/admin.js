const cloudApi = require('../../utils/cloudApi')

// ===== 工具函数 =====
function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatXp(xp) {
  if (!xp) return '0'
  if (xp >= 10000) return (xp / 10000).toFixed(1) + '万'
  return String(xp)
}

// V7 阶段映射（与主系统 petConstants.js 一致：EGG→BABY→YOUTH→ADULT→PERFECT）
const STAGE_MAP = {
  EGG:    { emoji: '🥚', label: '蛋' },
  BABY:   { emoji: '🐣', label: '幼体' },
  YOUTH:  { emoji: '🐱', label: '青年' },
  ADULT:  { emoji: '🦁', label: '成年' },
  PERFECT:{ emoji: '🦉', label: '完全体' },
}
const STAGE_KEYS = ['EGG', 'BABY', 'YOUTH', 'ADULT', 'PERFECT']
const STAGE_OPTIONS = ['蛋', '幼体', '青年', '成年', '完全体']

// 宠物心情映射（与主系统一致）
const MOOD_MAP = {
  happy:    '开心',
  normal:   '平静',
  sad:      '难过',
  excited:  '兴奋',
  sleepy:   '困倦',
  bored:    '无聊',
}
const MOOD_KEYS = Object.keys(MOOD_MAP)
const MOOD_OPTIONS = Object.values(MOOD_MAP)

// ===== 页面定义 =====
Page({
  data: {
    // 基础状态
    loading: true,
    isAdmin: false,
    adminLoadError: '',
    activeTab: 'overview',

    // Tab 配置
    tabs: [
      { key: 'overview', name: '数据看板', icon: '📊' },
      { key: 'users',    name: '用户管理', icon: '👥' },
      { key: 'pets',     name: '宠物管理', icon: '🐾' },
      { key: 'feedbacks',name: '反馈审核', icon: '💬' },
      { key: 'tools',    name: '系统工具', icon: '🔧' },
    ],

    // 数据看板
    stats: {},
    recentUsers: [],

    // 用户管理
    userList: [],
    userListTotal: 0,
    userPage: 1,
    userPageSize: 15,
    totalUserPages: 1,
    userKeyword: '',
    selectedRoleIdx: 0,
    roleOptions: ['全部角色', '管理员', '普通用户'],
    currentUserId: '',

    // 宠物管理
    petList: [],
    petListTotal: 0,
    petPage: 1,
    petPageSize: 20,

    // 反馈
    feedbackList: [],
    fbTypeFilter: 'all',
    fbTypeFilters: [
      { label: '全部', value: 'all' },
      { label: '建议', value: 'suggestion' },
      { label: 'Bug', value: 'bug' },
      { label: '其他', value: 'other' },
    ],

    // 系统工具
    bcTitle: '',
    bcContent: '',
    sendingBroadcast: false,

    // 清理操作
    cleaningUp: false,
    cleanupResult: '',
    cleanupCanStartNext: false,

    // 弹窗
    showDetailModal: false,
    detailUser: {},
    showPetEditModal: false,
    editPetId: '',
    editPetStageIdx: 0,
    editPetLevel: 1,
    editPetExp: 0,
    editPetMoodIdx: 0,
    editPetStageKeys: [],
    stageOptions: [],
    moodOptions: MOOD_OPTIONS,
    savingPet: false,
  },

  onLoad() {
    this.setData({ currentUserId: (wx.getStorageSync('cloud_userInfo') || {}).id || '' })
    this.loadAdminData()
  },

  // ========== 核心数据加载 ==========
  async loadAdminData() {
    this.setData({ loading: true, isAdmin: false, adminLoadError: '' })
    try {
      const res = await cloudApi.adminDashboard()
      if (!res?.stats) throw new Error('未收到有效的管理数据')
      this.setData({
        isAdmin: true,
        stats: res.stats,
        totalPlatformXpText: formatXp(res.stats.totalPlatformXp),
        recentUsers: (res.recentUsers || []).map(u => ({ ...u, created_atStr: fmtTime(u.created_at) })),
        feedbackList: (res.pendingFeedbacks || []).map(f => ({ ...f, created_at_str: fmtTime(f.created_at) })),
      })
      await Promise.all([this.loadUserList(1), this.loadPetList(1), this.loadFeedbacks('all')])
      return true
    } catch (err) {
      const message = typeof err === 'string' ? err : err.message
      if (message !== '无管理员权限') this.setData({ adminLoadError: message || '无法加载管理数据' })
      return false
    } finally {
      this.setData({ loading: false })
    }
  },

  // ========== Tab 切换 ==========
  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key })
  },

  // ========== 用户管理 ==========
  async loadUserList(page) {
    try {
      const params = { page, pageSize: this.data.userPageSize }
      if (this.data.userKeyword) params.keyword = this.data.userKeyword
      const roles = ['', 'admin', 'user']
      const roleVal = roles[this.data.selectedRoleIdx]
      if (roleVal) params.role = roleVal

      const res = await cloudApi.adminListUsers(params)
      if (res.code === -1) return

      const list = (res.list || []).map(u => ({ ...u, created_atStr: fmtTime(u.created_at) }))
      const totalPages = Math.max(1, Math.ceil((res.total || 0) / this.data.userPageSize))
      this.setData({
        userList: list,
        userListTotal: res.total || 0,
        userPage: page,
        totalUserPages: totalPages,
      })
    } catch (err) {
      console.error('[Admin] 用户列表失败:', err)
    }
  },

  onUserSearchInput(e) { this.setData({ userKeyword: e.detail.value }) },
  doUserSearch() { this.loadUserList(1) },

  onRoleFilterChange(e) {
    this.setData({ selectedRoleIdx: parseInt(e.detail.value) })
    this.loadUserList(1)
  },

  prevUserPage() {
    if (this.data.userPage <= 1) return
    this.loadUserList(this.data.userPage - 1)
  },
  nextUserPage() {
    if (this.data.userPage >= this.data.totalUserPages) return
    this.loadUserList(this.data.userPage + 1)
  },

  // 切换角色
  async toggleUserRole(e) {
    const { userId, role } = e.currentTarget.dataset
    const newRole = role === 'admin' ? 'user' : 'admin'
    const actionText = newRole === 'admin' ? '设为管理员' : '降为普通用户'

    const ok = await new Promise(resolve => {
      wx.showModal({ title: '确认操作', content: `确定要${actionText}吗？`, success: r => resolve(r.confirm) })
    })
    if (!ok) return

    try {
      wx.showLoading({ title: '处理中...' })
      const result = await cloudApi.adminSetRole({ userId, role: newRole })
      if (result?.success !== true) throw new Error('未收到有效的角色变更回执')
      wx.hideLoading()
      const userList = this.data.userList.map(u => u.id === userId ? { ...u, role: result.role || newRole } : u)
      this.setData({ userList })
      wx.showToast({ title: `${actionText}成功`, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (typeof err === 'string' ? err : err?.message) || '操作失败', icon: 'none' })
    }
  },

  // 封禁/解封
  async toggleUserStatus(e) {
    const { userId, status, cleanupReadyAt } = e.currentTarget.dataset
    const newStatus = cleanupReadyAt ? 'cancelCleanup' : status === 'banned' ? 'active' : 'banned'
    const actionText = cleanupReadyAt ? '取消待清理' : newStatus === 'banned' ? '封禁该用户' : '解除封禁'

    const ok = await new Promise(resolve => {
      wx.showModal({ title: '确认操作', content: `确定要${actionText}吗？`, confirmColor: '#c0392b', success: r => resolve(r.confirm) })
    })
    if (!ok) return

    try {
      wx.showLoading({ title: '处理中...' })
      const result = await cloudApi.adminSetUserStatus({ userId, status: newStatus })
      wx.hideLoading()
      const userList = this.data.userList.map(u => u.id === userId ? { ...u, status: result.status || newStatus, cleanupReadyAt: 0 } : u)
      this.setData({ userList })
      wx.showToast({ title: `${actionText}成功`, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 重置密码
  async resetUserPassword(e) {
    const { userId } = e.currentTarget.dataset
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '重置密码',
        content: '确定要将密码重置为 123456 吗？',
        confirmText: '确认重置',
        confirmColor: '#e67e22',
        success: r => resolve(r.confirm),
      })
    })
    if (!ok) return

    try {
      wx.showLoading({ title: '重置中...' })
      await cloudApi.adminResetPassword({ userId, newPassword: '123456' })
      wx.hideLoading()
      wx.showToast({ title: '已重置为 123456', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '重置失败', icon: 'none' })
    }
  },

  // 查看用户详情
  async showUserDetail(e) {
    const userId = e.currentTarget.dataset.id
    const request = this._userDetailRequest = {}
    this.setData({ showDetailModal: true, detailUser: {} })

    try {
      const res = await cloudApi.adminGetUserDetail(userId)
      if (this._userDetailRequest !== request) return
      if (!res?.user) throw new Error('未收到用户详情')
      this.setData({ detailUser: { ...res, user: { ...res.user, created_atStr: fmtTime(res.user.created_at) } } })
    } catch (err) {
      if (this._userDetailRequest !== request) return
      this.setData({ detailUser: { error: typeof err === 'string' ? err : err.message || '加载失败' } })
    }
  },
  closeDetailModal() {
    this._userDetailRequest = null
    this.setData({ showDetailModal: false })
  },

  // ========== 宠物管理 ==========
  async loadPetList(page) {
    try {
      const res = await cloudApi.adminListPets({ page, pageSize: this.data.petPageSize })
      if (res.code === -1) return
      this.setData({
        petList: (res.list || []).map(pet => {
          const stage = STAGE_MAP[pet.stage] || STAGE_MAP.EGG
          const mood = pet.mood || pet.status
          return { ...pet, stageEmoji: stage.emoji, stageLabel: stage.label, moodLabel: MOOD_MAP[mood] || '平静' }
        }),
        petListTotal: res.total || 0,
        petPage: page,
      })
    } catch (err) {
      console.error('[Admin] 宠物列表失败:', err)
    }
  },
  prevPetPage() { if (this.data.petPage > 1) this.loadPetList(this.data.petPage - 1) },
  nextPetPage() {
    if (this.data.petPage * this.data.petPageSize < this.data.petListTotal) this.loadPetList(this.data.petPage + 1)
  },

  // 编辑宠物弹窗
  editPetStage(e) {
    const id = e.currentTarget.dataset.id
    const pet = this.data.petList.find(p => p.id === id)
    if (!pet || pet.deleted_at || this.data.savingPet) return

    const hatched = pet.is_hatched ?? pet.stage !== 'EGG'
    const stageKeys = hatched ? STAGE_KEYS.slice(1) : STAGE_KEYS.slice(0, 1)
    const stageIdx = Math.max(0, stageKeys.indexOf(pet.stage))
    const moodIdx = MOOD_KEYS.indexOf(pet.mood || pet.status)
    const selectedMoodIdx = moodIdx < 0 ? MOOD_KEYS.indexOf('normal') : moodIdx

    this.setData({
      showPetEditModal: true,
      editPetId: id,
      editPetStageKeys: stageKeys,
      stageOptions: hatched ? STAGE_OPTIONS.slice(1) : STAGE_OPTIONS.slice(0, 1),
      editPetStageIdx: stageIdx,
      editPetLevel: pet.level || 1,
      editPetExp: pet.experience || 0,
      editPetMoodIdx: selectedMoodIdx,
    })
    this._petEditStart = { stage: stageKeys[stageIdx], mood: MOOD_KEYS[selectedMoodIdx], level: pet.level || 1, experience: pet.experience || 0 }
  },
  closePetModal() {
    if (!this.data.savingPet) this.setData({ showPetEditModal: false })
  },

  onPetStageChange(e) { this.setData({ editPetStageIdx: parseInt(e.detail.value) }) },
  onPetLevelInput(e) { this.setData({ editPetLevel: parseInt(e.detail.value) || 1 }) },
  onPetExpInput(e) { this.setData({ editPetExp: parseInt(e.detail.value) || 0 }) },
  onPetMoodChange(e) { this.setData({ editPetMoodIdx: parseInt(e.detail.value) }) },

  async savePetEdit() {
    if (this.data.savingPet || !this._petEditStart) return
    const { editPetId, editPetStageKeys, editPetStageIdx, editPetMoodIdx, editPetLevel, editPetExp } = this.data
    const fields = { stage: editPetStageKeys[editPetStageIdx], mood: MOOD_KEYS[editPetMoodIdx],
      level: Math.min(99, Math.max(1, editPetLevel)), experience: Math.max(0, editPetExp) }
    const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && value !== this._petEditStart[key]))
    if (!Object.keys(changes).length) return this.closePetModal()
    try {
      this.setData({ savingPet: true })
      const receipt = await cloudApi.adminEditPet({ petId: editPetId, ...changes })
      if (!receipt?.success) throw new Error('保存结果未确认')
      this.setData({ savingPet: false, showPetEditModal: false })
      wx.showToast({ title: '保存成功', icon: 'success' })
      this.loadPetList(this.data.petPage)
    } catch (err) {
      this.setData({ savingPet: false })
      wx.showToast({ title: typeof err === 'string' ? err : err.message || '保存失败', icon: 'none' })
    }
  },

  // ========== 反馈审核 ==========
  async loadFeedbacks(type) {
    try {
      const params = type && type !== 'all' ? { type, limit: 100 } : { limit: 100 }
      const res = await cloudApi.adminListFeedbacks(params)
      if (Array.isArray(res)) {
        this.setData({ feedbackList: res.map(f => ({ ...f, created_at_str: fmtTime(f.created_at) })) })
      }
    } catch (err) {
      console.error('[Admin] 反馈列表失败:', err)
    }
  },

  onFbTypeFilter(e) {
    const val = e.currentTarget.dataset.value
    this.setData({ fbTypeFilter: val })
    this.loadFeedbacks(val)
  },

  async resolveFeedback(e) {
    const fbId = e.currentTarget.dataset.id
    const ok = await new Promise(resolve => {
      wx.showModal({ title: '标记已处理', content: '确定将此反馈标记为已处理？', success: r => resolve(r.confirm) })
    })
    if (!ok) return

    try {
      await cloudApi.adminResolveFeedback({ fbId })
      wx.showToast({ title: '已标记', icon: 'success' })
      this.loadFeedbacks(this.data.fbTypeFilter)
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async deleteFeedback(e) {
    const fbId = e.currentTarget.dataset.id
    const ok = await new Promise(resolve => {
      wx.showModal({ title: '删除反馈', content: '确定删除此反馈吗？（不可恢复）', confirmColor: '#c0392b', success: r => resolve(r.confirm) })
    })
    if (!ok) return

    try {
      await cloudApi.adminDeleteFeedback(fbId)
      wx.showToast({ title: '已删除', icon: 'success' })
      this.loadFeedbacks(this.data.fbTypeFilter)
      // 更新统计
      this.setData({ 'stats.totalFeedbacks': Math.max(0, (this.data.stats.totalFeedbacks || 1) - 1) })
    } catch (err) {
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  // ========== 系统工具 ==========
  onBcTitleInput(e) { this.setData({ bcTitle: e.detail.value }) },
  onBcContentInput(e) { this.setData({ bcContent: e.detail.value }) },

  async sendBroadcast() {
    if (!this.data.bcTitle.trim()) { wx.showToast({ title: '请输入标题', icon: 'none' }); return }
    if (!this.data.bcContent.trim()) { wx.showToast({ title: '请输入内容', icon: 'none' }); return }

    try {
      this.setData({ sendingBroadcast: true })
      await cloudApi.adminBroadcast({ title: this.data.bcTitle, content: this.data.bcContent })
      this.setData({ sendingBroadcast: false, bcTitle: '', bcContent: '' })
      wx.showToast({ title: '广播发布成功', icon: 'success' })
    } catch (err) {
      this.setData({ sendingBroadcast: false })
      wx.showToast({ title: '发布失败: ' + (err.message || ''), icon: 'none' })
    }
  },

  refreshData() {
    wx.showLoading({ title: '刷新中...' })
    this.loadAdminData().then(ok => {
      wx.hideLoading()
      if (ok) wx.showToast({ title: '数据已更新', icon: 'success' })
    })
  },

  // ========== 删除用户 ==========
  async deleteUser(e) {
    const { userId, username, cleanupReadyAt } = e.currentTarget.dataset
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '⚠️ 删除用户',
        content: cleanupReadyAt
          ? `确认删除「${username}」及其关联数据库记录？此操作不可恢复。`
          : `先暂停「${username}」的账号，约 60 秒后可再次确认删除。等待期间可以取消。`,
        confirmText: cleanupReadyAt ? '确认删除' : '暂停账号',
        confirmColor: '#c0392b',
        success: r => resolve(r.confirm),
      })
    })
    if (!ok) return

    try {
      wx.showLoading({ title: '删除中...' })
      const result = await cloudApi.adminDeleteUser({ userId })
      if (result?.deletedUsers !== 1) throw new Error('未收到新版删除回执，请刷新列表核对')
      wx.hideLoading()
      wx.showToast({ title: '已删除', icon: 'success' })
      this.loadUserList(this.data.userPage)
      this.refreshData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (typeof err === 'string' ? err : err?.message) || '删除失败，请刷新后重试', icon: 'none' })
      this.loadUserList(this.data.userPage)
    }
  },

  // ========== 一键清理非管理员 ==========
  async cleanupNonAdmin(e) {
    if (this.data.cleaningUp) return
    const cancel = e?.currentTarget?.dataset?.cancel === true
    const newBatch = e?.currentTarget?.dataset?.newBatch === true
    this.setData({ cleaningUp: true })
    try {
      const batch = await cloudApi.adminCleanupNonAdmin({ phase: 'status' })
      if (!['idle', 'pending', 'done', 'cancelled'].includes(batch?.status)) throw new Error('未收到有效的清理批次')
      const pending = batch.status === 'pending'
      if (cancel && !pending) {
        this.setData({ cleanupResult: '当前没有待确认批次' })
        return
      }
      let d = batch
      if ((batch.status !== 'done' || newBatch) && !(newBatch && pending)) {
        const phase = cancel ? 'cancel' : pending ? 'finish' : 'prepare'
        const confirmations = {
          cancel: { content: `取消本批 ${batch.targetCount} 个账号的清理，并恢复原账号状态？`, label: '取消批次' },
          finish: { content: `确认删除首次选定的 ${batch.targetCount} 个账号及其关联记录？等待期间注册的账号不在本批内。`, label: '确认删除' },
          prepare: { content: '先暂停当前非管理员账号并保存名单。约 60 秒后可确认删除本批，也可以取消并恢复账号。', label: '暂停本批' },
        }
        const confirmation = confirmations[phase]
        const ok = await new Promise(resolve => {
          wx.showModal({ title: '清理账号确认', content: confirmation.content, confirmText: confirmation.label,
            confirmColor: '#c0392b', success: r => resolve(r.confirm), fail: () => resolve(false) })
        })
        if (!ok) return
        d = await cloudApi.adminCleanupNonAdmin({ phase, batchId: batch.batchId })
      }
      if (d?.noTargets) {
        this.setData({ cleanupResult: '当前没有需要清理的非管理员账号' })
        return
      }
      if (d?.status === 'pending') {
        const seconds = Math.ceil((d.readyAt - Date.now()) / 1000)
        const ready = seconds > 0 ? `约 ${seconds} 秒后可再次确认删除` : '现在可再次确认删除'
        this.setData({ cleanupCanStartNext: false, cleanupResult: `本批 ${d.targetCount} 个账号已暂停，${ready}。` })
        this.loadUserList(this.data.userPage)
        return
      }
      if (d?.status === 'cancelled') {
        this.setData({ cleanupCanStartNext: false, cleanupResult: '已取消本批清理并恢复账号状态' })
        this.loadUserList(this.data.userPage)
        return
      }
      if (d?.status !== 'done' || !Number.isInteger(d.deletedUsers) || !Array.isArray(d.keptUsers)) throw new Error('未收到有效的清理结果')
      const errors = Array.isArray(d.errors) ? d.errors : []
      let text = [
        errors.length ? '⚠️ 清理未全部完成' : '✅ 清理完成',
        '删除用户: ' + (d.deletedUsers || 0),
        '删除宠物: ' + (d.deletedPets || 0),
        '删除经验池: ' + (d.deletedPools || 0),
        '删除日志: ' + (d.deletedLogs || 0),
        '保留账号: ' + (d.keptUsers.join(', ') || '(无)'),
      ].join('\n')

      if (errors.length > 0) {
        text += '\n\n⚠️ 部分失败:\n' + errors.join('\n')
      }

      this.setData({ cleanupCanStartNext: true, cleanupResult: text })
      // 刷新列表
      this.loadUserList(1)
      this.refreshData()
    } catch (err) {
      const message = (typeof err === 'string' ? err : err?.message) || '请刷新后重试'
      this.setData({ cleanupCanStartNext: false, cleanupResult: message })
      this.loadUserList(this.data.userPage)
    } finally {
      this.setData({ cleaningUp: false })
    }
  },

  goBack() { wx.navigateBack() },
})
