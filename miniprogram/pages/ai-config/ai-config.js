const cloudApi = require("../../utils/cloudApi")

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
    provider: "qwen", apiKey: "", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus", showKey: false, configSaved: false,
    hasExistingKey: false,     // V10.7: 标记已配置过 key（用于输入框不显示旧 key）
    apiKeyMasked: '',           // V10.7: 遮蔽后的 key 用于 UI 提示
    savedConfig: null, testing: false, testResult: null,
    modelPlaceholder: "qwen-plus",
    showBaseUrl: false,
  },

  onShow() {
    this.loadSavedConfig()
  },

  async loadSavedConfig() {
    try {
      const keys = await cloudApi.myApiKeys()
      if (keys && Array.isArray(keys) && keys.length > 0) {
        const cfg = keys[0] // 取第一个已保存的配置
        const p = PROVIDERS.find(x => x.id === cfg.provider)
        // V10.7：不把完整 key 填入输入框，避免遮蔽值覆盖数据库
        // 输入框始终为空，新 key 为空时才用旧 key（testConnection 会 fallback）
        this.setData({
          provider: cfg.provider || 'qwen',
          apiKey: '',                         // ← 不填入旧 key
          hasExistingKey: cfg.has_key || false,
          apiKeyMasked: cfg.api_key_masked || '',
          baseUrl: cfg.base_url || (p ? p.defaultBaseUrl : ''),
          model: cfg.model || (p ? p.defaultModel : ''),
          modelPlaceholder: cfg.model || (p ? p.defaultModel : ''),
          showBaseUrl: cfg.provider === 'custom',
          configSaved: true,
          savedConfig: { ...cfg, _fullKey: cfg.api_key }  // 存完整 key 供 testConnection 回退
        })
      }
    } catch (e) {
      // 加载失败不影响使用
    }
  },

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
        apiKey: '',             // 切换服务商清空输入
        hasExistingKey: false,  // 不同服务商不共享 key
        apiKeyMasked: '',
      })
    }
  },

  onApiKey(e) { this.setData({ apiKey: e.detail.value, testResult: null }) },
  onBaseUrl(e) { this.setData({ baseUrl: e.detail.value }) },
  onModel(e) { this.setData({ model: e.detail.value }) },
  toggleKey() { this.setData({ showKey: !this.data.showKey }) },

  async testConnection() {
    // V10.7：优先用输入框新 key，为空时回退到已保存的完整 key
    let apiKey = this.data.apiKey.trim()
    if (!apiKey && this.data.hasExistingKey && this.data.savedConfig && this.data.savedConfig._fullKey) {
      apiKey = this.data.savedConfig._fullKey
    }
    if (!apiKey || apiKey.length < 10) {
      wx.showToast({ title: '请先填写有效的 API Key', icon: 'none' })
      return
    }
    this.setData({ testing: true, testResult: null })

    try {
      const result = await cloudApi.aiTestConnection({
        apiKey: apiKey,
        baseUrl: this.data.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: this.data.model || 'qwen-plus',
        provider: this.data.provider
      })

      const isSuccess = result && result.code !== -1 && !result.message?.includes('失败')
      this.setData({
        testing: false,
        testResult: {
          success: isSuccess,
          message: isSuccess
            ? (result.message || '✅ 连接成功！模型: ' + (this.data.model || 'qwen-plus'))
            : ('❌ ' + (result.message || '连接失败，请检查 Key 和网络'))
        }
      })
    } catch (e) {
      const errMsg = typeof e === 'string' ? e : (e.message || e.errMsg || '未知错误')
      this.setData({
        testing: false,
        testResult: { success: false, message: '❌ ' + errMsg }
      })
    }
  },

  async saveConfig() {
    // V10.7：输入框有内容 → 用新 key；输入框为空但已有 key → 不覆盖
    let apiKey = this.data.apiKey.trim()
    const useExistingKey = !apiKey && this.data.hasExistingKey

    if (!apiKey && !useExistingKey) {
      wx.showToast({ title: '请先填写有效的 API Key', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...' })
    try {
      await cloudApi.saveApiKey({
        provider: this.data.provider,
        // 有空的新 key 就传新 key；否则传 ''，云函数会保留已存 key
        api_key: apiKey,
        base_url: this.data.baseUrl || '',
        model: this.data.model || ''
      })
      wx.hideLoading()
      // 保存后刷新（重新加载完整配置）
      this.loadSavedConfig()
      wx.showToast({ title: '配置已保存', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '保存失败: ' + (e.message || e), icon: 'none' })
    }
  },

  clearConfig() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除 AI 配置吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            // 保存空 key 来清除（云函数会覆盖）
            await cloudApi.saveApiKey({
              provider: this.data.provider,
              api_key: '',
              base_url: '',
              model: ''
            })
          } catch (e) { /* 忽略 */ }
          this.setData({
            apiKey: '', provider: 'qwen', model: 'qwen-plus',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', configSaved: false,
            testResult: null,
          })
          wx.showToast({ title: '配置已清除', icon: 'success' })
        }
      }
    })
  },
})
