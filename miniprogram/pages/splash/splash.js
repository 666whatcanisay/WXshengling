Page({
  data: { loadingText: '正在准备营地...', dots: '' },

  onLoad() {
    // 点点动画
    this._dotInterval = setInterval(() => {
      const dots = this.data.dots.length >= 3 ? '' : this.data.dots + '.'
      this.setData({ dots })
    }, 500)

    // 展示启动画面后，始终进入登录页
    setTimeout(() => {
      clearInterval(this._dotInterval)
      wx.redirectTo({ url: '/pages/login/login' })
    }, 1500)
  },

  onUnload() {
    if (this._dotInterval) clearInterval(this._dotInterval)
  },
})
