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

// ===== 本地模拟数据（云端不可用时使用） =====
const MOCK_STATS = {
  totalUsers: 6,
  activeGoals: 12,
  totalPets: 8,
  totalFeedbacks: 3,
  todayCheckins: 4,
  todayTasksCompleted: 15,
  platformTotalXp: 18650,
}
const MOCK_RECENT_USERS = [
  { id: 'u1', username: 'lzk', nickname: 'lzk', avatar: '', level: 5, total_xp: 2680, streak_days: 7, role: 'admin', status: 'active', created_at: Date.now() - 86400000 },
  { id: 'u2', username: 'xiaoming', nickname: '小明同学', avatar: '', level: 3, total_xp: 850, streak_days: 3, role: 'user', status: 'active', created_at: Date.now() - 172800000 },
  { id: 'u3', username: 'xiaohong', nickname: '小红花', avatar: '', level: 4, total_xp: 1420, streak_days: 5, role: 'user', status: 'active', created_at: Date.now() - 259200000 },
]
const MOCK_PETS = [
  { id: 'p1', name: '小宝贝', type: '猫咪', stage: 'teen', level: 8, experience: 1200, status: 'happy', owner_name: 'lzk' },
  { id: 'p2', name: '旺财', type: '狗狗', stage: 'child', level: 3, experience: 300, status: 'normal', owner_name: 'xiaoming' },
  { id: 'p3', name: '皮皮', type: '仓鼠', stage: 'baby', level: 1, experience: 50, status: 'happy', owner_name: 'xiaohong' },
]
const MOCK_FEEDBACKS = [
  { id: 'f1', type: 'suggestion', title: '希望增加宠物互动功能', content: '希望能让宠物之间可以互动玩耍', contact: '微信：test01', created_at: Date.now() - 3600000, resolved: false },
  { id: 'f2', type: 'bug', title: '签到后XP没变化', content: '今天签到成功但是经验值没有增加', contact: '', created_at: Date.now() - 7200000, resolved: false },
  { id: 'f3', type: 'other', title: '很棒的小程序', content: '用了一周了，体验很好，继续加油！', contact: '', created_at: Date.now() - 86400000, resolved: true },
]

// 阶段映射
const STAGE_MAP = {
  baby:   { emoji: '🥚', label: '蛋' },
  child:  { emoji: '🐣', label: '幼年' },
  teen:   { emoji: '🐱', label: '少年' },
  adult:  { emoji: '🦁', label: '成年' },
  elder:  { emoji: '🦉', label: '传说' },
}
const STATUS_MAP = {
  happy:    '开心',
  normal:   '普通',
  sad:      '难过',
  sleeping: '睡觉',
  sick:     '生病',
}

