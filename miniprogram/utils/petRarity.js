/**
 * 宠物 V3 - 稀有度系统配置
 * 统一管理稀有度定义、概率、视觉效果
 */

module.exports.PET_RARITY = {
  common: {
    name: '普通',
    color: '#95A5A6',      // 灰色
    glowColor: 'rgba(149,165,166,0.25)',
    borderColor: 'rgba(149,165,166,0.5)',
    particleColor: 'rgba(149,165,166,0.6)',
    probability: 70,
  },
  rare: {
    name: '稀有',
    color: '#3498DB',       // 蓝色
    glowColor: 'rgba(52,152,219,0.35)',
    borderColor: 'rgba(52,152,219,0.6)',
    particleColor: 'rgba(52,152,219,0.7)',
    probability: 20,
  },
  epic: {
    name: '史诗',
    color: '#9B59B6',       // 紫色
    glowColor: 'rgba(155,89,182,0.4)',
    borderColor: 'rgba(155,89,182,0.65)',
    particleColor: 'rgba(155,89,182,0.8)',
    probability: 8,
  },
  legendary: {
    name: '传说',
    color: '#F1C40F',       // 金色
    glowColor: 'rgba(241,196,15,0.45)',
    borderColor: 'rgba(241,196,15,0.7)',
    particleColor: 'rgba(241,196,15,0.9)',
    probability: 2,
  },
}

/** 根据随机数roll出稀有度 */
function rollRarity() {
  const rand = Math.random() * 100
  let cumulative = 0
  const rarities = Object.keys(module.exports.PET_RARITY)
  for (const key of rarities) {
    const r = module.exports.PET_RARITY[key]
    cumulative += r.probability
    if (rand < cumulative) return key
  }
  return 'common'
}

/** 获取稀有度信息 */
function getRarityInfo(rarityKey) {
  return module.exports.PET_RARITY[rarityKey] || module.exports.PET_RARITY.common
}

module.exports.rollRarity = rollRarity
module.exports.getRarityInfo = getRarityInfo
