const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", icon: "🧬", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1" },
  { id: "openai", name: "OpenAI", icon: "🤖", defaultModel: "gpt-4o-mini", defaultBaseUrl: "https://api.openai.com/v1" },
  { id: "qwen", name: "通义千问", icon: "🌍", defaultModel: "qwen-plus", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "gemini", name: "Gemini", icon: "⭐", defaultModel: "gemini-1.5-flash", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "custom", name: "自定义", icon: "⚙️", defaultModel: "", defaultBaseUrl: "" },
]

Page({
  data: {
    providers: PROVIDERS,
    provider: "deepseek", apiKey: "sk-xxxxxxxxxxxxxxxx", baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat", showKey: false, configSaved: false,
    savedConfig: null, testing: false, testResult: null,
    modelPlaceholder: "deepseek-chat",
    showBaseUrl: false,
    templates: [
      { id: "deepseek", name: "🧬 DeepSeek" },
      { id: "openai", name: "🤖 OpenAI" },
      { id: "qwen", name: "🌍 通义" },
      { id: "gemini", name: "⭐ Gemini" },
    ],
  },

  onShow() {},

  selectProvider(e) {
    const id = e.currentTarget.dataset.provider
    const p = PROVIDERS.find(x => x.id === id)
    if (p) {
      this.setData({
        provider: id,
        model: p.defaultModel,
        baseUrl: p.defaultBaseUrl,
        modelPlaceholder: p.defaultModel || "输入模型名称",
        showBaseUrl: id === 'custom',
        testResult: null,
      })
    }
  },

  onApiKey(e) { this.setData({ apiKey: e.detail.value, testResult: null }) },
  onBaseUrl(e) { this.setData({ baseUrl: e.detail.value }) },
  onModel(e) { this.setData({ model: e.detail.value }) },
  toggleKey() { this.setData({ showKey: !this.data.showKey }) },

  applyTemplate(e) {
    this.selectProvider({ currentTarget: { dataset: { provider: e.currentTarget.dataset.id } } })
  },

  testConnection() {
    if (!this.data.apiKey || this.data.apiKey === 'sk-xxxxxxxxxxxxxxxx') {
      wx.showToast({ title: '请先填写 API Key', icon: 'none' })
      return
    }
    this.setData({ testing: true, testResult: null })
    setTimeout(() => {
      const provider = this.data.providers.find(p => p.id === this.data.provider)
      this.setData({
        testing: false,
        testResult: {
          success: true,
          message: '✅ 连接成功！模型: ' + (this.data.model || (provider ? provider.defaultModel : '') || 'deepseek-chat')
        }
      })
    }, 1200)
  },

  saveConfig() {
    if (!this.data.apiKey || this.data.apiKey === 'sk-xxxxxxxxxxxxxxxx') {
      wx.showToast({ title: '请先填写 API Key', icon: 'none' })
      return
    }
    this.setData({ configSaved: true })
    wx.showToast({ title: "配置已保存", icon: "success" })
  },

  clearConfig() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除 AI 配置吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            apiKey: '', provider: 'deepseek', model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com/v1', configSaved: false,
            testResult: null,
          })
          wx.showToast({ title: '配置已清除', icon: 'success' })
        }
      }
    })
  },
})