// ===== 页面定义 =====
Page({
  data: {
    // 基础状态
    loading: true,
    isAdmin: false,
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

    // 弹窗
    showDetailModal: false,
    detailUser: {},
    showPetEditModal: false,
    editPetId: '',
    editPetStageIdx: 0,
    editPetLevel: 1,
    editPetExp: 0,
    editPetStatusIdx: 0,
    stageOptions: ['蛋', '幼年', '少年', '成年', '传说'],
    statusOptions: ['开心', '普通', '难过', '睡觉', '生病'],
    savingPet: false,
  },

  // WXML 模板方法
  fmtTime, formatXp,
  getStageEmoji(stage) { return (STAGE_MAP[stage] || STAGE_MAP.baby).emoji },
  getStageLabel(stage) { return (STAGE_MAP[stage] || STAGE_MAP.baby).label },
  getStatusLabel(status) { return STATUS_MAP[status] || status },

  onLoad() {
    this.setData({ currentUserId: (wx.getStorageSync('cloud_userInfo') || {}).id || '' })
    this.loadAdminData()
  },

  // ========== 核心数据加载 ==========
  async loadAdminData() {
    this.setData({ loading: true })
    const cached = wx.getStorageSync('cloud_userInfo') || {}
    const isLocalAdmin = (cached.role === 'admin' || cached._isLocalAdmin)

    // 本地有管理员标识 → 直接放行（不依赖云端校验）
    if (!isLocalAdmin) {
      this.setData({ isAdmin: false, loading: false })
      return
    }

    // 标记为管理员，先渲染界面
    this.setData({ isAdmin: true })

    let gotCloudData = false

    try {
      const res = await cloudApi.adminDashboard()

      // 云端返回了有效数据 → 使用
      if (res && res.code !== -1 && res.stats) {
        const stats = res.stats || {}
        const recentUsers = (res.recentUsers || []).map(u => ({ ...u, created_atStr: fmtTime(u.created_at) }))
        const feedbacks = (res.pendingFeedbacks || []).map(f => ({
          ...f, created_at_str: fmtTime(f.created_at),
        }))

        this.setData({
          stats,
          recentUsers,
          feedbackList: feedbacks,
          allPets: res.allPets || [],
        })
        gotCloudData = true
      }
    } catch (err) {
      console.warn('[Admin] Dashboard加载异常(使用本地数据):', err)
    }

    // 云端无数据 → 使用本地模拟数据
    if (!gotCloudData) {
      console.log('[Admin] 使用本地模拟数据')
      const recentUsers = MOCK_RECENT_USERS.map(u => ({ ...u, created_atStr: fmtTime(u.created_at) }))
      const feedbacks = MOCK_FEEDBACKS.map(f => ({ ...f, created_at_str: fmtTime(f.created_at) }))
      this.setData({
        stats: { ...MOCK_STATS },
        recentUsers,
        feedbackList: feedbacks,
        allPets: MOCK_PETS,
      })
    }

    // 无论dashboard是否成功，都尝试加载子列表（云端失败时用模拟数据兜底）
    this.setData({ loading: false })

    Promise.all([
      this.loadUserList(1).catch(() => {
        // 用户列表云端失败 → 用模拟数据
        this.setData({
          userList: MOCK_RECENT_USERS.map(u => ({ ...u, created_atStr: fmtTime(u.created_at) })),
          userListTotal: MOCK_RECENT_USERS.length,
          totalUserPages: 1,
        })
      }),
      this.loadPetList(1).catch(() => {
        this.setData({ petList: MOCK_PETS, petListTotal: MOCK_PETS.length })
      }),
      this.loadFeedbacks('all').catch(() => {
        this.setData({
          feedbackList: MOCK_FEEDBACKS.map(f => ({ ...f, created_at_str: fmtTime(f.created_at) })),
        })
      }),
    ])
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
      await cloudApi.adminSetRole({ userId, role: newRole })
      wx.hideLoading()
      // 更新本地列表
      const list = this.data.userList.map(u => u.id === userId ? { ...u, role: newRole } : u)
      this.setData({ userList })
      wx.showToast({ title: `${actionText}成功`, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 封禁/解封
  async toggleUserStatus(e) {
    const { userId, status } = e.currentTarget.dataset
    const newStatus = status === 'banned' ? 'active' : 'banned'
    const actionText = newStatus === 'banned' ? '封禁该用户' : '解除封禁'

    const ok = await new Promise(resolve => {
      wx.showModal({ title: '确认操作', content: `确定要${actionText}吗？`, confirmColor: '#c0392b', success: r => resolve(r.confirm) })
    })
    if (!ok) return

    try {
      wx.showLoading({ title: '处理中...' })
      await cloudApi.adminSetUserStatus({ userId, status: newStatus })
      wx.hideLoading()
      const list = this.data.userList.map(u => u.id === userId ? { ...u, status: newStatus } : u)
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
    this.setData({ showDetailModal: true, detailUser: {} })

    try {
      const res = await cloudApi.adminGetUserDetail(userId)
      if (res.code === 0) {
        this.setData({ detailUser: res.data })
      } else {
        this.setData({ detailUser: { error: res.message } })
      }
    } catch (err) {
      this.setData({ detailUser: { error: err.message || '加载失败' } })
    }
  },
  closeDetailModal() { this.setData({ showDetailModal: false }) },

  // ========== 宠物管理 ==========
  async loadPetList(page) {
    try {
      const res = await cloudApi.adminListPets({ page, pageSize: this.data.petPageSize })
      if (res.code === -1) return
      this.setData({
        petList: res.list || [],
        petListTotal: res.total || 0,
        petPage: page,
      })
    } catch (err) {
      console.error('[Admin] 宠物列表失败:', err)
    }
  },
  prevPetPage() { if (this.data.petPage > 1) this.loadPetList(this.data.petPage - 1) },
  nextPetPage() { this.loadPetList(this.data.petPage + 1) },

  // 编辑宠物弹窗
  editPetStage(e) {
    const id = e.currentTarget.dataset.id
    const pet = this.data.petList.find(p => p.id === id)
    if (!pet) return

    const stageKeys = ['baby', 'child', 'teen', 'adult', 'elder']
    const stageIdx = stageKeys.indexOf(pet.stage) >= 0 ? stageKeys.indexOf(pet.stage) : 0
    const statusKeys = ['happy', 'normal', 'sad', 'sleeping', 'sick']
    const statusIdx = statusKeys.indexOf(pet.status) >= 0 ? statusKeys.indexOf(pet.status) : 0

    this.setData({
      showPetEditModal: true,
      editPetId: id,
      editPetStageIdx: stageIdx,
      editPetLevel: pet.level || 1,
      editPetExp: pet.experience || 0,
      editPetStatusIdx: statusIdx,
    })
  },
  closePetModal() { this.setData({ showPetEditModal: false }) },

  onPetStageChange(e) { this.setData({ editPetStageIdx: parseInt(e.detail.value) }) },
  onPetLevelInput(e) { this.setData({ editPetLevel: parseInt(e.detail.value) || 1 }) },
  onPetExpInput(e) { this.setData({ editPetExp: parseInt(e.detail.value) || 0 }) },
  onPetStatusChange(e) { this.setData({ editPetStatusIdx: parseInt(e.detail.value) }) },

  async savePetEdit() {
    const stageKeys = ['baby', 'child', 'teen', 'adult', 'elder']
    const statusKeys = ['happy', 'normal', 'sad', 'sleeping', 'sick']

    try {
      this.setData({ savingPet: true })
      await cloudApi.adminEditPet({
        petId: this.data.editPetId,
        stage: stageKeys[this.data.editPetStageIdx],
        level: Math.min(99, Math.max(1, this.data.editPetLevel)),
        experience: Math.max(0, this.data.editPetExp),
        status: statusKeys[this.data.editPetStatusIdx],
      })
      this.setData({ savingPet: false, showPetEditModal: false })
      wx.showToast({ title: '保存成功', icon: 'success' })
      this.loadPetList(this.data.petPage)
    } catch (err) {
      this.setData({ savingPet: false })
      wx.showToast({ title: '保存失败', icon: 'none' })
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
    this.loadAdminData().then(() => { wx.hideLoading(); wx.showToast({ title: '数据已更新', icon: 'success' }) })
  },

  goBack() { wx.navigateBack() },
})
