const PREFIX = 'ai_publication_pending_v1:'
function createDraftStore(wx, getApp) {
  function owner() {
    const app = getApp(), info = app.globalData.userInfo || {}
    return app.globalData.currentOpenid || info.openid || info._openid || ''
  }
  function load() {
    const id = owner()
    if (!id) return null
    const saved = wx.getStorageSync(PREFIX + id)
    if (!saved) return null
    if (saved.version !== 1 || saved.owner !== id || !saved.request || !saved.request.publication_id || !saved.request.goal || !Array.isArray(saved.request.tasks)) {
      throw new Error('待确认草稿损坏，请先保留本地数据并联系开发者')
    }
    return saved
  }
  function save(request, context) {
    const id = owner()
    if (!id) throw new Error('账号状态未就绪，请重新登录')
    const saved = { version: 1, owner: id, request: JSON.parse(JSON.stringify(request)), context, savedAt: Date.now() }
    wx.setStorageSync(PREFIX + id, saved)
    return saved
  }
  function clear(id) {
    if (id && id === owner()) wx.removeStorageSync(PREFIX + id)
  }
  function newId() {
    return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + Math.random().toString(36).slice(2)
  }
  return { owner, load, save, clear, newId }
}
module.exports = { createDraftStore }
