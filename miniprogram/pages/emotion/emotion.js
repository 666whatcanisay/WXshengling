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
  },

  recordMood(e) {
    const idx = e.currentTarget.dataset.index
    const label = this.data.moodOptions[idx].label
    this.setData({ selectedMood: idx, selectedMoodLabel: label })
  },

  async submitEmotion() {
    if (this.data.selectedMood === -1) {
      wx.showToast({ title: "请先选择心情", icon: "none" })
      return
    }
    const mood = this.data.moodOptions[this.data.selectedMood]
    try {
      await cloudApi.emotions({
        mood_index: this.data.selectedMood,
        mood_label: mood.label,
      })
      const noteText = this.data.note ? `，备注：${this.data.note}` : ""
      wx.showToast({ title: `已记录 ${mood.emoji} ${mood.label}${noteText}`, icon: "success" })
      this.setData({ selectedMood: -1, selectedMoodLabel: "", note: "" })
    } catch (err) {
      wx.showToast({ title: "记录失败", icon: "error" })
    }
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },
})
