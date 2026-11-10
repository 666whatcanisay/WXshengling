const SpeciesConfig = require('../../utils/speciesConfig')
const { themes } = require('../../utils/petPortrait')

const stages = [
  { id: 'baby', name: '幼年' },
  { id: 'youth', name: '少年' },
  { id: 'adult', name: '成年' },
  { id: 'perfect', name: '完美形态' },
]

Page({
  data: {
    animals: SpeciesConfig.list,
    stages,
    themes,
    speciesIndex: 0,
    stageIndex: 2,
    themeIndex: 0,
    visible: false,
  },
  onShow() { this.setData({ visible: true }) },
  onHide() { this.setData({ visible: false }) },
  selectSpecies(event) { this.setData({ speciesIndex: Number(event.detail.value) }) },
  selectStage(event) { this.setData({ stageIndex: event.currentTarget.dataset.index }) },
  selectTheme(event) { this.setData({ themeIndex: Number(event.detail.value) }) },
})
