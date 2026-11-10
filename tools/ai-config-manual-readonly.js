// Paste into WeChat DevTools Console after the scoped hotfix. No writes/model calls.
wx.cloud.callFunction({ name: 'app-node24', data: { action: 'listApiKeys', data: {} } }).then(({ result }) => {
  if (!result || result.code === -1 || !Array.isArray(result.data)) throw new Error(result && result.message || '配置读取失败')
  const records = result.data
  const active = records.find(row => row.has_key)
  console.log('AI配置只读检查', JSON.stringify({
    currentProvider: active ? active.provider : '', currentModel: active ? active.model : '',
    fullKeyReturned: records.some(row => Object.prototype.hasOwnProperty.call(row, 'api_key')),
    configs: records.map(row => ({ provider: row.provider, model: row.model, hasKey: row.has_key === true, updatedAt: row.updated_at || 0 }))
  }))
}).catch(error => console.log('AI配置只读检查失败', typeof error === 'string' ? error : error.message))
