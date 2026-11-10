/**
 * Pet Preview — Pipeline 产出验收页
 *
 * 用途：展示 15物种 × 4阶段 全部图片，验证 Pipeline 对接
 */

var SpeciesConfig = require('../../utils/speciesConfig')
var PetAssetService = require('../../utils/pet_assets_config')

Page({
  data: {
    loading: true,
    lynxVisible: false,
    // 分类数据: [{ category, categoryName, categoryIcon, species: [...] }]
    categories: [],
    // 当前选中的分类索引
    currentCategoryIndex: 0,
    // 阶段列表（用于表头）
    stageList: [
      { key: 'BABY', label: '幼年', icon: '🐣' },
      { key: 'YOUTH', label: '少年', icon: '🦊' },
      { key: 'ADULT', label: '成年', icon: '🦁' },
      { key: 'PERFECT', label: '完美', icon: '👑' },
    ],
    // 统计
    totalSpecies: 0,
    totalImages: 0,
  },

  onLoad: function() {
    this._buildPreviewData()
  },

  onShow: function() {
    this.setData({ lynxVisible: true })
  },

  onHide: function() {
    this.setData({ lynxVisible: false })
  },

  _buildPreviewData: function() {
    var self = this
    var allSpecies = SpeciesConfig.list
    var categories = {}

    // 按分类分组
    allSpecies.forEach(function(sp) {
      var catKey = sp.category
      if (!categories[catKey]) {
        var catInfo = SpeciesConfig.categories[catKey] || {}
        categories[catKey] = {
          category: catKey,
          categoryName: catInfo.name || catKey,
          categoryIcon: catInfo.icon || '',
          species: [],
        }
      }

      // 获取该物种的4阶段图片路径
      var stages = PetAssetService.getSpeciesStages(sp.id)
      categories[catKey].species.push({
        id: sp.id,
        name: sp.name,
        icon: sp.icon,
        stages: stages,
      })
    })

    // 转为数组
    var categoryList = Object.keys(categories).map(function(k) { return categories[k] })

    self.setData({
      loading: false,
      categories: categoryList,
      totalSpecies: allSpecies.length,
      totalImages: allSpecies.length * 4, // 15 x 4 = 60
    })
  },

  // 切换分类Tab
  switchCategory: function(e) {
    var idx = e.currentTarget.dataset.index
    this.setData({ currentCategoryIndex: idx })
  },

  // 图片加载失败处理
  onImageError: function(e) {
    var dataset = e.currentTarget.dataset || {}
    console.warn('[Preview] 图片加载失败:', dataset.speciesId, dataset.stage)
  },

  // 点击图片放大预览
  previewImage: function(e) {
    var url = e.currentTarget.dataset.url
    var urls = e.currentTarget.dataset.urls || [url]
    wx.previewImage({ current: url, urls: urls })
  },
})
