const { accountScope } = require('./userSession')
const PREFIX = 'ai_publication_pending_v2:'
function createDraftStore(wx, getApp) {
  function owner() {
    const app = getApp(), info = app.globalData.userInfo || {}
    return app.globalData.currentOpenid || info.openid || info._openid || ''
  }
  const scope = () => accountScope(getApp().globalData)
  function owns(saved) {
    return !!saved?.scope && saved.scope === scope()
  }
  function load() {
    const key = scope()
    if (!key) return null
    const saved = wx.getStorageSync(PREFIX + key)
    if (!saved) return null
    if (saved.version !== 2 || !owns(saved) || !saved.request || !saved.request.publication_id || !saved.request.goal || !Array.isArray(saved.request.tasks)) {
      throw new Error('待确认草稿损坏，请先保留本地数据并联系开发者')
    }
    return saved
  }
  function save(request, context) {
    const key = scope()
    if (!key) throw new Error('账号状态未就绪，请重新登录')
    const saved = { version: 2, scope: key, request: JSON.parse(JSON.stringify(request)), context, savedAt: Date.now() }
    wx.setStorageSync(PREFIX + key, saved)
    return saved
  }
  function clear(saved) {
    if (!owns(saved)) return
    const current = load()
    if (current?.request.publication_id === saved.request.publication_id) wx.removeStorageSync(PREFIX + saved.scope)
  }
  function newId() {
    return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + Math.random().toString(36).slice(2)
  }
  return { owner, accountScope: scope, owns, load, save, clear, newId }
}
module.exports = { createDraftStore }
