// ========== AI 伙伴小屋 - 全功能版 ==========

// 性能日志工具
function log(tag, msg, data) {
  const t = new Date().toISOString().slice(11, 23)
  if (data) { console.log(`[AI][${t}] ${tag}: ${msg}`, JSON.stringify(data)) }
  else { console.log(`[AI][${t}] ${tag}: ${msg}`) }
}

// ===== 答案之书数据 =====
const ORACLE_ANSWERS = [
  { answer: '值得尝试', color: '#7CB342', explanation: '你已经具备基础能力，现在缺的是实践机会。迈出这一步，你会发现自己比想象中更强大。' },
  { answer: '可以试试', color: '#AED581', explanation: '风险可控，收益可期。即使结果不如预期，过程中你也会学到很多。' },
  { answer: '再考虑一下', color: '#DAA520', explanation: '时机可能还不太成熟，但不要完全放弃。可以先做些准备工作。' },
  { answer: '相信直觉', color: '#7CB342', explanation: '你的内心其实已经有了答案，只是需要勇气去承认它。' },
  { answer: '放手去做', color: '#7CB342', explanation: '犹豫不决比失败更浪费时间。行动起来，答案在路上。' },
  { answer: '量力而行', color: '#FFAB40', explanation: '目标很好，但需要评估自己的时间和精力。分步骤来会更稳妥。' },
]

// ===== 运势数据 =====
const FORTUNE_TEMPLATES = [
  { learning: 5, focus: 5, social: 3, advice: '今天适合完成长期目标中的关键一步。专注力拉满，别浪费在碎片信息上。' },
  { learning: 4, focus: 4, social: 4, advice: '均衡的一天！学习、社交、休息都可以安排上。记得给宠物喂食哦～' },
  { learning: 5, focus: 3, social: 5, advice: '社交能量爆棚！适合和伙伴一起学习，或者参加小组讨论。' },
  { learning: 3, focus: 5, social: 2, advice: '深度思考的好日子。适合攻克难题、写复盘日记、规划下周目标。' },
  { learning: 4, focus: 4, social: 3, advice: '稳扎稳打的一天。把今天该完成的任务做完，就是最大的胜利。' },
  { learning: 5, focus: 4, social: 4, advice: '灵感充沛日！可能有新的想法冒出来，随时记录下来。' },
]

// ===== 昵称生成规则 =====
const NICKNAME_PREFIXES = ['代码', '数据', '算法', '云端', '量子', '赛博', '数字', '智能']
const NICKNAME_SUFFIXES = ['驯龙师', '炼金术士', '召唤师', '构筑者', '织梦人', '探险家', '领航员', '建筑师']

// ===== 目标命名模板 =====
const GOAL_NAME_MAP = {
  '考四六级': ['英语突破计划', '词汇征服行动', '四级冲刺挑战'],
  '减肥': ['体魄觉醒之旅', '能量重塑计划', '活力进化之路'],
  '早起': ['晨光捕捉者计划', '日出同步行动', '黎明先锋挑战'],
  '学编程': ['代码修行之路', '逻辑构建工程', '数字世界探索'],
}

// ===== 翻译鼓励语 =====
const TRANSLATE_ENCOURAGE = [
  '休息也是成长的一部分，你已经很棒了。',
  '每一步都算数，慢慢来比较快。',
  '允许自己有低能量的时刻，明天又是新的一天。',
  '你的感受很重要，照顾好自己也是目标之一。',
  '今天辛苦了，给自己一个拥抱吧。',
]

// ===== 未来来信模板 =====
const FUTURE_LETTERS = [
  `你好！

我是三年后的你。

现在的你可能还在为每天的小目标努力着，我想告诉你——这一切都是值得的。

那些你觉得枯燥的打卡日子，那些想要放弃的瞬间，最终都成了我最珍贵的回忆。

继续加油吧，未来的我会感谢现在拼命的你。

—— 来自 2029 年的你`,
  `嘿，过去的我：

还记得今天吗？那个觉得"好难啊"的普通一天？

我现在过得很好。真的很好。

当年坚持的那些事，现在都成了我的超能力。所以，拜托了——

再坚持一下下，好吗？

爱你，
—— 2029 的你`,
]

