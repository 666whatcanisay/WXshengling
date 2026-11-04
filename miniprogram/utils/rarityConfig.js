/**
 * Pet V4 - 稀有度视觉系统配置
 *
 * 设计参考：三角洲挂饰 / 宝可梦异色 / 蛋仔派对
 * 四级视觉差异化，未来像素图接入时通过此配置实现全部效果
 *
 * 使用方式：
 *   const rc = RARITY_CONFIG[rarityKey]
 *   // 读取 rc.glow / rc.particle / rc.border / rc.colorLayer
 *   // 模板中不写 if/else，统一读配置对象
 */

module.exports.RARITY_CONFIG = {

  // ===== 普通 (70%) =====
  // 灰白基调，无光效，最朴素
  common: {
    key: 'common',
    name: '普通',
    tier: 1,

    // 基础颜色
    color: '#95A5A6',
    colorHex: '95A5A6',

    // === 颜色滤镜层 ===
    colorLayer: {
      enabled: false,
      hueRotate: 0,       // 色相旋转(度)
      saturate: 0,        // 饱和度增强
      brightness: 0,      // 亮度偏移
      opacity: 0,          // 滤镜透明度
    },

    // === 发光层 (glow) ===
    glow: {
      enabled: false,
      color: 'transparent',
      radius: 0,           // 光晕扩散半径
      intensity: 0,        // 强度 0~1
      blur: 0,             // 模糊度
      animation: '',       // 动画名
      pulseSpeed: 0,       // 呼吸速度(秒)
    },

    // === 边框层 (border) ===
    border: {
      enabled: true,
      width: 1,
      style: 'solid',     // solid / double / dashed
      color: 'rgba(149,165,166,0.3)',
      glowColor: '',
    },

    // === 粒子层 (particle) ===
    particle: {
      enabled: false,
      type: '',            // 粒子类型
      density: 0,          // 密度 0~1
      speed: 0,            // 速度
      size: 0,             // 大小
      color: '',
      count: 0,            // 数量
    },

    // === 觉醒叠加 (在觉醒时额外加的) ===
    awakenOverlay: null,   // 普通觉醒无额外效果

    // CSS 类名（模板直接用）
    cssClass: 'rarity-common',
    badgeClass: 'badge-common',
  },

  // ===== 稀有 (20%) =====
  // 蓝色边框 + 微弱粒子
  rare: {
    key: 'rare',
    name: '稀有',
    tier: 2,

    color: '#3498DB',
    colorHex: '3498DB',

    colorLayer: {
      enabled: true,
      hueRotate: 200,
      saturate: 15,
      brightness: 3,
      opacity: 0.08,
    },

    glow: {
      enabled: true,
      color: 'rgba(52,152,219,0.12)',
      radius: 60,
      intensity: 0.25,
      blur: 20,
      animation: 'rarityGlowPulse',
      pulseSpeed: 4,
    },

    border: {
      enabled: true,
      width: 2,
      style: 'solid',
      color: 'rgba(52,152,219,0.5)',
      glowColor: 'rgba(52,152,219,0.2)',
    },

    particle: {
      enabled: true,
      type: 'dust',        // 微尘粒子
      density: 0.3,
      speed: 0.5,
      size: 3,
      color: 'rgba(52,152,219,0.5)',
      count: 12,
    },

    awakenOverlay: null,

    cssClass: 'rarity-rare',
    badgeClass: 'badge-rare',
  },

  // ===== 史诗 (8%) =====
  // 紫色光晕 + 星点粒子
  epic: {
    key: 'epic',
    name: '史诗',
    tier: 3,

    color: '#9B59B6',
    colorHex: '9B59B6',

    colorLayer: {
      enabled: true,
      hueRotate: 280,
      saturate: 25,
      brightness: 5,
      opacity: 0.15,
    },

    glow: {
      enabled: true,
      color: 'rgba(155,89,182,0.22)',
      radius: 90,
      intensity: 0.5,
      blur: 35,
      animation: 'rarityGlowPulse',
      pulseSpeed: 3,
    },

    border: {
      enabled: true,
      width: 3,
      style: 'solid',
      color: 'rgba(155,89,182,0.65)',
      glowColor: 'rgba(155,89,182,0.3)',
    },

    particle: {
      enabled: true,
      type: 'sparkle',     // 星点闪烁
      density: 0.55,
      speed: 0.8,
      size: 4,
      color: 'rgba(155,89,182,0.7)',
      count: 20,
    },

    awakenOverlay: null,

    cssClass: 'rarity-epic',
    badgeClass: 'badge-epic',
  },

  // ===== 传说 (2%) =====
  // 金色呼吸光 + 流光粒子
  legendary: {
    key: 'legendary',
    name: '传说',
    tier: 4,

    color: '#F1C40F',
    colorHex: 'F1C40F',

    colorLayer: {
      enabled: true,
      hueRotate: 45,
      saturate: 35,
      brightness: 10,
      opacity: 0.25,
    },

    glow: {
      enabled: true,
      color: 'rgba(241,196,15,0.30)',
      radius: 120,
      intensity: 0.8,
      blur: 50,
      animation: 'legendaryBreathGlow',  // 金色呼吸光
      pulseSpeed: 2.5,
    },

    border: {
      enabled: true,
      width: 4,
      style: 'double',       // 双线边框！
      color: 'rgba(241,196,15,0.75)',
      glowColor: 'rgba(241,196,15,0.4)',
    },

    particle: {
      enabled: true,
      type: 'flow',          // 流光粒子
      density: 1.0,
      speed: 1.2,
      size: 5,
      color: 'rgba(241,196,15,0.9)',
      count: 30,
    },

    awakenOverlay: {
      // 觉醒传说额外：彩虹光晕
      rainbowGlow: true,
      extraParticle: 'star-burst',
    },

    cssClass: 'rarity-legendary',
    badgeClass: 'badge-legendary',
  },
}

/**
 * 根据稀有度key获取完整视觉配置
 * @param {string} rarityKey - 'common' | 'rare' | 'epic' | 'legendary'
 * @returns {object} 完整视觉配置对象
 */
function getRarityConfig(rarityKey) {
  return module.exports.RARITY_CONFIG[rarityKey] || module.exports.RARITY_CONFIG.common
}

/**
 * Roll 稀有度（与云函数保持一致的概率）
 */
function rollRarity() {
  const rand = Math.random() * 100
  if (rand < 70) return 'common'
  if (rand < 90) return 'rare'
  if (rand < 98) return 'epic'
  return 'legendary'
}

/** 获取稀有度排序权重（用于比较谁更稀有） */
function getRarityWeight(rarityKey) {
  const w = { common: 1, rare: 2, epic: 3, legendary: 4 }
  return w[rarityKey] || 0
}

module.exports.getRarityConfig = getRarityConfig
module.exports.rollRarity = rollRarity
module.exports.getRarityWeight = getRarityWeight
