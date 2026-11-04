const cloudApi = require("../../utils/cloudApi");

// 默认成就定义
const DEFAULT_ACHIEVEMENTS = [
  { id: 1, name: "初次打卡", description: "完成第一次任务打卡", icon: "📝", category: "成长", rarity: "common", rarity_label: "普通", xp_reward: 50, hidden: false },
  { id: 2, name: "连续7天", description: "连续打卡7天", icon: "🔥", category: "坚持", rarity: "rare", rarity_label: "稀有", xp_reward: 100, hidden: false },
  { id: 3, name: "目标达人", description: "完成第一个目标", icon: "🎯", category: "成长", rarity: "epic", rarity_label: "史诗", xp_reward: 200, hidden: false },
  { id: 4, name: "AI先驱", description: "与AI助手完成100次对话", icon: "🤖", category: "AI", rarity: "legendary", rarity_label: "传说", xp_reward: 500, hidden: true },
  { id: 5, name: "宠物伙伴", description: "拥有第一只宠物", icon: "🐱", category: "宠物", rarity: "common", rarity_label: "普通", xp_reward: 50, hidden: false },
  { id: 6, name: "坚持不懈", description: "连续打卡30天", icon: "💪", category: "坚持", rarity: "epic", rarity_label: "史诗", xp_reward: 300, hidden: false },
];

Page({
  data: {
    loading: false,
    selectedAchievement: null,
    currentCategory: "全部",
    currentRarity: "all",
    categories: ["全部", "成长", "宠物", "坚持", "AI"],
    rarities: [
      { label: "全部", value: "all" },
      { label: "普通", value: "common" },
      { label: "稀有", value: "rare" },
      { label: "史诗", value: "epic" },
      { label: "传说", value: "legendary" },
    ],
    achievements: [],
    filteredAchievements: [],
    stats: { hiddenCount: 1, totalCount: 6, totalXp: 1200, recentCount: 0 },
  },

  computedFilteredAchievements() {
    const { achievements, currentCategory, currentRarity } = this.data
    return achievements.filter(item => {
      if (currentCategory !== "全部" && item.category !== currentCategory) return false
      if (currentRarity !== "all" && item.rarity !== currentRarity) return false
      return true
    })
  },

  updateFiltered() {
    const filteredAchievements = this.computedFilteredAchievements()
    this.setData({ filteredAchievements })
  },

  onShow() {
    this.loadAchievements()
  },

  async loadAchievements() {
    this.setData({ loading: true })
    try {
      const achievementsArr = await cloudApi.myAchievements()
      // callCloud 已提取 result.data，故 achievementsArr 直接是数组
      const list = Array.isArray(achievementsArr) ? achievementsArr : (achievementsArr && achievementsArr.data || [])
      const unlocked = list.reduce((map, a) => {
        map[a.name] = a.unlocked_at || a.created_at
        return map
      }, {})

      // 将云端解锁状态合并到默认成就中
      const merged = DEFAULT_ACHIEVEMENTS.map(a => ({
        ...a,
        unlocked_at: unlocked[a.name] ? new Date(unlocked[a.name]).toISOString().slice(0, 10) : "",
        is_new: !!unlocked[a.name],
      }))

      const totalXp = merged.filter(a => a.is_new).reduce((s, a) => s + a.xp_reward, 0)
      const unlockedCount = merged.filter(a => a.is_new).length

      this.setData({
        achievements: merged,
        stats: { hiddenCount: merged.filter(a => a.hidden && !a.is_new).length, totalCount: merged.length, totalXp, recentCount: unlockedCount },
      })
      this.updateFiltered()
    } catch (err) {
      console.warn("[成就] 加载失败，使用默认数据:", err)
      // 降级为纯前端模式
      const demo = DEFAULT_ACHIEVEMENTS.map(a => ({
        ...a,
        unlocked_at: a.id <= 3 ? "2026-06-0" + a.id : "",
        is_new: a.id <= 3,
      }))
      this.setData({ achievements: demo })
      this.updateFiltered()
    }
    this.setData({ loading: false })
  },

  switchCategory(e) {
    const category = e.currentTarget.dataset.category
    this.setData({ currentCategory: category }, () => this.updateFiltered())
  },

  switchRarity(e) {
    const rarity = e.currentTarget.dataset.rarity
    this.setData({ currentRarity: rarity }, () => this.updateFiltered())
  },

  showDetail(e) {
    const id = Number(e.currentTarget.dataset.id)
    const a = this.data.achievements.find(x => x.id === id)
    if (a) this.setData({ selectedAchievement: a })
  },

  closeDetail() {
    this.setData({ selectedAchievement: null })
  }
})
