﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * Pet V4 - 称号/荣誉系统配置
 *
 * 称号来源：
 *   1. 等级称号（Lv达到阈值自动获得）
 *   2. 连续打卡称号（连续签到天数）
 *   3. 特殊成就称号
 *
 * 最终档案展示：
 *   名称 + 称号 + 稀有度
 */

module.exports.TITLE_CONFIG = {

  // ===== 等级称号 =====
  level: [
    { minLv: 1,  maxLv: 4,  key: 'newborn',    name: '新生',     icon: '🌡', color: '#AED581', desc: '旅程的开始' },
    { minLv: 5,  maxLv: 9,  key: 'apprentice', name: '学徒',     icon: '📉', color: '#90CAF9', desc: '正在学习中' },
    { minLv: 10, maxLv: 14, key: 'striver',    name: '努力家',   icon: '💭', color: '#FFA726', desc: '不断前进' },
    { minLv: 15, maxLv: 19, key: 'expert',     name: '能手',     icon: '猸', color: '#FFD54F', desc: '技艺精湛' },
    { minLv: 20, maxLv: 29, key: 'master',     name: '大师',     icon: '🎳', color: '#AB47BC', desc: '登峰造极' },
    { minLv: 30, maxLv: 49, key: 'legend',     name: '传奇',     icon: '👑', color: '#F1C40F', desc: '名扬四海' },
    { minLv: 50, maxLv: Infinity, key: 'mythic', name: '神话',    icon: '✨', color: '#E040FB', desc: '超越极限' },
  ],

  // ===== 连续打卡称号 =====
  streak: [
    { minDays: 3,  key: 'starter',    name: '起步者', icon: '🎌', color: '#81C784', desc: '连续3天打卡' },
    { minDays: 7,  key: 'persister',  name: '坚持者', icon: '🔟', color: '#FF7043', desc: '连续7天打卡' },
    { minDays: 14, key: 'devoted',    name: '虔诚者', icon: '🕎', color: '#42A5F5', desc: '连续14天打卡' },
    { minDays: 30, key: 'unyielding', name: '不屈者', icon: '🛡︎', color: '#E040FB', desc: '连续30天打卡' },
    { minDays: 60, key: 'immortal',   name: '不灭者', icon: '💎', color: '#FFD54F', desc: '连续60天打卡' },
    { minDays: 100,key: 'eternal',    name: '永恒者', icon: '♾️︎', color: '#F1C40F', desc: '连续100天打卡' },
  ],

  // ===== 特殊成就称号 =====
  special: [
    {
      key: 'collector',
      name: '收藏家',
      icon: '📚',
      color: '#AB47BC',
      desc: '拥有过5只以上不同物种的宠物',
      condition: 'species_count >= 5',
    },
    {
      key: 'legendary_owner',
      name: '天选之人',
      icon: '👑',
      color: '#F1C40F',
      desc: '拥有传说级宠物',
      condition: 'has_legendary',
    },
    {
      key: 'max_bond',
      name: '灵魂伙伴',
      icon: '❤️︎',
      color: '#EF5350',
      desc: '亲密度达到满值',
      condition: 'bond >= 900',
    },
    {
      key: 'full_dex',
      name: '图鉴大师',
      icon: '🎲',
      color: '#26C6DA',
      desc: '收集全部物种',
      condition: 'dex_complete',
    },
  ],
}

/**
 * 根据等级获取当前等级称号
 */
function getLevelTitle(level) {
  var titles = module.exports.TITLE_CONFIG.level
  for (var i = titles.length - 1; i >= 0; i--) {
    if (level >= titles[i].minLv) return titles[i]
  }
  return titles[0]
}

/**
 * 根据连续天数获取当前连续称号
 */
function getStreakTitle(days) {
  var titles = module.exports.TITLE_CONFIG.streak
  for (var i = titles.length - 1; i >= 0; i--) {
    if (days >= titles[i].minDays) return titles[i]
  }
  return null
}

/**
 * 获取所有已解锁的特殊称号列表
 */
function getUnlockedSpecialTitles(conditions) {
  var specials = module.exports.TITLE_CONFIG.special
  return specials.filter(function(t) {
    switch (t.condition) {
      case 'has_legendary':  return conditions.hasLegendary === true
      case 'bond >= 900':    return (conditions.bond || 0) >= 900
      case 'dex_complete':   return conditions.dexComplete === true
      default:                return false
    }
  })
}

/** 获取称号完整显示文本 */
function formatTitleDisplay(titleObj) {
  if (!titleObj) return ''
  return titleObj.icon + ' ' + titleObj.name
}

module.exports.getLevelTitle = getLevelTitle
module.exports.getStreakTitle = getStreakTitle
module.exports.getUnlockedSpecialTitles = getUnlockedSpecialTitles
module.exports.formatTitleDisplay = formatTitleDisplay
