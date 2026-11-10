// Only inspects the active native page and rendered card. No cloud/model calls or writes.
;(function () {
  const pages = getCurrentPages(), p = pages[pages.length - 1], d = p && p.data || {}
  const state = { page: p && p.route, tab: d.resultTab || '', selectedGoal: d.currentGoal && d.currentGoal.title || '',
    newPageCode: !!(p && typeof p.loadAdjustment === 'function'), loading: !!d.adjustmentLoading,
    workspaceLoaded: !!d.adjustmentWorkspace, error: d.adjustmentError || '' }
  wx.createSelectorQuery().selectAll('.adjustment-section').boundingClientRect().selectViewport().scrollOffset().exec(results => {
    const cards = results && results[0] || [], rect = cards[0]
    console.log('调整入口定位', JSON.stringify({ ...state, cardCount: cards.length,
      cardTop: rect ? Math.round(rect.top) : null, cardHeight: rect ? Math.round(rect.height) : null,
      scrollTop: results && results[1] ? results[1].scrollTop : null }))
  })
})()
