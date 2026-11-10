// Only public metadata is kept in page state or local preference storage.
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', icon: '🧬', defaultModel: 'deepseek-flash', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI', icon: '🤖', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'qwen', name: '通义千问', icon: '🌍', defaultModel: 'qwen-plus', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'gemini', name: 'Gemini', icon: '⭐', defaultModel: 'gemini-1.5-flash', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'custom', name: '自定义', icon: '⚙️', defaultModel: '', defaultBaseUrl: '' }
]
function publicConfigs(records) {
  if (!Array.isArray(records)) throw new Error('AI 配置返回格式异常')
  return records.map(k => ({ provider: k.provider, has_key: k.has_key === true || !!k.api_key,
    api_key_masked: k.api_key_masked || (k.api_key ? '****' : ''), base_url: k.base_url || '', model: k.model || '',
    version: typeof k.version === 'string' ? k.version : undefined,
    updated_at: Number(k.updated_at || 0), created_at: Number(k.created_at || 0) }))
}
function createSelector(wx, getApp) {
  function preferenceKey() {
    const global = getApp().globalData || {}, info = global.userInfo || {}
    const id = global.currentOpenid || info.openid || info._openid
    return id ? 'ai_provider_preference_v1:' + id : ''
  }
  function remember(provider) {
    const key = preferenceKey()
    if (key) wx.setStorageSync(key, provider)
  }
  function select(records) {
    const keys = publicConfigs(records).filter(k => k.has_key)
    // New server timestamps are authoritative; preference supports the old endpoint.
    if (keys.some(k => k.updated_at > 0)) return keys.sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at || a.provider.localeCompare(b.provider))[0] || null
    let preferred = ''
    try { const key = preferenceKey(); if (key) preferred = wx.getStorageSync(key) } catch (_) {}
    return keys.find(k => k.provider === preferred) || keys[0] || null
  }
  return { select, remember }
}
function readableError(error) {
  const text = typeof error === 'string' ? error : error && error.message || '请求失败'
  if (/Free quota exhausted|AllocationQuota.FreeTierOnly/i.test(text)) return '当前模型免费额度已用尽，请更换已保存的供应商配置，或自行到供应商控制台处理额度。'
  return text.slice(0, 220)
}
module.exports = { PROVIDERS, publicConfigs, createSelector, readableError }
