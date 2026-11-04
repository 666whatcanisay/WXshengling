/**
 * shared/petStageConfig.js — 宠物成长阶段统一配置（V8.2 唯一配置源）
 *
 * 设计原则：
 *   - 前后端共用同一份阈值定义，禁止双配置
 *   - 云函数通过 require('../../miniprogram/utils/shared/petStageConfig') 引用
 *   - 小程序端通过 require('../utils/shared/petStageConfig') 引用
 *
 * 阶段体系（V7.1）：
 *   EGG      0-99
 *   BABY     100-299
 *   YOUTH    300-599
 *   ADULT    600-1199
 *   PERFECT  1200+
 */

module.exports = {

  // ===== 成长阶段阈值（唯一真相源）=====
  STAGES: [
    { key: 'EGG',     name: '蛋',       icon: '🥚', minGrowth: 0,    maxGrowth: 99,   desc: '一颗神秘的蛋，正在孕育生命' },
    { key: 'BABY',    name: '幼年',     icon: '🐣', minGrowth: 100,  maxGrowth: 299,  desc: '刚孵化的小家伙，充满好奇心' },
    { key: 'YOUTH',   name: '少年',     icon: '🦊', minGrowth: 300,  maxGrowth: 599,  desc: '活力四射的成长期' },
    { key: 'ADULT',   name: '成年',     icon: '🦁', minGrowth: 600,  maxGrowth: 1199, desc: '成熟稳重的状态' },
    { key: 'PERFECT', name: '完美形态', icon: '👑', minGrowth: 1200, maxGrowth: 99999, desc: '超越极限的终极形态！' },
  ],

  // ===== 阶段key列表（用于遍历）=====
  STAGE_KEYS: ['EGG', 'BABY', 'YOUTH', 'ADULT', 'PERFECT'],

  // ===== 可渲染阶段（排除EGG）=====
  RENDERABLE_STAGE_KEYS: ['BABY', 'YOUTH', 'ADULT', 'PERFECT'],

  /**
   * 根据 growth_value 获取当前阶段信息
   * @param {number} growthValue - 成长值
   * @returns {Object} 阶段对象 { key, name, icon, minGrowth, maxGrowth, desc }
   */
  getStageByGrowth: function(growthValue) {
    var v = growthValue || 0
    var stages = this.STAGES
    for (var i = stages.length - 1; i >= 0; i--) {
      if (v >= stages[i].minGrowth) {
        return stages[i]
      }
    }
    return stages[0] // fallback to EGG
  },

  /**
   * 检查是否跨阶段
   * @param {number} oldGrowth - 旧成长值
   * @param {number} newGrowth - 新成长值
   * @returns {Object|null} 新阶段对象，未跨阶段返回 null
   */
  checkStageUp: function(oldGrowth, newGrowth) {
    var oldStage = this.getStageByGrowth(oldGrowth)
    var newStage = this.getStageByGrowth(newGrowth)
    if (oldStage.key !== newStage.key) return newStage
    return null
  },

  /**
   * 获取阶段的文件名映射（用于图片路径）
   * @param {string} stageKey - 阶段key如 'BABY'
   * @returns {string} 文件名如 'baby'
   */
  getStageFileName: function(stageKey) {
    var map = {
      EGG: '',
      BABY: 'baby',
      YOUTH: 'youth',
      ADULT: 'adult',
      PERFECT: 'perfect',
    }
    return map[stageKey] || ''
  },

  /**
   * 获取下一阶段信息
   * @param {string} currentStageKey - 当前阶段key
   * @returns {Object|null} 下一阶段对象，已是最后阶段返回 null
   */
  getNextStage: function(currentStageKey) {
    var keys = this.STAGE_KEYS
    var idx = keys.indexOf(currentStageKey)
    if (idx < 0 || idx >= keys.length - 1) return null
    return this.getStageByGrowth(this.STAGES[idx + 1].minGrowth)
  },

  /**
   * 计算当前阶段的进度百分比（0~100）
   * @param {number} growthValue - 当前成长值
   * @returns {number} 0~100 的百分比
   */
  getStageProgress: function(growthValue) {
    var stage = this.getStageByGrowth(growthValue)
    if (stage.key === 'EGG') {
      // EGG: 0~100 对应 0~100%
      return Math.min(100, Math.floor((growthValue / 100) * 100))
    }
    if (stage.key === 'PERFECT') {
      // PERFECT: 已达终点，显示100%
      return 100
    }
    var range = stage.maxGrowth - stage.minGrowth
    if (range <= 0) return 100
    return Math.min(100, Math.floor(((growthValue - stage.minGrowth) / range) * 100))
  },

  /**
   * 获取孵化阈值（蛋→幼年的最小growth_value）
   * @returns {number}
   */
  getHatchThreshold: function() {
    return 100
  },
}
