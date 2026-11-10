const cloudApi = require("../../utils/cloudApi");

function generateEmotionCalendar() {
  const moods = ["happy", "happy", "happy", "neutral", "sad", "neutral", "happy"]
  const calendar = []
  const today = new Date()
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    const dateStr = `${y}-${m}-${day}`
    const moodIndex = (27 - i) % moods.length
    const mood = moods[moodIndex]
    const scoreMap = { happy: Math.floor(Math.random() * 3) + 7, neutral: 5, sad: Math.floor(Math.random() * 3) + 2 }
    calendar.push({ date: dateStr, mood, score: scoreMap[mood] })
  }
  return calendar
}

Page({
  data: {
    emotionCalendar: generateEmotionCalendar(),
    emotionAnalysis: {
      period: "最近7天", happyCount: 4, neutralCount: 2, sadCount: 1,
      dominant: "开心", trend: "up",
      suggestion: "你最近整体心情不错，继续保持！记得多和朋友分享快乐哦～",
    },
    petEmotionLink: {
      petName: "小蛋", currentMood: "happy",
      message: "主人很开心，我也很开心！", moodEffect: "互动经验翻倍",
    },
    moodOptions: [
      { emoji: "😊", label: "开心" },
      { emoji: "😄", label: "愉快" },
      { emoji: "😐", label: "一般" },
      { emoji: "😔", label: "低落" },
      { emoji: "😤", label: "生气" },
    ],
    selectedMood: -1,
    selectedMoodLabel: "",
    note: "",
    savingMood: false,
  },

  recordMood(e) {
    if (this.data.savingMood) return
    const idx = Number(e.currentTarget.dataset.index)
    const label = this.data.moodOptions[idx]?.label
    if (!label) return
    this.setData({ selectedMood: idx, selectedMoodLabel: label })
  },

  async submitEmotion() {
    if (this.data.savingMood) return
    const { selectedMood, note } = this.data
    const mood = this.data.moodOptions[selectedMood]
    if (!mood) {
      wx.showToast({ title: "请先选择心情", icon: "none" })
      return
    }
    const app = getApp()
    const { currentOpenid: owner, userInfo: session } = app.globalData
    if (!owner) return
    const isCurrent = () => app.globalData.currentOpenid === owner && app.globalData.userInfo === session
    this.setData({ savingMood: true })
    try {
      const receipt = await cloudApi.emotions({
        mood_index: selectedMood,
        mood_label: mood.label,
        ...(note ? { note } : {}),
      })
      if (!isCurrent()) return
      if (receipt?.success !== true) throw new Error('未收到心情保存回执')
      if (note && receipt.mood?.note !== note) throw new Error('心情已保存，备注未确认，请保留后重试')
      wx.showToast({ title: `已记录 ${mood.emoji} ${mood.label}`, icon: "success" })
      this.setData({ selectedMood: -1, selectedMoodLabel: "", note: "" })
    } catch (err) {
      if (isCurrent()) wx.showToast({ title: (typeof err === 'string' ? err : err?.message) || '记录失败，请重试', icon: 'none' })
    } finally {
      this.setData(isCurrent() ? { savingMood: false } : { savingMood: false, selectedMood: -1, selectedMoodLabel: '', note: '' })
    }
  },

  onNoteInput(e) {
    if (!this.data.savingMood) this.setData({ note: e.detail.value })
  },
})
