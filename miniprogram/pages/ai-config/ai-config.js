const cloudApi = require('../../utils/cloudApi')
const models = require('../../utils/aiModelConfig')
const selector = models.createSelector(wx, getApp)
const defaults = models.PROVIDERS.find(p => p.id === 'qwen')
Page({
  data: {
    providers: models.PROVIDERS, provider: defaults.id, apiKey: '', baseUrl: defaults.defaultBaseUrl,
    model: defaults.defaultModel, modelPlaceholder: defaults.defaultModel, showKey: false, showBaseUrl: true,
    configSaved: false, hasExistingKey: false, apiKeyMasked: '', savedConfigs: [],
    activeProviderName: '', activeModel: '', loadingConfig: false, saving: false, testing: false,
    configError: '', testResult: null
  },
  _owner() {
    const global = getApp().globalData || {}, info = global.userInfo || {}
    return global.currentOpenid || info.openid || info._openid || ''
  },
  _configContext() { return { owner: this._owner(), session: getApp().globalData?.userInfo } },
  _isCurrentConfig(context) {
    const current = this._configContext()
    return !!context.owner && context.owner === current.owner && context.session === current.session
  },
  _expectedVersion(provider) {
    const saved = this.data.savedConfigs.find(config => config.provider === provider && config.has_key)
    return saved ? saved.version : null
  },
  onShow() { return this.loadSavedConfig() },
  onHide() { this.setData({ apiKey: '', showKey: false }) },
  async loadSavedConfig(preferred) {
    if (typeof preferred !== 'string') preferred = ''
    const context = this._configContext(), loadId = this._configLoadId = (this._configLoadId || 0) + 1
    const isCurrent = () => loadId === this._configLoadId && this._isCurrentConfig(context)
    const previous = this._loadedConfigContext
    if (!previous || !this._isCurrentConfig(previous)) {
      this._loadedConfigContext = context
      this.setData({ savedConfigs: [], activeProviderName: '', activeModel: '', saving: false, testing: false })
      this.applyProvider(defaults.id)
    }
    this.setData({ loadingConfig: true, configError: '' })
    try {
      const records = await cloudApi.myApiKeys()
      if (!isCurrent()) return false
      const configs = models.publicConfigs(records), active = selector.select(configs)
      const selected = configs.find(k => k.provider === preferred) || active
      this.setData({ savedConfigs: configs, activeProviderName: active ? (models.PROVIDERS.find(p => p.id === active.provider) || { name: active.provider }).name : '', activeModel: active ? active.model : '' })
      this.applyProvider(selected ? selected.provider : preferred || defaults.id)
      return true
    } catch (error) {
      if (isCurrent()) this.setData({ configError: '配置读取失败，请重试；不能据此判断是否已保存。' })
      return false
    } finally { if (isCurrent()) this.setData({ loadingConfig: false }) }
  },
  applyProvider(id) {
    const provider = models.PROVIDERS.find(p => p.id === id)
    if (!provider) return
    const saved = this.data.savedConfigs.find(k => k.provider === id && k.has_key)
    this.setData({ provider: id, apiKey: '', showKey: false, hasExistingKey: !!saved,
      apiKeyMasked: saved ? saved.api_key_masked : '', configSaved: !!saved,
      baseUrl: saved && saved.base_url || provider.defaultBaseUrl, model: saved && saved.model || provider.defaultModel,
      modelPlaceholder: provider.defaultModel || '输入模型名称', testResult: null })
  },
  selectProvider(e) { if (!this.data.saving && !this.data.testing && !this.data.loadingConfig) this.applyProvider(e.currentTarget.dataset.provider) },
  onApiKey(e) { this.setData({ apiKey: e.detail.value, testResult: null }) },
  onBaseUrl(e) { this.setData({ baseUrl: e.detail.value, testResult: null }) },
  onModel(e) { this.setData({ model: e.detail.value, testResult: null }) },
  toggleKey() { this.setData({ showKey: !this.data.showKey }) },
  validForm() {
    if (this.data.configError) { wx.showToast({ title: '请先重新读取已保存配置', icon: 'none' }); return false }
    if ((!this.data.apiKey.trim() && !this.data.hasExistingKey) || (this.data.apiKey.trim() && this.data.apiKey.trim().length < 10)) {
      wx.showToast({ title: '请填写有效的 API Key', icon: 'none' }); return false
    }
    if (!this.data.model.trim() || !/^https:\/\//i.test(this.data.baseUrl.trim())) {
      wx.showToast({ title: '请填写模型名称和 HTTPS 接口地址', icon: 'none' }); return false
    }
    return true
  },
  async testConnection() {
    if (this.data.testing || this.data.saving || this.data.loadingConfig || !this.validForm()) return
    const context = this._configContext()
    this.setData({ testing: true, testResult: null })
    try {
      const result = await cloudApi.aiTestConnection({ provider: this.data.provider, apiKey: this.data.apiKey.trim(), baseUrl: this.data.baseUrl.trim(), model: this.data.model.trim() })
      if (!this._isCurrentConfig(context)) return
      const success = !!result && (result.code === 0 || result.success === true)
      this.setData({ testResult: { success, message: success ? '连接成功：' + this.data.model : models.readableError(result.message || '连接失败') } })
    } catch (error) {
      if (this._isCurrentConfig(context)) this.setData({ testResult: { success: false, message: models.readableError(error) } })
    } finally { if (this._isCurrentConfig(context)) this.setData({ testing: false }) }
  },
  async saveConfig() {
    if (this.data.testing || this.data.saving || this.data.loadingConfig || !this.validForm()) return
    const context = this._configContext(), provider = this.data.provider
    this.setData({ saving: true, testResult: null })
    try {
      const result = await cloudApi.saveApiKey({ provider, api_key: this.data.apiKey.trim(),
        base_url: this.data.baseUrl.trim(), model: this.data.model.trim(), expected_version: this._expectedVersion(provider) })
      if (!this._isCurrentConfig(context)) return
      if (result?.success !== true) throw new Error('未收到保存回执，请重新读取核对')
      this.setData({ apiKey: '', showKey: false })
      try { selector.remember(provider) } catch (_) { /* New server timestamps still identify the selection. */ }
      const refreshed = await this.loadSavedConfig(provider)
      if (!this._isCurrentConfig(context)) return
      const active = refreshed ? selector.select(this.data.savedConfigs) : null
      const confirmed = active?.provider === provider && (!result.version || active.version === result.version)
      wx.showToast({ title: confirmed ? '配置已保存并设为当前使用' : '已收到保存回执，请核对当前配置', icon: 'none' })
    } catch (error) {
      if (this._isCurrentConfig(context)) wx.showToast({ title: '保存未确认：' + models.readableError(error), icon: 'none' })
    } finally { if (this._isCurrentConfig(context)) this.setData({ saving: false }) }
  },
  clearConfig() {
    if (this.data.testing || this.data.saving || this.data.loadingConfig) return
    const context = this._configContext(), provider = this.data.provider
    const expectedVersion = this._expectedVersion(provider)
    wx.showModal({ title: '删除服务商配置', content: '删除当前服务商的已保存密钥？其他服务商配置保留，删除后会显示当前可用配置。',
      success: async result => {
        if (!result.confirm || !this._isCurrentConfig(context) || provider !== this.data.provider ||
            this.data.saving || this.data.testing || this.data.loadingConfig) return
        this.setData({ saving: true })
        try {
          const result = await cloudApi.saveApiKey({ provider, clear: true, expected_version: expectedVersion })
          if (!result || result.cleared !== true) throw new Error('云函数尚未支持删除，原配置未确认删除')
          if (!this._isCurrentConfig(context)) return
          this.setData({ apiKey: '', showKey: false })
          const refreshed = await this.loadSavedConfig()
          if (!this._isCurrentConfig(context)) return
          const absent = refreshed && !this.data.savedConfigs.some(config => config.provider === provider && config.has_key)
          wx.showToast({ title: absent ? '当前服务商配置已删除' : '已收到删除回执，请核对当前配置', icon: 'none' })
        } catch (error) {
          if (this._isCurrentConfig(context)) wx.showToast({ title: '删除未确认：' + models.readableError(error), icon: 'none' })
        } finally { if (this._isCurrentConfig(context)) this.setData({ saving: false }) }
      }
    })
  }
})
