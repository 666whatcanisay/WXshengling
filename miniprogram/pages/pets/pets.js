const cloudApi = require('../../utils/cloudApi')

const DEFAULT_BACKPACK = [
  { name: '普通饲料', count: 3, icon: '🍥', desc: '+10EXP' },
  { name: '高级饲料', count: 1, icon: '🍿', desc: '+30EXP' },
  { name: '成长药水', count: 0, icon: '🧈', desc: '进化加速' },
  { name: '补签卡', count: 1, icon: '🎿', desc: '补签一次' },
]

function getPetEmoji(stage) {
  return { egg: '🥚', baby: '🐥', adult: '🦦' }[stage] || '🥚'
}
function getStageText(stage) {
  return { egg: '蛋', baby: '幼年', adult: '成年' }[stage] || '蛋'
}
function getStatusText(status) {
  return { happy: '很开心', normal: '平静', sad: '有点悲伤' }[status] || '平静'
}

function log(tag, msg, data) {
  const t = new Date().toISOString().slice(11, 23)
  if (data) console.log(`[Pet][${t}] ${tag}: ${msg}`, JSON.stringify(data))
  else console.log(`[Pet][${t}] ${tag}: ${msg}`)
}

Page({
  data: {
    loading: true,
    pets: [], activePet: null,
    petEmoji: '', stageText: '', statusTextVal: '', nextStageText: '',
    xpPercent: 0, stageMaxXp: 500, logs: [], interacting: false, petStatusClass: 'normal',
    backpack: [], diary: [],
    activeSection: 'info',
    showRenameModal: false, renameInput: '',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    log('onShow', '宠物页面加载...')
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      // 从云 API 获取宠物列表
      const res = await cloudApi.pets()
      const pets = res.data || []
      const p = pets.length > 0 ? pets[0] : null

      if (p) {
        const stageMaxXp = { egg: 100, baby: 500, adult: 9999 }[p.stage] || 500
        const xpProgress = (p.experience || 0) % stageMaxXp

        // 背包仍用本地存储（云端暂无背包接口）
        const savedBackpack = wx.getStorageSync('pet_backpack')
        const backpack = savedBackpack || DEFAULT_BACKPACK

        // 从云端获取成长日志
        let logs = []
        try {
          const logRes = await cloudApi.growthLogs()
          logs = (logRes.data || logRes || []).slice(0, 10)
        } catch (e) {
          log('loadData', '获取日志失败', e)
        }

        this.setData({
          pets,
          activePet: p,
          petEmoji: getPetEmoji(p.stage),
          stageText: getStageText(p.stage),
          statusTextVal: getStatusText(p.status),
          nextStageText: { egg: '幼年', baby: '成年', adult: '已满级' }[p.stage] || '已满级',
          xpPercent: Math.min(100, (xpProgress / stageMaxXp * 100).toFixed(1)),
          stageMaxXp,
          logs,
          petStatusClass: p.status,
          backpack,
          diary: [],
          showRenameModal: false,
          renameInput: p.name,
        })
      } else {
        // 没有宠物，显示空状态
        this.setData({
          pets: [],
          activePet: null,
          petEmoji: getPetEmoji('egg'),
          stageText: getStageText('egg'),
          statusTextVal: '',
          nextStageText: '',
          xpPercent: 0,
          stageMaxXp: 100,
          logs: [],
          petStatusClass: 'normal',
          backpack: DEFAULT_BACKPACK,
          diary: [],
          renameInput: '',
        })
      }
    } catch (e) {
      console.error('[Pet] loadData 失败', e)
      wx.showToast({ title: '获取数据失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async createPet() {
    const p = this.data.activePet
    if (p) {
      return wx.showToast({ title: '已有宠物啦～', icon: 'none' })
    }
    try {
      wx.showLoading({ title: '领养中...' })
      await cloudApi.createPet({ name: '小宝贝' })
      wx.hideLoading()
      wx.showToast({ title: '领养成功 🎉', icon: 'success' })
      this.loadData()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '领养失败', icon: 'none' })
    }
  },

  async petInteract(e) {
    const type = e.currentTarget.dataset.type || 'pet'
    const texts = { feed: '喂食', play: '玩耍', pet: '抚摸' }
    const xpMap = { feed: 10, play: 15, pet: 5 }
    const xp = xpMap[type] || 10

    log('交互', '宠物互动', { type, label: texts[type], xpReward: xp })
    this.setData({ interacting: true })
    setTimeout(() => this.setData({ interacting: false }), 600)

    const pet = this.data.activePet
    if (pet) {
      const stageMaxXp = { egg: 100, baby: 500, adult: 9999 }[pet.stage] || 500
      const oldExp = pet.experience || 0
      const newExp = oldExp + xp
      const xpProgress = newExp % stageMaxXp

      // 检查是否跨越了升级阈值
      const oldLevels = Math.floor(oldExp / stageMaxXp)
      const newLevels = Math.floor(newExp / stageMaxXp)
      let newLevel = pet.level

      if (newLevels > oldLevels) {
        newLevel = pet.level + (newLevels - oldLevels)
        wx.showToast({ title: `${texts[type]} +${xp}XP 🎉 升级到Lv.${newLevel}!`, icon: 'success' })
      } else {
        wx.showToast({ title: `${texts[type]} +${xp} XP 🎉`, icon: 'success' })
      }

      try {
        await cloudApi.petUpdate(pet.id, {
          experience: newExp,
          level: newLevel,
        })
        log('交互', 'XP 云端更新完成', { petId: pet.id, newExp, level: newLevel })
      } catch (e) {
        log('交互', '云端更新失败', e)
        // 更新失败时回滚本地状态
        return;
      }

      const updatedPet = { ...pet, experience: newExp, level: newLevel }
      this.setData({
        activePet: updatedPet,
        xpPercent: Math.min(100, (xpProgress / stageMaxXp * 100).toFixed(1)),
      })
    }
  },

  goAIChat() { wx.switchTab({ url: '/pages/ai/ai' }) },

  switchSection(e) {
    const section = e.currentTarget.dataset.section || 'info'
    this.setData({ activeSection: section })
  },

  useItem(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.backpack[index]
    if (!item || item.count <= 0) {
      return wx.showToast({ title: '物品不足', icon: 'none' })
    }

    const backpack = [...this.data.backpack]
    backpack[index] = { ...item, count: item.count - 1 }
    wx.setStorageSync('pet_backpack', backpack)

    const xpMatch = (item.desc || '').match(/\+(\d+)/)
    const addXp = xpMatch ? parseInt(xpMatch[1]) : 10
    const pet = this.data.activePet
    if (pet) {
      const stageMaxXp = { egg: 100, baby: 500, adult: 9999 }[pet.stage] || 500
      const newExp = (pet.experience || 0) + addXp
      const xpProgress = newExp % stageMaxXp
      const updatedPet = { ...pet, experience: newExp }

      cloudApi.petUpdate(pet.id, { experience: newExp }).catch(e => {
        log('useItem', '云端更新失败', e)
      })

      this.setData({
        activePet: updatedPet,
        xpPercent: Math.min(100, (xpProgress / stageMaxXp * 100).toFixed(1)),
      })
    }

    this.setData({ backpack })
    wx.showToast({ title: `使用${item.name} +${addXp}EXP 🎉`, icon: 'success' })
  },

  showRenameModal() {
    this.setData({
      showRenameModal: true,
      renameInput: this.data.activePet ? this.data.activePet.name : '',
    })
  },

  onRenameInput(e) { this.setData({ renameInput: e.detail.value }) },

  cancelRenameModal() {
    this.setData({ showRenameModal: false })
  },

  cancelRename() {
    this.setData({ showRenameModal: false })
  },

  async renamePet() {
    const newName = this.data.renameInput && this.data.renameInput.trim()
    if (!newName) return wx.showToast({ title: '名称不能为空', icon: 'none' })

    const pet = this.data.activePet
    if (pet) {
      const oldName = pet.name
      try {
        await cloudApi.petUpdate(pet.id, { name: newName })
        log('改名', '云端更新成功', { from: oldName, to: newName })
      } catch (e) {
        log('改名', '云端更新失败', e)
        wx.showToast({ title: '改名失败', icon: 'none' })
        return
      }

      const updatedPet = { ...pet, name: newName }
      this.setData({ activePet: updatedPet, showRenameModal: false })
      wx.showToast({ title: `「${oldName}」→「${newName}」🎏`, icon: 'success' })
    }
  },
})