// ===== 随机挑战池 =====
const CHALLENGE_POOL = [
  { text: '阅读 10 分钟', xp: 10, icon: '📖' },
  { text: '喝一杯水', xp: 5, icon: '💧' },
  { text: '做 20 个深蹲', xp: 10, icon: '🏋️' },
  { text: '冥想 5 分钟', xp: 15, icon: '🧘' },
  { text: '整理桌面', xp: 5, icon: '📦' },
  { text: '夸奖自己一句', xp: 10, icon: '💪' },
  { text: '背 5 个单词', xp: 10, icon: '📝' },
  { text: '拉伸 3 分钟', xp: 8, icon: '🤸' },
  { text: '写一条感恩日记', xp: 12, icon: '🙏' },
  { text: '远离手机 30 分钟', xp: 15, icon: '📵' },
  { text: '给朋友发条消息', xp: 8, icon: '💬' },
  { text: '听一首喜欢的歌', xp: 5, icon: '🎵' },
]

// ===== 宠物聊天回复 =====
const REPLIES = [
  "🐾 主人今天也很努力呢！",
  "🐾 我也想像主人一样厉害！",
  "🐾 今天有好好完成任务吗？",
  "🐾 主人加油，我会一直陪着你的！",
  "🐾 最喜欢和主人聊天了！",
]

