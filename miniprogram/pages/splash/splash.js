const LOADING_TEXTS = [
  '正在唤醒森林……',
  '正在整理今日成长计划……',
  'AI规划师正在思考……',
  '正在连接成长伙伴……',
  '森林正在苏醒……',
  '正在点亮今日目标……',
  '正在准备你的成长旅程……',
  '正在生成今天的森林……'
]

const FOOTER_TEXTS = [
  '🌿 今天也一起成长吧',
  '🌱 每一点坚持，都会开花',
  '🍀 自律不是约束，而是成长',
  '✨ 每一次打卡，都算数',
  '🌳 今天的你，比昨天更进一步',
  '🦉 AI会一直陪伴你的成长',
  '🌲 欢迎回到你的自律森林'
]

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

Page({
  data: { loadingText: '', dots: '', footerText: '' },

  onLoad() {
    this.setData({
      loadingText: getRandomItem(LOADING_TEXTS),
      footerText: getRandomItem(FOOTER_TEXTS)
    })

    this._dotInterval = setInterval(() => {
      const dots = this.data.dots.length >= 3 ? '' : this.data.dots + '.'
      this.setData({ dots })
    }, 500)

    setTimeout(() => {
      clearInterval(this._dotInterval)
      wx.redirectTo({ url: '/pages/login/login' })
    }, 1500)
  },

  onUnload() {
    if (this._dotInterval) clearInterval(this._dotInterval)
  },
})
