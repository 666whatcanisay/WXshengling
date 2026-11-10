const SpeciesConfig = require('./speciesConfig')

const themes = [
  { id: 'base', grade: 'F–A', name: '基础款', description: '眨眼、呼吸、短尾轻摆' },
  { id: 'dew', grade: 'S', name: '露芽', description: '叶片回弹，露珠滚向叶尖' },
  { id: 'orbit', grade: 'S', name: '星轨', description: '月环翻转，小星绕行' },
  { id: 'lantern', grade: 'S', name: '萤灯', description: '提灯亮起，萤光飞出再返回' },
]

// Keep this pool fixed so existing pets retain their ornament as more styles are added.
const firstOrnamentPool = ['dew', 'orbit', 'lantern']
const forms = { BABY: 'baby', YOUTH: 'youth', ADULT: 'adult', PERFECT: 'perfect' }
const speciesIds = new Set(SpeciesConfig.getAllIds())

function getPetPortrait(pet, appearance) {
  if (!speciesIds.has(pet.species) || appearance.isEgg) return null
  const form = forms[appearance.stage]
  if (!form) return null

  let theme = 'base'
  const id = pet._id || pet.id
  if (appearance.talentGrade === 'S' && id) {
    const key = String(id)
    let hash = 2166136261
    for (let i = 0; i < key.length; i++) {
      hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
    }
    theme = firstOrnamentPool[(hash >>> 0) % firstOrnamentPool.length]
  }
  return { species: pet.species, form, theme }
}

module.exports = { themes, forms, getPetPortrait }