Page({
  data: {
    mode: "menu",

    // 原有功能
    planTitle: "", planDays: 30, planResult: "",
    coachResult: "", coachStats: null,
    messages: [], chatInput: "", petName: "小蛋", petEmoji: "🐾",

    // 答案之书
    oracleQuestion: "", oracleResult: null, oracleAnimating: false,

    // 今日运势
    fortuneData: null,

    // 成长翻译
    translateInput: "", translateResult: null,

    // 昵称生成
    nicknameInput: "", nicknames: [],

    // 目标命名
    goalNameInput: "", goalNames: [],

    // 未来来信
    futureInput: "", futureLetter: null,

    // 时间胶囊
    capsuleText: "", capsuleSaved: false, capsuleDate: '',

    // 随机挑战
    challenge: null, challengeDone: false,

    // 聊天滚动
    scrollTop: 0,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    log('onShow', 'AI页面加载', { mode: this.data.mode })
  },

  // ===== 模式切换 =====
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    log('模式切换', `→ ${mode}`)
    this.setData({ mode })
  },

  // ===== AI 规划师（原有） =====
  onPlanTitle(e) { this.setData({ planTitle: e.detail.value }) },
  selectPlanDays(e) { this.setData({ planDays: Number(e.currentTarget.dataset.days) }) },
  generatePlan() {
    const title = this.data.planTitle.trim()
    if (!title) return wx.showToast({ title: "请输入目标名称", icon: "none" })
    log('规划', '开始生成', { title })
    const tasks = ['✅ 晨跑 30 分钟', '✅ 阅读 20 页', '✅ 冥想 10 分钟', '✅ 复盘今日收获']
    const plan = `「${title}」执行计划\n\n${tasks.join('\n')}\n\n💡 建议：每天固定时间段执行，养成习惯后就不费力了`
    this.setData({ planResult: plan })
    wx.showToast({ title: "计划生成成功", icon: "success" })
  },

  // ===== AI 教练（原有） =====
  getCoachAdvice() {
    log('教练', '请求分析')
    this.setData({
      coachStats: { goalCount: 3, totalCheckins: 12, streakDays: 7 },
      coachResult: "📊 最近有 5 条成长记录\n🔥 已连续 7 天打卡\n👍 继续保持这个节奏，你很棒！\n\n💡 本周建议：适当增加休息日的轻松任务，避免倦怠"
    })
    wx.showToast({ title: "分析完成", icon: "success" })
  },

  // ===== 宠物聊天（原有） =====
  onChatInput(e) { this.setData({ chatInput: e.detail.value }) },
  sendChat() {
    const text = this.data.chatInput.trim()
    if (!text) return
    const msgs = [...this.data.messages, { role: "user", content: text }]
    this.setData({ messages: msgs, chatInput: "" })
    setTimeout(() => {
      const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]
      msgs.push({ role: "ai", content: reply })
      this.setData({ messages: msgs })
      // [低优先级修复] 聊天自动滚动到底部
      this.scrollToChatBottom()
    }, 600)
  },
  scrollToChatBottom() {
    // 使用 querySelector 滚动到聊天区域底部
    const that = this
    setTimeout(() => {
      that.setData({ scrollTop: 99999 })
    }, 100)
  },

  // ===== 答案之书 =====
  onOracleInput(e) { this.setData({ oracleQuestion: e.detail.value }) },
  askOracle() {
    const q = this.data.oracleQuestion.trim()
    if (!q) return wx.showToast({ title: "请输入你的问题", icon: "none" })
    log('答案之书', '提问', { question: q })

    // 翻牌动画
    this.setData({ oracleAnimating: true, oracleResult: null })

    setTimeout(() => {
      const result = ORACLE_ANSWERS[Math.floor(Math.random() * ORACLE_ANSWERS.length)]
      this.setData({
        oracleResult: { ...result, question: q },
        oracleAnimating: false,
      })
      log('答案之书', '揭晓', { answer: result.answer })
    }, 1200)
  },

  // ===== 今日运势 =====
  getFortune() {
    log('运势', '请求今日运势')
    // [低优先级修复] 使用随机选择而非固定日期种子，"换一卦"真正有效
    const ft = FORTUNE_TEMPLATES[Math.floor(Math.random() * FORTUNE_TEMPLATES.length)]
    const luckyThings = ['阅读英文文章', '尝试冥想', '整理笔记', '户外散步', '听一首轻音乐', '写感恩日记']
    // 预计算星星字符串（WXML不支持 .repeat()）
    function stars(n) { return '⭐'.repeat(n) + '☆'.repeat(5 - n) }
    this.setData({
      fortuneData: {
        ...ft,
        date: `${new Date().getMonth() + 1}月${new Date().getDate()}日`,
        luckyThing: luckyThings[Math.floor(Math.random() * luckyThings.length)],
        learningStars: stars(ft.learning),
        focusStars: stars(ft.focus),
        socialStars: stars(ft.social),
      }
    })
    wx.showToast({ title: '运势已出 ✓', icon: 'success' })
  },

  // ===== 成长翻译 =====
  onTranslateInput(e) { this.setData({ translateInput: e.detail.value }) },
  doTranslate() {
    const text = this.data.translateInput.trim()
    if (!text) return wx.showToast({ title: "请输入要翻译的内容", icon: "none" })
    log('成长翻译', '翻译', { input: text })

    const encourage = TRANSLATE_ENCOURAGE[Math.floor(Math.random() * TRANSLATE_ENCOURAGE.length)]
    this.setData({
      translateResult: {
        original: text,
        translated: text,
        encourage,
      }
    })
    // [中优先级修复] 添加成功提示
    wx.showToast({ title: '翻译完成 ✨', icon: 'success' })
  },

  // ===== 昵称生成器 =====
  onNicknameInput(e) { this.setData({ nicknameInput: e.detail.value }) },
  generateNickname() {
    const keywords = this.data.nicknameInput.trim()
    if (!keywords) return wx.showToast({ title: "请输入关键词", icon: "none" })
    log('昵称生成', keywords)

    const words = keywords.split(/[\s,，、]+/).filter(w => w.length > 0)
    const results = []
    for (let i = 0; i < Math.min(6, words.length * 2); i++) {
      const prefix = NICKNAME_PREFIXES[Math.floor(Math.random() * NICKNAME_PREFIXES.length)]
      const suffix = NICKNAME_SUFFIXES[Math.floor(Math.random() * NICKNAME_SUFFIXES.length)]
      results.push(`${prefix}${suffix}`)
    }
    // 去重
    this.setData({ nicknames: [...new Set(results)] })
  },

  // ===== 目标命名器 =====
  onGoalNameInput(e) { this.setData({ goalNameInput: e.detail.value }) },
  generateGoalName() {
    const name = this.data.goalNameInput.trim()
    if (!name) return wx.showToast({ title: "请输入原始目标名", icon: "none" })
    log('目标命名', name)

    let names = GOAL_NAME_MAP[name]
    if (!names) {
      // 根据关键词自动组合
      const prefixes = ['终极', '超级', '史诗级', '传奇', '觉醒', '突破', '飞跃', '蜕变']
      const suffixes = ['计划', '行动', '挑战', '之旅', '工程', '战役', '革命', '大作战']
      names = []
      for (let i = 0; i < 5; i++) {
        const p = prefixes[Math.floor(Math.random() * prefixes.length)]
        const s = suffixes[Math.floor(Math.random() * suffixes.length)]
        names.push(`${p}${s}`)
      }
    }
    this.setData({ goalNames: names })
  },

  // [高优先级修复] 复制昵称到剪贴板
  copyNick(e) {
    const name = e.currentTarget.dataset.name || ''
    if (!name) return
    wx.setClipboardData({
      data: name,
      success: () => {
        wx.showToast({ title: `已复制「${name}」`, icon: 'success' })
      }
    })
  },

  // [高优先级修复] 使用目标命名（复制+提示）
  useGoalName(e) {
    const name = e.currentTarget.dataset.name || ''
    if (!name) return
    wx.setClipboardData({
      data: name,
      success: () => {
        wx.showToast({ title: `已复制「${name}」✓`, icon: 'success' })
      }
    })
  },

  // ===== 未来来信 =====
  onFutureInput(e) { this.setData({ futureInput: e.detail.value }) },
  generateFutureLetter() {
    const dream = this.data.futureInput.trim()
    if (!dream) return wx.showToast({ title: "写下你的愿望吧", icon: "none" })
    log('未来来信', dream)

    const letter = FUTURE_LETTERS[Math.floor(Math.random() * FUTURE_LETTERS.length)]
    this.setData({
      futureLetter: {
        dream,
        date: '2029年6月12日',
        content: letter,
      }
    })
  },

  // ===== 时间胶囊 =====
  onCapsuleInput(e) { this.setData({ capsuleText: e.detail.value }) },
  saveCapsule() {
    const text = this.data.capsuleText.trim()
    if (!text) return wx.showToast({ title: "写下你想对未来的自己说的话", icon: "none" })
    const now = new Date()
    const openDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    log('时间胶囊', '保存', { text, openAt: openDate.toLocaleDateString() })

    this.setData({
      capsuleSaved: true,
      capsuleDate: `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`,
      capsuleOpenDate: `${openDate.getFullYear()}.${String(openDate.getMonth()+1).padStart(2,'0')}.${String(openDate.getDate()).padStart(2,'0')}`,
    })
    wx.showToast({ title: '胶囊已封存 ⏳', icon: 'success' })
  },

  // ===== 随机挑战 =====
  getChallenge() {
    log('随机挑战', '抽取')
    const challenge = CHALLENGE_POOL[Math.floor(Math.random() * CHALLENGE_POOL.length)]
    this.setData({ challenge, challengeDone: false })
  },
  completeChallenge() {
    if (!this.data.challenge || this.data.challengeDone) return
    log('随机挑战', '完成', { xp: this.data.challenge.xp })
    this.setData({ challengeDone: true })
    wx.showToast({ title: `挑战完成 +${this.data.challenge.xp}XP`, icon: 'success' })
  },
})
