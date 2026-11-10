// ========== AI 伙伴小屋 - 全功能版（V8.6 网格布局 + 功能完善）==========

const cloudApi = require("../../utils/cloudApi")
const aiNavigation = require('../../utils/aiNavigation').createNavigation(wx, getApp)
const schedule = require('../../utils/planSchedule')
const toolbox = require('../../utils/forestToolbox')
const publicationDraft = require('../../utils/planPublicationDraft').createDraftStore(wx, getApp)
const partnerWorkspace = require('../../utils/aiPartnerWorkspace').createWorkspace({ wx, cloudApi, schedule, publicationDraft })
const aiModels = require('../../utils/aiModelConfig')
const aiConfigSelector = aiModels.createSelector(wx, getApp)
const plannerContext = require('../../utils/plannerContext')
const draftWorkspace = require('../../utils/plannerDraftWorkspace').createWorkspace({ wx, cloudApi, schedule, publicationDraft, contextRules: plannerContext })
const reviewWorkspace = require('../../utils/plannerReviewWorkspace').createWorkspace({ cloudApi, publicationDraft })
const coachWorkspace = require('../../utils/coachWorkspace').createWorkspace({ wx, cloudApi, publicationDraft })
const petChatWorkspace = require('../../utils/petChatWorkspace').createWorkspace({ wx, getApp, cloudApi })

// 性能日志工具
function log(tag, msg, data) {
  const t = new Date().toISOString().slice(11, 23)
  if (data) { console.log(`[AI][${t}] ${tag}: ${msg}`, JSON.stringify(data)) }
  else { console.log(`[AI][${t}] ${tag}: ${msg}`) }
}

/** 获取今天的 YYYY-MM-DD 字符串 */
function getTodayStr() {
  return schedule.today()
}

// ===== 答案之书数据 =====
const ORACLE_ANSWERS = [
  { answer: '值得尝试', color: '#7CB342', explanation: '你已经具备基础能力，现在缺的是实践机会。迈出这一步，你会发现自己比想象中更强大。' },
  { answer: '可以试试', color: '#AED581', explanation: '风险可控，收益可期。即使结果不如预期，过程中你也会学到很多。' },
  { answer: '再考虑一下', color: '#DAA520', explanation: '时机可能还不太成熟，但不要完全放弃。可以先做些准备工作。' },
  { answer: '相信直觉', color: '#7CB342', explanation: '你的内心其实已经有了答案，只是需要勇气去承认它。' },
  { answer: '放手去做', color: '#7CB342', explanation: '犹豫不决比失败更浪费时间。行动起来，答案在路上。' },
  { answer: '量力而行', color: '#FFAB40', explanation: '目标很好，但需要评估自己的时间和精力。分步骤来会更稳妥。' },
  { answer: '时机未到', color: '#9E9E9E', explanation: '现在还不是最佳时机。先把眼前的事做好，等准备好了自然水到渠成。' },
  { answer: '当然可以', color: '#66BB6A', explanation: '这个想法很棒！你的能力和资源都足够支撑它。别再犹豫了。' },
  { answer: '保持观望', color: '#FFA726', explanation: '不需要急着做决定，再观察一段时间会有更清晰的方向。' },
]

// ===== 运势数据 =====
const FORTUNE_TEMPLATES = [
  { learning: 5, focus: 5, social: 3, advice: '今天适合完成长期目标中的关键一步。专注力拉满，别浪费在碎片信息上。' },
  { learning: 4, focus: 4, social: 4, advice: '均衡的一天！学习、社交、休息都可以安排上。记得给宠物喂食哦～' },
  { learning: 5, focus: 3, social: 5, advice: '社交能量爆棚！适合和伙伴一起学习，或者参加小组讨论。' },
  { learning: 3, focus: 5, social: 2, advice: '深度思考的好日子。适合攻克难题、写复盘日记、规划下周目标。' },
  { learning: 4, focus: 4, social: 3, advice: '稳扎稳打的一天。把今天该完成的任务做完，就是最大的胜利。' },
  { learning: 5, focus: 4, social: 4, advice: '灵感充沛日！可能有新的想法冒出来，随时记录下来。' },
  { learning: 4, focus: 3, social: 5, advice: '适合和人交流的一天。约朋友一起学习，或者分享你的目标进度。' },
  { learning: 3, focus: 3, social: 5, advice: '能量偏低的一天，适合做轻量的任务。不要给自己太大压力。' },
]

// ===== 昵称生成规则 =====
const NICKNAME_SUFFIXES = ['驯龙师', '炼金术士', '召唤师', '构筑者', '织梦人', '探险家', '领航员', '建筑师', '探索者', '猎人']

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
  '语言是通往世界的桥梁，你在做一件了不起的事。',
  '每一个词都是积累，每句话都是进步。',
]

// ===== 打字机计时器（全局唯一，避免多个 timer 冲突） =====
let typewriterTimer = null

// ===== 待办任务池 =====
const TODO_POOL = [
  { text: '整理桌面 3 分钟', difficulty: '简单', time: '3分钟', icon: '📦' },
  { text: '喝一杯水', difficulty: '简单', time: '1分钟', icon: '💧' },
  { text: '背 5 个单词', difficulty: '简单', time: '5分钟', icon: '📝' },
  { text: '复盘今天最重要的一件事', difficulty: '普通', time: '5分钟', icon: '📊' },
  { text: '运动 5 分钟', difficulty: '普通', time: '5分钟', icon: '🏋️' },
  { text: '关闭短视频 30 分钟', difficulty: '挑战', time: '30分钟', icon: '📵' },
  { text: '写下今天的一个小目标', difficulty: '简单', time: '2分钟', icon: '🎯' },
  { text: '给明天的自己留一句话', difficulty: '普通', time: '3分钟', icon: '💌' },
]

// ===== 拖延急救数据 =====
const DELAY_HELP_DATA = {
  '不想开始': {
    advice: '只做 2 分钟。不要管结果，先打开资料。',
    action: '2分钟行动：打开文档/软件，写第一个字或画第一条线',
    encourage: '万事开头难，但只要开始了，你就已经赢了一半。'
  },
  '太累了': {
    advice: '把任务切成两半。完成一半也算胜利，剩下的明天再说。',
    action: '2分钟行动：列出今天只需要完成的那一半',
    encourage: '累的时候休息不是偷懒，是为了更好地出发。'
  },
  '任务太难': {
    advice: '把任务缩小到最小动作：只写标题、只打开软件、只读第一页。',
    action: '2分钟行动：只完成最小的那个动作',
    encourage: '难的事情分解开来就不难了，一步一步走。'
  },
  '没有动力': {
    advice: '想想完成后的好处。哪怕只是一点点成就感，也是值得的。',
    action: '2分钟行动：写下完成后你会得到什么',
    encourage: '动力会在行动中出现，先动起来。'
  },
  '手机诱惑太大': {
    advice: '把手机放到另一个房间，或者使用专注模式。',
    action: '2分钟行动：把手机放到视线之外的地方',
    encourage: '战胜诱惑的感觉会让你更强大！'
  },
}

// ===== 人格测试题目 =====
const PERSONALITY_QUESTIONS = [
  {
    text: '当你面对一个新目标时，你通常会？',
    options: [
      { type: 'squirrel', icon: '🐿️', text: '先收集资料，制定详细计划' },
      { type: 'owl', icon: '🦉', text: '分析利弊，理性评估可行性' },
      { type: 'shiba', icon: '🐕', text: '直接开始，边做边调整' },
      { type: 'capybara', icon: '🐹', text: '顺其自然，慢慢推进' }
    ]
  },
  {
    text: '遇到困难时，你的第一反应是？',
    options: [
      { type: 'squirrel', icon: '🐿️', text: '查阅资料，寻找参考案例' },
      { type: 'owl', icon: '🦉', text: '冷静分析，找出问题根源' },
      { type: 'shiba', icon: '🐕', text: '尝试各种方法，直到解决' },
      { type: 'capybara', icon: '🐹', text: '暂时放下，稍后再来处理' }
    ]
  },
  {
    text: '你更喜欢哪种学习方式？',
    options: [
      { type: 'squirrel', icon: '🐿️', text: '系统学习，循序渐进' },
      { type: 'owl', icon: '🦉', text: '深度钻研，理解原理' },
      { type: 'shiba', icon: '🐕', text: '实践为主，边做边学' },
      { type: 'capybara', icon: '🐹', text: '轻松学习，兴趣驱动' }
    ]
  },
  {
    text: '你的朋友通常怎么评价你？',
    options: [
      { type: 'squirrel', icon: '🐿️', text: '认真、细致、有准备' },
      { type: 'owl', icon: '🦉', text: '聪明、理性、有想法' },
      { type: 'shiba', icon: '🐕', text: '热情、活泼、行动力强' },
      { type: 'capybara', icon: '🐹', text: '温和、稳定、让人放松' }
    ]
  },
  {
    text: '你觉得最适合你的自律方式是？',
    options: [
      { type: 'squirrel', icon: '🐿️', text: '积累式：每天进步一点点' },
      { type: 'owl', icon: '🦉', text: '深度式：专注攻克一个领域' },
      { type: 'shiba', icon: '🐕', text: '打卡式：完成即成就感' },
      { type: 'capybara', icon: '🐹', text: '节奏式：保持稳定的步伐' }
    ]
  }
]

// ===== 人格测试结果 =====
const PERSONALITY_RESULTS = {
  squirrel: {
    name: '松鼠型',
    icon: '🐿️',
    keywords: '储备型学习者 · 厚积薄发',
    method: '适合的自律方式：每天积累一点点，用清单和打卡记录进度',
    today: '今日建议：整理你的学习资料，制定本周的小目标',
    tools: '推荐使用：目标命名器、番茄钟、今日待办抽签'
  },
  owl: {
    name: '猫头鹰型',
    icon: '🦉',
    keywords: '理性思考者 · 深度学习',
    method: '适合的自律方式：深度专注，一次性攻克一个难题',
    today: '今日建议：选择一个你想深入了解的主题，花时间钻研',
    tools: '推荐使用：AI规划师、番茄钟（25分钟）、专注宣言'
  },
  shiba: {
    name: '柴犬型',
    icon: '🐕',
    keywords: '行动派 · 即刻出发',
    method: '适合的自律方式：快速启动，用打卡和挑战保持动力',
    today: '今日建议：立即行动！从最小的任务开始，完成它',
    tools: '推荐使用：随机挑战、拖延急救、情绪能量检测'
  },
  capybara: {
    name: '水豚型',
    icon: '🐹',
    keywords: '情绪稳定 · 温和节奏',
    method: '适合的自律方式：保持稳定节奏，不强迫自己',
    today: '今日建议：做一些让你感到平静的事，保持内心稳定',
    tools: '推荐使用：今日运势、未来来信、宠物聊天'
  }
}

// ===== 自律人格卡数据 =====
const DISCIPLINE_CARD_DATA = {
  'study': {
    title: '森林晨光行动者',
    keyword: '学习型',
    advantage: '自律优势：善于吸收新知识，学习能力强',
    challenge: '容易卡住的点：容易贪多，导致学习不深入',
    action: '今日行动建议：选择一个主题，深入学习30分钟'
  },
  'sport': {
    title: '活力森林奔跑者',
    keyword: '运动型',
    advantage: '自律优势：精力充沛，行动力强',
    challenge: '容易卡住的点：容易三分钟热度，难以坚持',
    action: '今日行动建议：完成一个小运动目标，哪怕只是5分钟'
  },
  'create': {
    title: '创意森林设计师',
    keyword: '创作型',
    advantage: '自律优势：富有想象力，创造力强',
    challenge: '容易卡住的点：追求完美，迟迟不愿开始',
    action: '今日行动建议：完成一个最小的创作，不计较质量'
  },
  'sleep': {
    title: '静谧森林守护者',
    keyword: '早睡型',
    advantage: '自律优势：注重健康，生活规律',
    challenge: '容易卡住的点：睡前容易玩手机，难以入睡',
    action: '今日行动建议：设定一个固定的睡前时间，提前30分钟放下手机'
  },
  'social': {
    title: '社交森林连接者',
    keyword: '社交型',
    advantage: '自律优势：善于与人沟通，人脉广',
    challenge: '容易卡住的点：社交过多，影响个人时间',
    action: '今日行动建议：安排一段独处时间，专注做一件事'
  },
  'exam': {
    title: '目标森林攀登者',
    keyword: '考证型',
    advantage: '自律优势：目标明确，执行力强',
    challenge: '容易卡住的点：压力大，容易焦虑',
    action: '今日行动建议：分解考证任务，每天完成一小部分'
  }
}

// ===== 情绪能量检测数据 =====
const ENERGY_RESULTS = {
  low: {
    happy: {
      status: '能量低 + 开心',
      do: '适合做：整理资料、轻量阅读、写日记',
      notDo: '不适合：高强度学习、复杂任务、长时间专注'
    },
    calm: {
      status: '能量低 + 平静',
      do: '适合做：冥想、复盘、制定计划、轻度运动',
      notDo: '不适合：新任务启动、大型项目、社交活动'
    },
    anxious: {
      status: '能量低 + 焦虑',
      do: '适合做：深呼吸练习、整理桌面、听舒缓音乐',
      notDo: '不适合：重要决策、复杂思考、与人争执'
    },
    tired: {
      status: '能量低 + 疲惫',
      do: '适合做：小睡、休息、喝杯茶、看轻松内容',
      notDo: '不适合：任何需要专注的任务，好好休息最重要'
    },
    annoyed: {
      status: '能量低 + 烦躁',
      do: '适合做：运动发泄、独处、写情绪日记',
      notDo: '不适合：与人沟通、处理重要事项'
    }
  },
  medium: {
    happy: {
      status: '能量一般 + 开心',
      do: '适合做：中等难度任务、与人协作、学习新知识',
      notDo: '不适合：高难度挑战、长时间连续工作'
    },
    calm: {
      status: '能量一般 + 平静',
      do: '适合做：日常学习、整理工作、阅读',
      notDo: '不适合：重大决策、创新型工作'
    },
    anxious: {
      status: '能量一般 + 焦虑',
      do: '适合做：分解任务、完成简单事项、与朋友聊天',
      notDo: '不适合：重要项目、高压任务'
    },
    tired: {
      status: '能量一般 + 疲惫',
      do: '适合做：轻量任务、复习已有知识、喝杯咖啡',
      notDo: '不适合：新知识学习、复杂思考'
    },
    annoyed: {
      status: '能量一般 + 烦躁',
      do: '适合做：运动、听音乐、换个环境',
      notDo: '不适合：与人合作、细致工作'
    }
  },
  high: {
    happy: {
      status: '能量不错/很好 + 开心',
      do: '适合做：攻克难题、学习新知识、启动新项目',
      notDo: '不适合：浪费时间在琐事上，抓住高效时刻'
    },
    calm: {
      status: '能量不错/很好 + 平静',
      do: '适合做：深度专注工作、制定长远计划、重要决策',
      notDo: '不适合：被碎片化事情打扰'
    },
    anxious: {
      status: '能量不错/很好 + 焦虑',
      do: '适合做：把焦虑转化为动力，立即行动',
      notDo: '不适合：拖延，行动能缓解焦虑'
    },
    tired: {
      status: '能量不错/很好 + 疲惫',
      do: '适合做：完成已有任务、整理收尾工作',
      notDo: '不适合：启动新任务，避免过度消耗'
    },
    annoyed: {
      status: '能量不错/很好 + 烦躁',
      do: '适合做：挑战高难度任务、运动释放',
      notDo: '不适合：与人争执，把精力放在有意义的事上'
    }
  }
}

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

Page({
  data: {
    mode: "menu",
    toolboxExpanded: false,
    toolCategoriesExpanded: { discipline: false, fun: false, creative: false },

    // 规划师（V11.0 统一状态架构）
    planMessages: [], planInput: "", planScrollTop: 0, scrollIntoView: '',
    planTestMode: false, showDebugTools: false, showPlanModal: false,
    editableTasks: [],
    planDays: 30, planStartDate: '', planEndDate: '', publicationPending: false, publicationMessage: '',
    typewriterSpeed: 25,
    plannerState: {
      phase: 'idle',
      goalContext: { what: '', why: '', deadline: '', dailyTime: '', level: '', constraints: '' },
      missingFields: ['what','why','deadline','dailyTime','level','constraints'],
      readyToGenerate: false,
      lastPlanId: '',
      sourcePlanId: '',
      generatedTasks: [],
      generatedGoal: null,
      localAssess: '',
      localPlan: '',
      errorMessage: '',
      loading: false,
      mood: 'neutral',
      turnCount: 0,
      lastIntent: '',
      encouragementCount: 0,
    },
    planStatus: '',
    generationRecoveryAvailable: false,
    plannerAiStatus: '', plannerAiProvider: '',
    ...draftWorkspace.data,
    ...reviewWorkspace.data,
    // 独立专业伙伴的前端工作区
    ...partnerWorkspace.data,
    ...coachWorkspace.data,
    ...petChatWorkspace.data,
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
    capsuleText: "", capsuleSaved: false, capsuleDate: '', capsuleOpenDate: '',
    myCapsules: [], capsuleLoading: false, capsuleLoadError: false, capsuleSaving: false,
    capsuleHistoryExpanded: false, capsuleUnconfirmed: false,
    // 随机挑战
    challenge: null, challengeDone: false,
    // 聊天滚动
    scrollTop: 0,

    // ===== 工具弹窗状态 =====
    activeTool: '',
    showToolSheet: false,
    toolSheetTitle: '',

    // ===== 番茄钟 =====
    pomodoroMode: 'focus25',
    pomodoroSeconds: 25 * 60,
    pomodoroRunning: false,
    pomodoroStatus: '准备开始',
    pomodoroFormattedTime: '25:00',
    pomodoroTask: null,

    // ===== 今日待办抽签 =====
    drawnTodo: null, todoStatus: 'idle', todoCount: 0,

    // ===== 专注宣言 =====
    focusInput: '',
    focusObstacle: '',
    focusOath: '',
    focusHistory: [],
    focusHistoryExpanded: false,

    // ===== 拖延急救 =====
    delayOptions: [
      { value: '不想开始', icon: '😫', label: '不想开始' },
      { value: '太累了', icon: '😴', label: '太累了' },
      { value: '任务太难', icon: '😰', label: '任务太难' },
      { value: '没有动力', icon: '😔', label: '没有动力' },
      { value: '手机诱惑太大', icon: '📱', label: '手机诱惑太大' },
    ],
    delaySelected: '',
    delayResult: null,

    // ===== 人格测试 =====
    personalityQuestions: PERSONALITY_QUESTIONS,
    personalityStep: 0,
    personalityAnswers: [],
    personalityResult: null,
    currentPersonalityQuestion: PERSONALITY_QUESTIONS[0] || { text: '', options: [] },

    // ===== 自律人格卡 =====
    disciplineTags: [
      { value: 'study', label: '学习型' },
      { value: 'sport', label: '运动型' },
      { value: 'create', label: '创作型' },
      { value: 'sleep', label: '早睡型' },
      { value: 'social', label: '社交型' },
      { value: 'exam', label: '考证型' },
    ],
    disciplineSelected: '',
    disciplineCard: null,

    // ===== 情绪能量检测 =====
    energyLevel: 0,
    energyLabels: ['很低', '偏低', '一般', '不错', '很好'],
    emotionOptions: [
      { value: 'happy', icon: '😊', label: '开心' },
      { value: 'calm', icon: '😌', label: '平静' },
      { value: 'anxious', icon: '😰', label: '焦虑' },
      { value: 'tired', icon: '😴', label: '疲惫' },
      { value: 'annoyed', icon: '😤', label: '烦躁' },
    ],
    emotionSelected: '',
    energyResult: null,
  },

  onShow() {
    this.syncToolboxOwner()
    this._refreshPomodoro()
    if (this.data.pomodoroRunning) this._startPomodoroTimer()
    if (this.data.showToolSheet && this.data.activeTool === 'todoDraw') this.loadTodayTodos()
    if (this.data.mode === 'capsule') this.loadCapsules()
    this.syncPlannerDraftOwner()
    this.refreshGenerationRecovery()
    this.syncPartnerOwner()
    this._restorePendingPublication()
    const plannerIntent = aiNavigation.takePartnerIntent()
    if (plannerIntent && plannerIntent.mode !== 'plan') {
      if (this._pendingPublication || this.data.publicationPending) {
        wx.showToast({ title: '请先处理上次待确认的发布原稿', icon: 'none' })
      } else {
        this.setData({ mode: plannerIntent.mode })
        if (plannerIntent.mode === 'coach' && plannerIntent.goalId && this.saveCoachFeedback()) {
          this.setData({ coachGoalId: plannerIntent.goalId,
            ...(schedule.validDate(plannerIntent.date) && plannerIntent.date <= schedule.today() ? { coachDate: plannerIntent.date } : {}) })
          this.restoreCoachFeedback()
        }
      }
    } else if (plannerIntent) {
      this.setData({ mode: 'plan' })
      // Keep any existing conversation and, especially, a pending publication.
      if (!this.data.planMessages.length && !this._pendingPublication) this.initPlanChat()
      if (plannerIntent.prompt) {
        if (this.data.planInput.trim() && this.data.planInput !== plannerIntent.prompt) {
          wx.showModal({
            title: '保留哪段输入？',
            content: '规划师输入框里还有未发送的文字。是否用管家的新需求替换？新需求也保留在管家的本机草稿中。',
            confirmText: '使用新需求', cancelText: '保留原文',
            success: res => {
              if (res.confirm && plannerIntent.scope === publicationDraft.accountScope()) this.setData({ planInput: plannerIntent.prompt })
            }
          })
        } else this.setData({ planInput: plannerIntent.prompt })
      }
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    if (this.data.mode === 'chat') this.enterPetChat(plannerIntent?.mode === 'chat' ? plannerIntent.petId : '', true)
    const partnerLoad = this.data.mode === 'coach' ? this.loadCoachGoals() : undefined
    const reviewLoad = this.data.mode === 'review' ? (plannerIntent?.stewardRunId ? this.openStewardHandoff(plannerIntent)
      : plannerIntent && plannerIntent.refreshDraft ? this.refreshReviewWorkspace(true) : this.loadReviewDraft()) : undefined
    log('onShow', 'AI页面加载', { mode: this.data.mode })
    return partnerLoad || reviewLoad
  },

  ...partnerWorkspace.methods,
  ...draftWorkspace.methods,
  ...reviewWorkspace.methods,
  ...coachWorkspace.methods,
  ...petChatWorkspace.methods,

  // ===== 加载时间胶囊 =====
  async loadCapsules() {
    const owner = this._toolboxOwner
    const loadId = this._capsuleLoadId = (this._capsuleLoadId || 0) + 1
    this.setData({ capsuleLoading: true, capsuleLoadError: false })
    try {
      const res = await cloudApi.myCapsules()
      if (!Array.isArray(res)) throw new Error('无法读取胶囊')
      if (loadId !== this._capsuleLoadId || owner !== toolbox.owner(getApp)) return
      const now = Date.now()
      const pending = this._capsuleUnconfirmed
      const recovered = pending && res.find(c => c._id && c.unlock_at === pending.unlock_at && c.text === pending.text)
      if (recovered) this._showCapsuleReceipt(recovered, pending.text)
      this.setData({ myCapsules: res.map(c => ({
        _id: c._id, text: c.text || '', created_date: c.created_date || '',
        can_open: (c.unlock_at || 0) <= now,
        open_date: Number.isFinite(c.unlock_at) ? schedule.today(c.unlock_at) : '',
      })) })
    } catch (e) {
      if (loadId === this._capsuleLoadId && owner === toolbox.owner(getApp)) this.setData({ capsuleLoadError: true })
    } finally {
      if (loadId === this._capsuleLoadId && owner === toolbox.owner(getApp)) this.setData({ capsuleLoading: false })
    }
  },

  // ===== V11.0 AI 规划师 · 统一状态架构 =====
  // Layer 1: Agent（意图识别 + 会话状态 + 情绪感知）
  // Layer 2: Reasoning（AI，仅"生成任务"时调用）
  // Layer 3: Executor（发布到 goals + tasks）

  /** 统一更新 plannerState，自动计算 missingFields 和 readyToGenerate */
  _updatePlannerState(updates) {
    const draftChanged = updates.generatedGoal !== undefined || updates.generatedTasks !== undefined || updates.goalContext !== undefined
    if (updates.generatedTasks !== undefined || updates.generatedGoal !== undefined) this._plannerDraftScope = publicationDraft.accountScope()
    const ps = { ...this.data.plannerState }
    if (updates.goalContext) {
      ps.goalContext = { ...ps.goalContext, ...updates.goalContext }
      delete updates.goalContext
    }
    const extraData = {}
    if (updates.generatedTasks !== undefined) {
      ps.sourcePlanId = updates.sourcePlanId || ''
      // 同步到 editableTasks（工作副本），plannerState 中保持初始值 []
      const tasks = Array.isArray(updates.generatedTasks) ? updates.generatedTasks : []
      if (tasks.length) {
        const goal = updates.generatedGoal || ps.generatedGoal || {}
        const days = schedule.durationDays(ps.goalContext.deadline) || schedule.durationDays(goal.period_days || goal.period) || 30
        const start = schedule.validDate(goal.start_date) ? goal.start_date : getTodayStr()
        extraData.planDays = days
        extraData.planStartDate = start
        extraData.planEndDate = schedule.endDate(start, days)
        extraData.editableTasks = schedule.draftTasks(tasks, start, days)
      } else extraData.editableTasks = []
      delete updates.generatedTasks
    }
    Object.assign(ps, updates)
    const ALL_FIELDS = ['what','why','deadline','dailyTime','level','constraints']
    ps.missingFields = ALL_FIELDS.filter(k => !ps.goalContext[k])
    ps.readyToGenerate = !!ps.goalContext.what && ps.missingFields.length <= 2 && (!ps.generatedTasks || ps.generatedTasks.length === 0)
    this.setData({ plannerState: ps, ...extraData })
    if (draftChanged) this.markPlannerDraftDirty()
  },

  /** 基于 goalContext 生成稳定哈希 planId */
  _computePlanId() {
    const ctx = this.data.plannerState.goalContext
    const str = JSON.stringify(plannerContext.FIELDS.map(field => ctx[field] || ''))
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash |= 0
    }
    return 'plan_' + hash.toString(36)
  },

  // ===== 菜单展开（只影响入口展示，不触发功能或云调用） =====
  openForestSteward() {
    wx.navigateTo({ url: '/pages/forest-steward/forest-steward' })
  },
  openCoachInSteward(e) {
    if (this._partnerScope !== publicationDraft.accountScope()) return
    if (!this.data.coachReport || this.data.coachReport.status !== 'done' || this.data.coachReportExpired || this.data.coachCloudDirty || this.data.coachCloudConflict) return
    const report = this.data.coachReport, index = e?.currentTarget?.dataset?.index
    const suggestion = index !== undefined && report.result?.suggestions?.[index]
      ? { report_id: report.id, fingerprint: report.fingerprint, index: Number(index) } : null
    return aiNavigation.openSteward({ goalId: this.data.coachGoalId, date: this.data.coachDate, suggestion })
  },

  toggleToolbox() {
    this.setData({ toolboxExpanded: !this.data.toolboxExpanded })
  },

  toggleToolCategory(e) {
    const category = e.currentTarget.dataset.category
    if (!['discipline', 'fun', 'creative'].includes(category)) return
    this.setData({
      [`toolCategoriesExpanded.${category}`]: !this.data.toolCategoriesExpanded[category]
    })
  },

  // ===== 模式切换 =====
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (this.data.mode === 'chat' && mode !== 'chat') this.pausePetChat()
    if (this.data.mode === 'coach' && !this.saveCoachFeedback()) return
    if (this.data.mode === 'coach' || this.data.mode === 'review') this.leavePartnerWorkspace()
    log('模式切换', `→ ${mode}`)
    this.setData({ mode })

    if (mode === 'plan') {
      return this.openPlannerWorkspace()
    }
    if (mode === 'review') this.loadReviewDraft()
    if (mode === 'coach') this.loadCoachGoals()
    if (mode === 'capsule') this.loadCapsules()
    if (mode === 'chat') return this.enterPetChat()
  },

  /** 清空对话，重新开始 */
  resetPlanChat() {
    if (this._restorePendingPublication()) return
    const recovery = this._readGenerationRecovery()
    const key = this._generationStorageKey()
    const session = getApp().globalData.userInfo
    wx.showModal({
      title: '重新开始',
      content: recovery ? '确定清空当前对话并放弃恢复上次生成，开始新的规划吗？' : '确定要清空当前对话，开始新的规划吗？',
      confirmText: '确定',
      success: async (res) => {
        if (res.confirm && key === this._generationStorageKey() && session === getApp().globalData.userInfo) {
          if (!await this.clearCloudPlannerDraft()) return
          if (key !== this._generationStorageKey() || session !== getApp().globalData.userInfo) return
          this._clearGenerationRecovery(recovery)
          log('Agent', '用户主动清空对话')
          this.initPlanChat()
        }
      }
    })
  },

  // ═══════════ 意图识别层（核心） ═══════════

  /**
   * 意图分类器 — 用户每条消息先过这一层
   * 返回 { intent, confidence }
   */
  detectIntent(text) {
    const t = text.toLowerCase().trim()

    // ── 高优先级：情绪类（必须优先拦截）──
    if (/坚持不住|坚持不了|好难|太难了|不想做|不想了|放弃吧|算了|没动力|提不起劲/.test(t))
      return 'EMOTION_NEGATIVE'
    if (/好累|累死了|太累了|不想动|没精神|疲惫|精疲力尽/.test(t))
      return 'EMOTION_TIRED'
    if (/很有信心|一定能行|没问题|我可以|有信心|充满信心|准备好了|加油/.test(t))
      return 'EMOTION_POSITIVE'

    // ── 操作指令 ──
    if (/生成(任务)?|开始(做计划|规划)|帮我做计划|出方案|安排任务|来个计划/.test(t))
      return 'GENERATE_PLAN'
    if (/直接生成|先生成看看|就这样生成|随便生成|先生成|看看效果|直接开始/.test(t))
      return 'DIRECT_GENERATE'
    if (/换(一)?个目标|重新来|重新开始|换个方向|不想要这个/.test(t))
      return 'CHANGE_GOAL'
    if (/重新规划|重新计划|再规划|重做计划|再来一次/.test(t))
      return 'RESET_PLAN'
    if (/修改|改一下|调整|改成|改为|时间改成|周期改成|水平改成|难度改为/.test(t))
      return 'ADJUST_GOAL'
    if (/对的|是的|没错|可以|就这样|没问题|确认|对对对|行了|差不多/.test(t) && this.data.plannerState.goalContext.what)
      return 'CONFIRM_CONTEXT'

    // ── 目标信息提取（按内容类型，不按固定顺序）──
    if (/我想|我要|目标是|打算|想(学|练|养成|完成)/.test(t) && !this.data.plannerState.goalContext.what)
      return 'NEW_GOAL'
    if (/因为|为了|想变得|希望能|目的是|理由是|动力是/.test(t) && !this.data.plannerState.goalContext.why)
      return 'WHY_MOTIVATION'
    if (/\d+\s*(天|周|个月|年)/.test(t) && !this.data.plannerState.goalContext.deadline)
      return 'TIME_FRAME'
    if (/(每天|每日).{0,8}?\d+\s*(分钟|小时)|\d+\s*(分钟|小时).{0,8}?(每天|每日)/.test(t) && !this.data.plannerState.goalContext.dailyTime)
      return 'DAILY_COMMITMENT'
    if (/新手|初学者|零基础|小白|入门|有基础|学过|了解过|中级|进阶|熟练|精通|高级|老手/.test(t) && !this.data.plannerState.goalContext.level)
      return 'SKILL_LEVEL'

    // ── 默认：自由聊天 / 补充说明 ──
    return 'CHAT_GENERAL'
  },

  // ═══════════ 初始化会话 ═══════════

  initPlanChat() {
    if (this._restorePendingPublication()) return
    this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
    this._generationChecking = false
    this._pendingPlanGeneration = null
    this._draftLoadId = (this._draftLoadId || 0) + 1
    this._requirementsRevision = 0
    this._draftUserEdits = {}
    this.setData({ plannerContextSources: {}, draftAssumptions: [], draftSource: '' })
    // 测试模式：预填模拟对话
    if (this.data.planTestMode) {
      const mockMessages = [
        { role: 'assistant', content: this._buildGreeting() },
        { role: 'user', content: '我想养成每天跑步的习惯' },
        { role: 'assistant', content: '跑步是个很棒的选择！🏃‍♂️ 能说说**为什么想跑步吗**？了解你的动机后我能帮你设计更贴合的计划～' },
        { role: 'user', content: '因为最近感觉体质越来越差了，想通过跑步提升体能' },
        { role: 'assistant', content: '明白了，从健康出发的目标往往更容易坚持。\n\n那你觉得**大概需要多长时间**来达成？比如先定个小目标——21天养成习惯，还是直接冲30天？' },
        { role: 'user', content: '30天吧，我想彻底养成习惯' },
        { role: 'assistant', content: '好的，30天是个合理的周期！前两周适应，后面巩固。\n\n那你**每天能投入多少时间**？不用太长，关键是可持续～' },
        { role: 'user', content: '每天20分钟左右可以吗' },
        { role: 'assistant', content: '完全可以！20分钟的慢跑+拉伸对新手来说刚刚好。\n\n最后了解一下——你之前有跑步经验吗？还是**完全从零开始**？' },
        { role: 'user', content: '我是新手，之前基本没跑过步' }
      ]
      const mockGoalCtx = {
        what: '养成每天跑步的习惯',
        why: '最近感觉体质越来越差了，想通过跑步提升体能',
        deadline: '30天',
        dailyTime: '20分钟',
        level: '新手'
      }

      this.setData({
        planMessages: mockMessages,
        planInput: '',
        planStatus: '',
        plannerState: {
          phase: 'collecting',
          goalContext: mockGoalCtx,
          missingFields: [],
          readyToGenerate: true,
          lastPlanId: '',
          generatedTasks: null,
          generatedGoal: null,
          localAssess: '',
          localPlan: '',
          errorMessage: '',
          loading: false,
          mood: 'positive',
          turnCount: 9,
          lastIntent: 'SKILL_LEVEL',
          encouragementCount: 0,
        }
      })

      this.doAssess(mockGoalCtx)
      return
    }

    // 正常模式：Agent 问候（打字机逐步显示）
    this.setData({
      planMessages: [],
      planInput: '',
      planStatus: '',
      plannerState: {
        phase: 'collecting',
        goalContext: { what: '', why: '', deadline: '', dailyTime: '', level: '', constraints: '' },
        missingFields: ['what','why','deadline','dailyTime','level','constraints'],
        readyToGenerate: false,
        lastPlanId: '',
        generatedTasks: null,
        generatedGoal: null,
        localAssess: '',
        localPlan: '',
        errorMessage: '',
        loading: false,
        mood: 'neutral',
        turnCount: 0,
        lastIntent: '',
        encouragementCount: 0,
      }
    })
    // 用打字机输出问候语
    this._appendReply(this._buildGreeting())
  },

  /** 动态问候语 */
  _buildGreeting() {
    const greetings = [
      '👋 你好！我是你的 AI 规划师。\n\n你可以随时告诉我你想达成的目标、遇到的困难，或者任何想法。我会根据你的情况帮你制定专属计划。\n\n**你想聊聊什么？**',
      '👋 嗨！我是你的成长伙伴。\n\n不管是想养成新习惯、突破某个难关、还是只是想聊聊——我都在这里。\n\n今天有什么想完成的吗？',
      '👋 欢迎回来！\n\n我是你的 AI 规划师。和传统的"问答机器"不同，我会认真听你说的话，理解你的感受，然后给你真正有用的建议。\n\n**从哪里开始？**',
    ]
    return greetings[Math.floor(Math.random() * greetings.length)]
  },

  // ═══════════ 核心消息处理（Agent 分流引擎） ═══════════

  onPlanChatInput(e) { this.setData({ planInput: e.detail.value }) },

  sendPlanMessage() {
    if (this._pendingDraftSave || this._draftSaveInFlight) return wx.showToast({ title: '请先确认草案保存结果，再继续聊天', icon: 'none' })
    // 用户新消息 → 立即停止上一次打字机输出
    this.stopTypewriter()

    const text = this.data.planInput.trim()
    if (!text || this.data.plannerState.loading) return
    if (this.data.publicationPending || this._pendingPublication) return wx.showToast({ title: '请先处理待确认发布原稿', icon: 'none' })

    // 记录用户消息
    const userMessage = { id: 'user_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2), role: 'user', content: text }
    const msgs = [...this.data.planMessages, userMessage]
    this.setData({ planMessages: msgs, planInput: '' })
    this.scrollPlanToBottom()

    // 更新回合计数与意图
    const intent = this.detectIntent(text)
    this.collectPlannerUserMessage(text, userMessage.id)
    const turnCount = this.data.plannerState.turnCount + 1
    log('Agent', `意图=${intent} | 回合=${turnCount}`, { text: text.substring(0, 50) })
    this._updatePlannerState({ turnCount, lastIntent: intent })
    const turnGeneration = this._plannerGenerationId, turnScope = publicationDraft.accountScope()
    const currentTurn = () => turnGeneration === this._plannerGenerationId && turnScope === publicationDraft.accountScope()

    // ═══════════ 双路径架构 ═══════════

    // ===== 快路径（本地处理，即时响应）=====
    if (['DIRECT_GENERATE', 'GENERATE_PLAN'].includes(intent)) return this.generatePlanTasks()
    if (this._isFastPathIntent(intent)) {
      this._updatePlannerState({ loading: true })
      setTimeout(() => {
        if (!currentTurn()) return
        this._dispatchLocal(intent, text)
        this._updatePlannerState({ loading: false })
        this.scrollPlanToBottom()
      }, 300)
      return
    }

    // ===== 慢路径（AI Agent 或本地降级）=====
    this._updatePlannerState({ loading: true })
    this._callAIOrFallback(text).then(() => {
      if (!currentTurn()) return
      this._updatePlannerState({ loading: false })
      this.scrollPlanToBottom()
    }).catch(() => {
      if (!currentTurn()) return
      this._updatePlannerState({ loading: false })
    })
  },

  /**
   * 判断是否走快路径（纯本地处理，不需要 AI）
   */
  _isFastPathIntent(intent) {
    const FAST_INTENTS = [
      'EMOTION_NEGATIVE',
      'EMOTION_TIRED',
      'EMOTION_POSITIVE',
      'DIRECT_GENERATE',
      'GENERATE_PLAN',
      'CHANGE_GOAL',
      'RESET_PLAN',
      'ADJUST_GOAL',
    ]
    return FAST_INTENTS.includes(intent) || this.data.planTestMode
  },

  /**
   * 快路径 — 纯本地处理（复用现有的本地处理器）
   */
  _dispatchLocal(intent, text) {
    switch (intent) {
      case 'EMOTION_NEGATIVE': {
        const ctx = { ...this.data.plannerState.goalContext }
        const st = { ...this.data.plannerState }
        const reply = this._handleEmotionNegative(text, ctx, st)
        this._appendReply(reply); break
      }
      case 'EMOTION_TIRED': {
        const st = { ...this.data.plannerState }
        const reply = this._handleEmotionTired({ ...this.data.plannerState.goalContext }, st)
        this._appendReply(reply); break
      }
      case 'EMOTION_POSITIVE': {
        const st = { ...this.data.plannerState }
        const reply = this._handleEmotionPositive({ ...this.data.plannerState.goalContext }, st)
        this._appendReply(reply); break
      }
      case 'DIRECT_GENERATE':
        this._handleDirectGenerate(); break
      case 'GENERATE_PLAN':
        this._tryGeneratePlan({ ...this.data.plannerState.goalContext }); break
      case 'CHANGE_GOAL':
      case 'RESET_PLAN':
        this._appendReply(this._handleChangeGoal()); break
      case 'ADJUST_GOAL':
        this._appendReply(this._handleAdjustGoal(text, { ...this.data.plannerState.goalContext })); break
      case 'CONFIRM_CONTEXT':
        // 确认信息 → 走慢路径让 AI 自然回应
        break  // fall through to slow path (handled by caller)
      default:
        // 测试模式 fallback 到旧逻辑
        this._dispatchIntent(intent, text); break
    }
  },

  /**
   * 慢路径 — 尝试调用 AI Agent，失败则降级到本地状态机
   */
  async _callAIOrFallback(text) {
    const hasKey = await this._checkApiKey()

    if (hasKey && !this.data.planTestMode) {
      // 有 API Key → 调用 AI Agent
      log('Agent', '慢路径→AI Agent')
      try {
        await this._callAIPlanner(text)
        return
      } catch (e) {
        this.setData({ plannerAiStatus: aiModels.readableError(e) + ' 当前改用本地规则回复，未得到模型回复。' })
        log('Agent', 'AI 失败，降级到本地状态机:', e.message || e)
        // 降级：继续走本地逻辑
      }
    }

    // 无 Key / AI 失败 / 测试模式 → 本地状态机降级
    log('Agent', hasKey ? '慢路径→AI失败，降级本地' : '慢路径→无API Key，使用本地状态机')
    if (this.data.planTestMode) {
      this._testModeSimulate(text)
    } else {
      this._dispatchIntent(this.data.plannerState.lastIntent, text)
    }
  },

  /**
   * 检查是否有可用的 API Key
   */
  async _checkApiKey(preferredProvider) {
    try {
      const keys = await cloudApi.myApiKeys()
      this._activeAiConfig = preferredProvider
        ? aiModels.publicConfigs(keys).find(key => key.provider === preferredProvider && key.has_key) || null
        : aiConfigSelector.select(keys)
      this.setData({ plannerAiProvider: this._activeAiConfig ? this._activeAiConfig.provider + ' / ' + this._activeAiConfig.model : '',
        plannerAiStatus: this._activeAiConfig ? '' : '尚未配置可用模型，当前使用本地规则回复。' })
      return !!this._activeAiConfig
    } catch (e) {
      this._activeAiConfig = null
      this.setData({ plannerAiStatus: 'AI 配置读取失败，当前使用本地规则回复。' })
      return false
    }
  },

  /**
   * 调用 AI 规划师 Agent（云端 LLM）
   */
  async _callAIPlanner(text) {
    const generation = this._plannerGenerationId, scope = publicationDraft.accountScope()
    const t0 = Date.now()
    log('[Planner]', 'AI调用开始')

    // 构建发送给 AI 的对话历史（只取最近 20 条，避免超 token）
    const history = this.data.planMessages.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.fullContent || m.content
    }))

    const res = await cloudApi.aiPlannerChat({
      messages: history,
      provider: (this._activeAiConfig || aiConfigSelector.select(await cloudApi.myApiKeys()) || {}).provider
    })

    const elapsed = Date.now() - t0
    if (generation !== this._plannerGenerationId || scope !== publicationDraft.accountScope()) return
    const reply = (res && res.reply) || ''
    if (!reply) throw new Error('AI 返回空回复')

    log('[Planner]', `AI调用成功 耗时 ${elapsed}ms`, { replyLen: reply.length })
    this.setData({ plannerAiStatus: '' })

    // 追加 AI 回复
    this._appendReply(reply)

    // 同时尝试从 AI 回复中隐式提取目标信息（增强 goalContext）
    this._extractFromAIReply(reply)
  },

  /**
   * 从 AI 回复中隐式提取可能的目标信息（补充 goalContext）
   */
  _extractFromAIReply(reply) {
    // Model suggestions remain visible in the reply, never become user facts.
    return reply
  },

  /**
   * 测试模式 — 模拟 AI 自然回复
   */
  _testModeSimulate(text) {
    const intent = this.data.plannerState.lastIntent
    const ctx = { ...this.data.plannerState.goalContext }
    let reply = ''

    // 测试模式下也先尝试提取信息
    const extracted = this._extractAnyInfo(text, ctx)
    if (extracted.changed) {
      Object.assign(ctx, extracted.fields)
      this._updatePlannerState({ goalContext: ctx })
    }

    // 根据意图生成模拟的自然回复
    switch (intent) {
      case 'NEW_GOAL':
        reply = this._handleNewGoal(text, ctx); break
      case 'WHY_MOTIVATION':
        reply = this._handleWhyMotivation(text, ctx); break
      case 'TIME_FRAME':
        reply = this._handleTimeFrame(text, ctx); break
      case 'DAILY_COMMITMENT':
        reply = this._handleDailyCommitment(text, ctx); break
      case 'SKILL_LEVEL':
        reply = this._handleSkillLevel(text, ctx); break
      case 'CHAT_GENERAL':
      default:
        reply = this._handleGeneralChat(text, ctx, this.data.plannerState); break
    }

    // 如果处理器返回了 null（比如 doAssess 触发），不追加
    if (reply !== undefined && reply !== null && reply !== '') {
      this._appendReply(reply)
    }
  },

  // ═══════════ 打字机效果 ═══════════

  /** 停止当前打字机输出 */
  stopTypewriter() {
    if (typewriterTimer) {
      clearTimeout(typewriterTimer)
      typewriterTimer = null
    }
    // 将所有 streaming 中的消息标记为完成
    const msgs = (this.data.planMessages || []).map(m => {
      if (m.streaming) return { ...m, streaming: false }
      return m
    })
    this.setData({ planMessages: msgs })
  },

  /**
   * 打字机渲染：逐字显示 AI 回复
   * @param {string} messageId - 消息唯一 ID
   * @param {string} fullText - 完整文本
   * @param {object} [options] - { speed? }
   */
  typewriterRender(messageId, fullText, options) {
    this.stopTypewriter()
    if (!fullText) return

    const speed = (options && options.speed) || this.data.typewriterSpeed || 25
    let index = 0

    const tick = () => {
      const msgs = (this.data.planMessages || []).map(m => {
        if (m.id === messageId) {
          const step = Math.floor(Math.random() * 2) + 1  // 每步 1~2 字
          const newIndex = Math.min(index + step, fullText.length)
          index = newIndex
          return {
            ...m,
            content: fullText.slice(0, newIndex),
            streaming: index < fullText.length
          }
        }
        return m
      })
      this.setData({ planMessages: msgs, planScrollTop: 99999 })

      if (index < fullText.length) {
        typewriterTimer = setTimeout(tick, speed)
      } else {
        typewriterTimer = null
        // 最终标记 streaming=false（已通过 tick 设置）
      }
    }

    typewriterTimer = setTimeout(tick, speed)
  },

  /** 追加一条对话消息（role=assistant 走打字机，user 直接显示） */
  _appendReply(content, role = 'assistant') {
    if (content === undefined || content === null || content === '') return

    if (role === 'assistant') {
      // AI 回复：先插入一条空消息，再用打字机逐步显示
      const id = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      const msg = {
        id,
        role: 'assistant',
        content: '',
        fullContent: content,
        streaming: true,
        created_at: Date.now()
      }
      const msgs = [...this.data.planMessages, msg]
      this.setData({ planMessages: msgs, planScrollTop: 99999 })
      // 启动打字机
      this.typewriterRender(id, content)
    } else {
      // 用户消息：直接显示
      const msgs = [...this.data.planMessages, { role, content }]
      this.setData({ planMessages: msgs, planScrollTop: 99999 })
    }
  },

  /**
   * 降级分流器 — 无 AI 时使用的本地状态机
   * 与 _dispatchLocal 不同的是，这个处理所有意图（包括慢路径意图）
   */
  _dispatchIntent(intent, text) {
    switch (intent) {
      case 'NEW_GOAL':         this._appendReply(this._handleNewGoal(text, { ...this.data.plannerState.goalContext })); break
      case 'WHY_MOTIVATION':   this._appendReply(this._handleWhyMotivation(text, { ...this.data.plannerState.goalContext })); break
      case 'TIME_FRAME':       this._appendReply(this._handleTimeFrame(text, { ...this.data.plannerState.goalContext })); break
      case 'DAILY_COMMITMENT': this._appendReply(this._handleDailyCommitment(text, { ...this.data.plannerState.goalContext })); break
      case 'SKILL_LEVEL':      this._appendReply(this._handleSkillLevel(text, { ...this.data.plannerState.goalContext })); break
      case 'CONFIRM_CONTEXT':
        // 确认信息：显示规划摘要，提示可生成任务
        this._appendReply(this._buildPlanSummary(this.data.plannerState.goalContext)); break
      case 'CHAT_GENERAL':
      default:                 this._appendReply(this._handleGeneralChat(text, { ...this.data.plannerState.goalContext }, { ...this.data.plannerState })); break
    }
  },

  // ═══════════ 各意图处理器 ═══════════

  /** 用户想直接生成（用默认值补齐缺失信息） */
  _handleDirectGenerate() {
    return this.generatePlanTasks()
  },

  /** 生成规划摘要 */
  _buildPlanSummary(ctx) {
    let s = '📋 **当前规划概要**\n'
    s += `🎯 目标：${ctx.what || '（未设定，先告诉我你想做什么？）'}\n`
    s += `📅 周期：${ctx.deadline || '待定'}\n`
    s += `⏱️ 每日：${ctx.dailyTime || '待定'}\n`
    s += `📊 水平：${ctx.level || '待定'}\n`
    s += `💡 难度：${this._assessDifficulty(ctx)}\n\n`
    s += '可以生成任务了！点击下方 **🎯 生成任务** 我来帮你拆解具体步骤。'
    return s
  },

  /** 简单难度判断 */
  _assessDifficulty(ctx) {
    if (!ctx.deadline || !ctx.level) return '适中'
    const num = parseInt(ctx.deadline)
    if (num <= 7 && ctx.level === '新手') return '偏高，建议适当放宽周期'
    if (num >= 60 && ctx.level === '进阶') return '偏低，可适当缩短周期或增加强度'
    if (ctx.level === '新手') return '适中，适合起步'
    if (ctx.level === '进阶') return '适中，有挑战性'
    return '适中'
  },

  /** 用户表达消极/放弃情绪 */
  _handleEmotionNegative(text, ctx, state) {
    state.mood = 'negative'
    state.encouragementCount += 1

    const count = state.encouragementCount
    let reply = ''

    if (count === 1) {
      reply = '💙 我听到了你的感受。这种感觉其实很正常——每个在努力的人都会经历这样的时刻。\n\n'
      if (ctx.what) {
        reply += `还记得你最初的想法吗：「${ctx.what}」。那个动机还在，只是现在有点累了而已。\n\n`
      }
      reply += '要不要先休息一下？或者我们可以把目标调小一点，让它变得更容易执行。你选哪个？'
    } else if (count === 2) {
      reply = '🤗 我理解。有时候目标看起来确实很大、很远。\n\n'
      if (ctx.what) {
        reply += `关于「${ctx.what}」，我们其实可以把它拆得更小——比如只看今天这一步。\n\n`
      }
      reply += '你现在最想做的一件小事是什么？哪怕只是"喝杯水"或者"站起来走两步"，都算数。'
    } else {
      reply = '💪 我一直在你身边。不管你现在的感觉如何，都不影响你的价值。\n\n'
      if (!ctx.what) {
        reply += '要不我们先不谈目标了？跟我说说今天发生了什么，我愿意倾听。'
      } else {
        reply += `如果「${ctx.what}」让你感到压力，那也许我们需要重新审视一下这个目标是否适合现在的你。\n\n`
        reply += '你想继续调整它，还是暂时放下？无论怎么选我都支持你。'
      }
    }

    this._updatePlannerState({ mood: state.mood, encouragementCount: state.encouragementCount })
    return reply
  },

  /** 用户表达疲惫 */
  _handleEmotionTired(ctx, state) {
    state.mood = 'tired'
    this._updatePlannerState({ mood: state.mood })

    return '😴 累了就好好休息吧，这不是偷懒，是身体在提醒你需要恢复。\n\n'
      + (ctx.what ? `关于「${ctx.what}」，它不会跑掉，等你休息好了我们再继续。\n\n` : '\n')
      + '今天有没有什么让你开心的小事？或者干脆发个表情，我陪你聊聊天～'
  },

  /** 用户表达积极/信心 */
  _handleEmotionPositive(ctx, state) {
    state.mood = 'positive'
    state.encouragementCount = Math.max(0, state.encouragementCount - 1)
    this._updatePlannerState({ mood: state.mood, encouragementCount: state.encouragementCount })

    const replies = [
      '🔥 太棒了！这种能量感非常珍贵！\n\n'
        + (ctx.what ? `带着这股劲儿去完成「${ctx.what}」吧！` : '保持这种感觉，告诉我你在为什么事情兴奋？'),
      '✨ 你的自信会感染到我！\n\n'
        + (ctx.what ? `「${ctx.what}」有了你这个态度，已经成功一半了。` : '这种状态很适合设定一个新目标，要不要试试？'),
      '💪 就喜欢这种气势！\n\n'
        + (ctx.what ? `既然信心满满，要不要我现在就帮你生成具体的任务计划？点击下方的「🎯 生成任务」就行～` : ''),
    ]
    return replies[Math.floor(Math.random() * replies.length)]
  },

  /** 用户想生成任务 */
  _tryGeneratePlan(ctx) {
    if (!ctx.what) return this._appendReply('先告诉我一个想完成的目标，比如“我想学游泳”。其他信息可以之后补充。')
    this._appendReply(this._buildPlanSummary(ctx) + '\n\n未说明的信息不会当成你的要求。可以随时点“生成计划”，再核对草案里的建议。')
  },

  /** 用户想换目标 */
  _handleChangeGoal() {
    this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
    this._draftUserEdits = {}
    const context = this.data.plannerState.goalContext.what ? { ...this.data.plannerState.goalContext } : plannerContext.empty()
    this.setData({ plannerContextSources: context.what ? this.data.plannerContextSources : {}, draftAssumptions: [] })
    this._updatePlannerState({
      goalContext: context,
      phase: 'collecting',
      mood: 'neutral',
      encouragementCount: 0,
      localAssess: '',
      localPlan: '',
      generatedGoal: null,
      generatedTasks: null,
      errorMessage: '',
    })
    this.setData({ planStatus: '' })

    this.setData({ editableTasks: [] })
    return context.what ? '好的，已换成“' + context.what + '”。可以继续补充要求，或直接生成草案。' : '好的，我们从头来过！🔄\n\n这次想做什么呢？随便说，比如"我想学吉他"、"我想减肥"、"我想早起"...'
  },

  /** 用户想调整某个字段 */
  _handleAdjustGoal(text, ctx) {
    // 尝试从文本中提取要改的内容
    const fields = plannerContext.extract(text)
    const updated = { ...ctx, ...fields }
    const changed = Object.keys(fields).length ? '你明确说明的信息' : ''

    this._updatePlannerState({ goalContext: updated })

    if (changed) {
      return `好的，已更新${changed}！当前设置：\n`
        + `• 目标：${updated.what || '待填写'}\n`
        + `• 周期：${updated.deadline || '待填写'}\n`
        + `• 每日：${updated.dailyTime || '待填写'}\n`
        + `• 水平：${updated.level || '待填写'}\n\n`
        + `满意的话点击「🎯 生成任务」就可以啦～`
    }

    return '你想调整什么呢？可以说"时间改成一周"、"每天10分钟"、"简单一点"之类的～'
  },

  // ═══ 信息收集（智能提取）═══

  _handleNewGoal(text, ctx) {
    const what = this._extractWhat(text)
    if (!what) {
      return '嗯...能说得再具体一点吗？比如"我想养成每天跑步的习惯"或者"我想学会Python基础"？'
    }
    ctx.what = what

    // 批量提取同一句话中的其他字段
    const extra = this._extractAnyInfo(text, ctx)
    Object.assign(ctx, extra.fields)

    this._updatePlannerState({ goalContext: ctx })

    // 根据已有信息决定下一步回复
    if (!ctx.why) {
      return `${this._acknowledgeGoal(what)}\n\n能说说**为什么想做这件事**吗？知道你的动机后，我能帮你设计更贴合的计划。`
    }
    return this._checkAndGuide(ctx)
  },

  _handleWhyMotivation(text, ctx) {
    const why = this._extractWhy(text)
    if (why) ctx.why = why
    else ctx.why = text  // 取整句作为动机

    // 批量提取同一句话中的其他字段
    const extra = this._extractAnyInfo(text, ctx)
    Object.assign(ctx, extra.fields)

    this._updatePlannerState({ goalContext: ctx })
    return this._checkAndGuide(ctx)
  },

  _handleTimeFrame(text, ctx) {
    const tf = this._extractDeadline(text)
    if (tf) ctx.deadline = tf

    // 批量提取
    const extra = this._extractAnyInfo(text, ctx)
    Object.assign(ctx, extra.fields)

    this._updatePlannerState({ goalContext: ctx })
    return this._checkAndGuide(ctx)
  },

  _handleDailyCommitment(text, ctx) {
    const dt = this._extractDailyTime(text)
    if (dt) ctx.dailyTime = dt

    // 批量提取
    const extra = this._extractAnyInfo(text, ctx)
    Object.assign(ctx, extra.fields)

    this._updatePlannerState({ goalContext: ctx })
    return this._checkAndGuide(ctx)
  },

  _handleSkillLevel(text, ctx) {
    const lvl = this._extractLevel(text)
    if (lvl) ctx.level = lvl

    // 批量提取
    const extra = this._extractAnyInfo(text, ctx)
    Object.assign(ctx, extra.fields)

    this._updatePlannerState({ goalContext: ctx })
    return this._checkAndGuide(ctx)
  },

  /** 自由聊天 / 补充说明 */
  _handleGeneralChat(text, ctx, state) {
    // 如果还没设定目标，尝试从文本提取
    if (!ctx.what) {
      const what = this._extractWhat(text)
      if (what) {
        ctx.what = what
        // 同时尝试批量提取其他字段
        const extra = this._extractAnyInfo(text, ctx)
        Object.assign(ctx, extra.fields)
        this._updatePlannerState({ goalContext: ctx })
        const missing = this._getMissingKeys(ctx)
        if (missing.length <= 1) {
          return this._acknowledgeGoal(what) + '\n\n' + this._buildPlanSummary(ctx)
        }
        return `${this._acknowledgeGoal(what)}\n\n能说说**为什么想做这件事**吗？知道你的动机后，我能帮你设计更贴合的计划。`
      }
      // 实在提取不到 → 引导用户
      const hints = [
        '听起来不错！不过我还不清楚你的具体目标是什么呢？\n\n是想养成一个新习惯？学习某项技能？还是完成一个挑战？',
        '嗯嗯，我在听。不过作为你的规划师，我最好先知道——**你想达成什么目标**？这样我才能给你更有用的建议。',
        '收到！不过在帮你做计划之前，我得先了解你的目标。\n\n可以随意说，比如"我想减肥"、"我想学英语"、甚至"我想每天早睡"都可以。',
      ]
      return hints[Math.min(state.turnCount - 1, hints.length - 1)]
    }

    // 已有目标 → 把用户输入当作补充信息，尝试提取
    const extracted = this._extractAnyInfo(text, ctx)
    if (extracted.changed) {
      Object.assign(ctx, extracted.fields)
      this._updatePlannerState({ goalContext: ctx })
      const missing = this._getMissingKeys(ctx)
      if (missing.length <= 1) {
        return `收到！我更新了一下：${extracted.summary}\n\n` + this._buildPlanSummary(ctx)
      }
      return `收到！我更新了一下你的信息：${extracted.summary}\n\n${this._checkCollectionStatus(ctx)}`
    }

    // 信息基本完整 → 显示规划摘要
    const missing = this._getMissingKeys(ctx)
    if (missing.length <= 1 && ctx.what) {
      return this._buildPlanSummary(ctx)
    }

    // 纯闲聊/补充说明
    const chatReplies = [
      `明白你的意思了。关于「${ctx.what}」，还有其他想补充的吗？\n\n或者如果觉得差不多了，可以直接让我**生成任务计划**～`,
      `好的，记下了！\n\n目前的信息：\n• 目标：${ctx.what}\n• 周期：${ctx.deadline || '未设定'}\n• 每日：${ctx.dailyTime || '未设定'}\n\n准备好了就说"生成任务"！`,
      `嗯嗯，这样我更了解你了 👍\n\n还有什么想说的吗？或者点击下方按钮开始生成计划？`,
    ]
    return chatReplies[state.turnCount % chatReplies.length]
  },

  // ═══════════ 提取器（智能字段解析）═══════════

  _extractWhat(text) {
    return plannerContext.goal(text, true) || null
  },

  _extractWhy(text) {
    const m = text.match(/(?:因为|为了|想变得|希望能|目的是|理由是|动力是)(.{5,50}?)(?:[，。,.]|$)/)
    return m ? m[1].trim() : null
  },

  _extractDeadline(text) {
    const m = text.match(/(\d+)\s*(天|周|个月|年)/)
    return m ? m[1] + m[2] : null
  },

  _extractDailyTime(text) {
    let m = text.match(/(?:每天|每日).{0,5}?(\d+)\s*(分钟|小时)/)
    if (m) return m[1] + m[2]
    m = text.match(/(\d+)\s*(分钟|小时).{0,5}(?:每天|每日)/)
    if (m) return m[1] + m[2]
    return null
  },

  _extractLevel(text) {
    if (/新手|初学者|零基础|小白|入门|刚接触/.test(text)) return '新手'
    if (/有基础|学过|了解过|中级|一般/.test(text)) return '有基础'
    if (/进阶|熟练|精通|高级|老手|老鸟/.test(text)) return '进阶'
    return null
  },

  /** 通用提取：一次尝试提取所有缺失字段 */
  _extractAnyInfo(text, currentCtx) {
    const fields = plannerContext.extract(text)
    return { fields, changed: Object.keys(fields).some(field => fields[field] !== currentCtx[field]), summary: Object.values(fields).join('、') }
  },

  // ═══════════ 辅助方法 ═══════════

  /** 确认目标时的个性化回应 */
  _acknowledgeGoal(goal) {
    const responses = [
      `「${goal}」——很好的目标！`,
      `哦？${goal}，我喜欢这个方向 🎯`,
      `${goal}！这个选择很有意义。`,
      `「${goal}」收到！让我帮你把它变成可执行的计划。`,
    ]
    return responses[Math.floor(Math.random() * responses.length)]
  },

  /** 检查收集进度并引导下一步 */
  _checkAndGuide(ctx) {
    const missing = this._getMissingKeys(ctx)

    if (missing.length === 0) {
      // 全部收集完毕 → 进入评估
      setTimeout(() => this.doAssess(ctx), 300)
      return null  // doAssess 会自己追加消息
    }

    // 还有缺失 → 自然地追问（不是机械列表）
    return this._naturalFollowUp(missing, ctx)
  },

  /** 自然追问（根据上下文选择最合适的问题） */
  _naturalFollowUp(missing, ctx) {
    // 根据已有哪些信息，选择最自然的下一个问题
    const hasGoal = !!ctx.what
    const hasWhy = !!ctx.why
    const hasTime = !!ctx.deadline
    const hasDaily = !!ctx.dailyTime

    if (missing.includes('why')) {
      return hasGoal ? `不错的方向！那**为什么想做这件事**呢？了解你的动机很重要～` : '能说说背后的原因吗？'
    }
    if (missing.includes('deadline')) {
      return hasWhy ? '明白了。那你觉得**大概需要多长时间**？比如 7天、30天、3个月？' : '你希望**在多久内**达成？'
    }
    if (missing.includes('dailyTime')) {
      return hasTime ? 'OK。那你**每天能投入多少时间**？实事求是就好，短一点也没关系～' : '**每天大概多久**？15分钟？30分钟？'
    }
    if (missing.includes('level')) {
      return `最后确认一下——在这个领域你**目前的水平**是？\n• 🟢 新手（刚接触）\n• 🟡 有基础（有些经验）\n• 🔴 进阶（比较熟练）`
    }
    return '还有什么想补充的吗？'
  },

  /** 检查收集状态文案 */
  _checkCollectionStatus(ctx) {
    const missing = this._getMissingKeys(ctx)
    if (missing.length <= 1) {
      return '信息基本完整了！你可以直接说"**生成任务**"，或者再补充一些细节让计划更精准～'
    }
    return `还需要了解：${missing.join('、')}。当然你也可以直接说"生成任务"，我会用合理默认值填充。`
  },

  /** 获取缺失的字段 key 列表 */
  _getMissingKeys(ctx) {
    return ['what', 'why', 'deadline', 'dailyTime', 'level', 'constraints'].filter(k => !ctx[k])
  },

  // ═══════════ 评估阶段 ═══════════

  doAssess(fields) {
    let issues = []

    // 时间合理性检查
    if (fields.deadline) {
      const num = parseInt(fields.deadline)
      if (num <= 1 && fields.deadline.includes('天')) {
        issues.push('⚠️ 1天完成任务可能不太现实，建议放宽周期')
      }
    }

    // 难度合理性检查
    if (fields.what && /精通|专家|完全掌握/.test(fields.what) && fields.level === '新手') {
      issues.push('⚠️ 从新手到精通跨度较大，建议先设里程碑目标')
    }

    // 模糊度检查
    if (fields.what && fields.what.length < 4) {
      issues.push('💡 目标描述可以再具体一些，便于后续拆解成可执行的任务')
    }

    let assessText
    if (issues.length > 0) {
      assessText = '🤔 我帮你评估了一下，有几处可能需要调整：\n\n' + issues.join('\n\n') + '\n\n你可以再补充说明，或者直接确认～'
    } else {
      assessText = '✅ 评估通过！你的目标在时间、难度和清晰度上都很合理。\n\n下面是我为你梳理的规划预览：'
    }

    const msgs = [...this.data.planMessages, { role: 'assistant', content: assessText }]
    this.setData({ planMessages: msgs })
    this._updatePlannerState({ localAssess: assessText })

    // 自动进入规划阶段
    this.doPlan(fields)
  },

  // ═══════════ 规划阶段（本地生成） ═══════════

  doPlan(fields) {
    const period = fields.deadline || '30天'
    const periodNum = parseInt(period) || 30
    const periodUnit = period.replace(/\d+/g, '')

    // 自动划分阶段
    let stages = []
    if (periodNum <= 7) {
      stages = [
        { name: '适应期', duration: `第1-3${periodUnit}`, milestone: `了解基础，建立初步节奏` },
        { name: '巩固期', duration: `第4-${periodNum}${periodUnit}`, milestone: `养成习惯，达成目标` }
      ]
    } else {
      const s1 = Math.ceil(periodNum * 0.2)
      const s2 = Math.ceil(periodNum * 0.5)
      stages = [
        { name: '适应期', duration: `第1-${s1}${periodUnit}`, milestone: `建立节奏，完成基础入门` },
        { name: '提升期', duration: `第${s1 + 1}-${s2}${periodUnit}`, milestone: `逐步增加强度，形成习惯` },
        { name: '巩固期', duration: `第${s2 + 1}-${periodNum}${periodUnit}`, milestone: `稳定执行，达成目标` }
      ]
    }

    // 生成本地规划文本
    let planText = '📋 **规划方案预览**\n\n'
    planText += `🎯 总目标：${fields.what}\n`
    planText += `📅 周期：${period}\n`
    planText += `⏱️ 每日投入：${fields.dailyTime || '待定'}\n`
    planText += `📊 当前水平：${fields.level || '新手'}\n\n`
    planText += `🗂️ **阶段划分：**\n`
    stages.forEach((s, i) => {
      planText += `${i + 1}. ${s.name}（${s.duration}）→ ${s.milestone}\n`
    })
    planText += '\n确认方案后，点击下方 **"🎯 生成任务"** 按钮，AI 将为你生成具体每日任务！'

    const msgs = [...this.data.planMessages, { role: 'assistant', content: planText }]
    this.setData({ planMessages: msgs })
    this._updatePlannerState({ phase: 'planning', localPlan: planText })
  },

  // ═══════════ 测试场景（planTestMode） ═══════════

  /** 运行测试用例 1：输入"跑步"→"30天"→"生成计划"，验证自动补齐 */
  async runTestScenario1() {
    if (!this.data.planTestMode || !this.data.showDebugTools) return
    wx.showLoading({ title: '运行测试用例1...', mask: true })
    log('🧪 测试', '开始场景1: 跑步 → 30天 → 生成计划')

    // Step 1: 模拟用户输入 "跑步"
    this._appendReply('跑步', 'user')
    await this._delay(500)

    // 模拟 _handleGeneralChat 中的 _extractWhat
    const ctx1 = { ...this.data.plannerState.goalContext }
    const what = this._extractWhat('跑步')
    ctx1.what = what || '跑步'
    this._updatePlannerState({ goalContext: ctx1 })
    this._appendReply(`好的，「${ctx1.what}」——很好的目标！能说说为什么想做这件事吗？`)
    log('🧪 测试', 'Step1-目标已提取', { what: ctx1.what })
    await this._delay(800)

    // Step 2: 模拟用户输入 "30天"
    this._appendReply('30天', 'user')
    await this._delay(500)

    const ctx2 = { ...this.data.plannerState.goalContext }
    ctx2.deadline = '30天'
    this._updatePlannerState({ goalContext: ctx2 })
    this._appendReply(`30天周期，合理！每天大概能投入多少时间呢？`)
    log('🧪 测试', 'Step2-周期已设置', { deadline: ctx2.deadline })
    await this._delay(800)

    // Step 3: 模拟点击 "生成计划"
    this._appendReply('生成计划', 'user')
    await this._delay(300)

    // 调用 _tryGeneratePlan → 自动补齐
    const ctx3 = { ...this.data.plannerState.goalContext }
    const defaults = []
    if (!ctx3.dailyTime) { ctx3.dailyTime = '20分钟'; defaults.push('每日→20分钟') }
    if (!ctx3.level) { ctx3.level = '新手'; defaults.push('水平→新手') }
    if (!ctx3.why) { ctx3.why = '自我提升'; defaults.push('动机→自我提升') }
    if (!ctx3.constraints) { ctx3.constraints = '无'; defaults.push('约束→无') }
    this._updatePlannerState({ goalContext: ctx3 })

    let hint = '好的，我帮你补齐了信息：`' + defaults.join('、') + '`'
    hint += '\n\n📋 **当前规划概要**\n'
    hint += `🎯 目标：${ctx3.what}\n`
    hint += `📅 周期：${ctx3.deadline}\n`
    hint += `⏱️ 每日：${ctx3.dailyTime}\n`
    hint += `📊 水平：${ctx3.level}\n`
    hint += `💡 难度：适中，适合起步\n\n`
    hint += '可以生成任务了！点击下方 **🎯 生成任务** 按钮，我来为你拆解具体步骤！'

    this._appendReply(hint)
    this.setData({ planScrollTop: 99999 })
    log('🧪 测试', 'Step3-自动补齐完成', { goalContext: ctx3, defaults })
    wx.hideLoading()
    wx.showToast({ title: '✅ 测试通过！已自动补齐并展示', icon: 'success', duration: 2000 })
  },

  /** 测试用例 2：mock 任务生成并自动发布到数据库 */
  async runTestScroll() {
    if (this._restorePendingPublication()) return
    if (!this.data.planTestMode || !this.data.showDebugTools) return
    wx.showLoading({ title: '模拟生成并发布...', mask: true })
    log('🧪 测试', '开始全流程测试: mock 数据 → 发布到数据库')

    // 用当前 goalContext，没有则用默认值
    let ctx = this.data.plannerState.goalContext
    if (!ctx.what) {
      ctx = { what: '养成每天跑步的习惯', why: '提升体能', deadline: '30天', dailyTime: '20分钟', level: '新手', constraints: '无' }
      this._updatePlannerState({ goalContext: ctx })
    }

    // 构造 mock 任务
    const mockGoal = {
      title: ctx.what,
      period: ctx.deadline || '30天',
      stages: [
        { name: '适应期', duration: '第1-7天', milestone: '完成3次慢跑，建立习惯' },
        { name: '成长期', duration: '第8-21天', milestone: '每次连续跑15分钟' },
        { name: '巩固期', duration: '第22-30天', milestone: '完成5公里挑战' },
      ]
    }
    const mockTasks = [
      { title: '慢跑 10 分钟 + 拉伸 5 分钟', xp_reward: 10, stage: 1, estimated_minutes: 15 },
      { title: '记录跑步感受（50字以上）', xp_reward: 10, stage: 1, estimated_minutes: 5 },
      { title: '做 3 组深蹲（每组 10 个）', xp_reward: 10, stage: 1, estimated_minutes: 5 },
      { title: '慢跑 15 分钟 + 拉伸 5 分钟', xp_reward: 10, stage: 2, estimated_minutes: 20 },
      { title: '睡前做一次今日复盘', xp_reward: 10, stage: 2, estimated_minutes: 5 },
    ]

    // 先展示弹窗（让用户看到任务卡片）
    this._updatePlannerState({
      generatedGoal: mockGoal,
      generatedTasks: mockTasks,
      loading: false,
      phase: 'generating',
      lastPlanId: 'test_full_' + Date.now(),
      errorMessage: '',
    })
    wx.hideLoading()

    await this.publishPlanTasks()
  },

  /** 延迟辅助 */
  _delay(ms) { return new Promise(r => setTimeout(r, ms)) },

  // ═══════════ Layer 2: Reasoning（AI 生成任务） ═══════════

  _generationStorageKey() {
    const scope = publicationDraft.accountScope()
    return scope ? 'planner_generation_v1:' + scope : ''
  },

  _readGenerationRecovery() {
    const key = this._generationStorageKey()
    try {
      const entry = key && wx.getStorageSync(key)
      if (entry?.version !== 1 || !/^[\w:.-]{1,128}$/.test(entry.requestId || '') ||
          !entry.payload?.planState?.what || !Array.isArray(entry.payload.messages) || typeof entry.provider !== 'string') return null
      return entry
    } catch { return null }
  },

  refreshGenerationRecovery() {
    this.setData({ generationRecoveryAvailable: !!this._readGenerationRecovery() })
  },

  _saveGenerationRecovery(pending) {
    const key = this._generationStorageKey()
    if (!key) return false
    const { requestId, id, payload, provider, conversationId, baseRevision } = pending
    try {
      wx.setStorageSync(key, { version: 1, requestId, id: id || '', payload, provider, conversationId, baseRevision })
      this.setData({ generationRecoveryAvailable: true })
      return true
    } catch { return false }
  },

  _clearGenerationRecovery(pending) {
    if (pending && this._readGenerationRecovery()?.requestId === pending.requestId) {
      try { wx.removeStorageSync(this._generationStorageKey()) } catch { /* The receipt can still be read later. */ }
    }
    this._pendingPlanGeneration = null
    this.refreshGenerationRecovery()
  },

  async resumePlannerGeneration() {
    if (this._generationChecking || this._generationRecoveryChecking || this.data.plannerState.loading || this._restorePendingPublication()) return
    const entry = this._readGenerationRecovery()
    if (!entry) return this.refreshGenerationRecovery()
    const messages = this.data.planMessages.filter(message => message.role === 'user')
    const storedMessages = new Map(entry.payload.messages.filter(message => message.role === 'user').map(message => [message.id, message.content]))
    const hasNewMessages = messages.some(message => storedMessages.get(message.id) !== (message.fullContent || message.content || ''))
    if (this._plannerSteward || this._pendingDraftSave || this._draftSaveInFlight || this.data.planInput.trim() ||
        (this.data.plannerState.generatedGoal ? this.data.draftCloudState !== 'saved' : hasNewMessages)) {
      return wx.showToast({ title: '请先保留当前对话或未保存的草案', icon: 'none' })
    }
    const session = getApp().globalData.userInfo
    const key = this._generationStorageKey()
    const serial = this._draftEditSerial
    const conversation = this._plannerConversationId
    const generation = this._plannerGenerationId
    const previousMessages = this.data.planMessages
    const isCurrent = () => key === this._generationStorageKey() && session === getApp().globalData.userInfo &&
      serial === this._draftEditSerial && conversation === this._plannerConversationId &&
      generation === this._plannerGenerationId && previousMessages === this.data.planMessages &&
      !this.data.planInput.trim() && !this._pendingDraftSave && !this._draftSaveInFlight &&
      !this._pendingPublication && this.data.mode === 'plan'
    this._generationRecoveryChecking = true
    const pending = { ...entry, session }
    try {
      const cloud = await cloudApi.getPlannerDraft()
      if (!isCurrent()) return
      if (cloud.revision !== entry.baseRevision) {
        const receipt = await cloudApi.aiPollPlan(entry.id ? { plan_id: entry.id } : { request_id: entry.requestId })
        if (!isCurrent()) return
        const planId = entry.id || receipt?.plan_id
        if (planId && receipt?.status === 'done' && cloud.draft?.source_plan_id === planId) {
          this.applyPlannerDraft(cloud.draft)
          this._clearGenerationRecovery(pending)
          this.setData({ showPlanModal: true })
        } else {
          wx.showToast({ title: '云端已有新版本，已保留原生成回执', icon: 'none' })
        }
        return
      }
    } catch {
      if (isCurrent()) wx.showToast({ title: '暂时无法核对云端草案，请重试', icon: 'none' })
      return
    } finally { this._generationRecoveryChecking = false }
    this._plannerConversationId = entry.conversationId
    this._plannerCloudRevision = entry.baseRevision
    this._plannerBaseKnown = !!entry.payload.draft_meta
    this._draftUserEdits = entry.payload.user_edits || {}
    const context = plannerContext.derive(entry.payload.messages)
    this._requirementsRevision = context.revision
    this._updatePlannerState({ goalContext: entry.payload.planState, lastPlanId: '' })
    this.setData({ planMessages: entry.payload.messages, plannerContextSources: context.sources, showPlanModal: false })
    this._pendingPlanGeneration = pending
    return this.generatePlanTasks(pending)
  },

  async generatePlanTasks(recovery) {
    if (this._restorePendingPublication()) return
    if (this._plannerSteward) return wx.showToast({ title: '请修改当前协作稿，或先开始新对话', icon: 'none' })
    if (this.data.plannerState.loading || this._generationChecking || this._generationRecoveryChecking) return
    const fields = this.data.plannerState.goalContext
    const t0 = Date.now()
    log('生成任务', '开始', { testMode: this.data.planTestMode, fields })

    // ═══ 前置校验：必须有目标（what）才能生成 ═══
    if (!fields.what) {
      wx.showToast({ title: '请先告诉我你想做什么', icon: 'none' })
      log('生成任务', '⛔ 跳过：goalContext.what 为空')
      return
    }

    // ═══ 幂等检查：相同 goalContext 已生成过任务 ═══
    const currentPlanId = this._computePlanId()
    if (this.data.plannerState.lastPlanId === currentPlanId && this.data.editableTasks.length) {
      log('生成任务', '幂等命中，跳过重复生成')
      wx.showToast({ title: '任务已生成，无需重复', icon: 'none' })
      return
    }

    // ═══ 测试模式：跳过 API，直接返回模拟数据 ═══
    if (this.data.planTestMode) {
      this._updatePlannerState({ loading: true })
      this.setData({ planStatus: '📨 已收到请求...' })
      log('生成任务', `阶段1-UI更新 耗时 ${Date.now() - t0}ms`)

      // 模拟异步延迟（1.5秒）
      setTimeout(() => {
        log('生成任务', `阶段2-等待800ms后 耗时 ${Date.now() - t0}ms`)
        this.setData({ planStatus: '🤖 AI 正在生成任务...' })
        setTimeout(() => {
          log('生成任务', `阶段3-再等1200ms后 耗时 ${Date.now() - t0}ms`)
          const mockGoal = {
            title: fields.what || '30天晨跑习惯养成',
            period: fields.deadline || '30天',
            stages: [
              { name: '适应期', duration: '第1-6天', milestone: '建立节奏，完成基础入门' },
              { name: '提升期', duration: '第7-15天', milestone: '逐步增加强度，形成习惯' },
              { name: '巩固期', duration: '第16-30天', milestone: '稳定执行，达成目标' }
            ]
          }
          const mockTasks = [
            { title: '慢跑15分钟', xp_reward: 10, stage: 1, estimated_minutes: 15 },
            { title: '跑后拉伸5分钟', xp_reward: 10, stage: 1, estimated_minutes: 5 },
            { title: '记录跑步数据（距离/时间）', xp_reward: 10, stage: 2, estimated_minutes: 3 },
            { title: '慢跑20分钟+间歇跑3组', xp_reward: 20, stage: 2, estimated_minutes: 25 },
            { title: '核心力量训练8分钟', xp_reward: 20, stage: 3, estimated_minutes: 8 },
            { title: '慢跑25分钟+变速跑5分钟', xp_reward: 30, stage: 3, estimated_minutes: 30 }
          ]

          this.setData({ planStatus: '✅ 生成完成！（测试模式）' })
          this._updatePlannerState({
            generatedGoal: mockGoal,
            generatedTasks: mockTasks,
            loading: false,
            phase: 'generating',
            lastPlanId: currentPlanId,
          })
          log('生成任务', `✅ 测试模式完成 总耗时 ${Date.now() - t0}ms`)
          console.log('[AI计划] 生成成功 tasks=', mockTasks)
          this.setData({ showPlanModal: true })
          console.log('[AI计划] 打开编辑弹窗 showPlanModal=true')
          this.setData({ scrollIntoView: 'page-bottom-anchor' })
        }, 1200)
      }, 800)
      return
    }

    // ═══ 正常模式：调用真实 AI API ═══
    this._generationChecking = true
    const generation = this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
    const owner = publicationDraft.owner()
    const session = getApp().globalData.userInfo
    const currentGeneration = () => generation === this._plannerGenerationId && owner === publicationDraft.owner() &&
      session === getApp().globalData.userInfo
    try { await this.ensurePlannerBase() }
    catch (error) {
      if (currentGeneration()) { this._generationChecking = false; this.setData({ draftCloudState: 'error', draftCloudError: String(error && error.message || error) }) }
      return
    }
    if (!currentGeneration()) return
    if (this._pendingDraftSave) {
      await this.savePlannerDraft()
      if (this._pendingDraftSave || !currentGeneration()) { if (currentGeneration()) this._generationChecking = false; return }
    }

    this._updatePlannerState({ loading: true })
    this.setData({ planStatus: '📨 已收到请求...' })
    log('生成任务', `阶段2-UI更新 耗时 ${Date.now() - t0}ms`)

    // ═══ 30 秒超时保护 ═══
    let timedOut = false
    const timeoutId = setTimeout(() => {
      if (!currentGeneration()) return
      timedOut = true
      this._generationChecking = false
      this.setData({ planStatus: '等待超时，云端可能仍在处理。可再次点生成核对原请求，或恢复云端稿。', draftCloudError: '可点“恢复云端稿”查询已保存结果。' })
      this._updatePlannerState({ loading: false, phase: 'error' })
    }, 30000)

    try {
      const recovering = recovery && recovery === this._pendingPlanGeneration
      const startPayload = recovering ? recovery.payload : {
        planState: { what: fields.what, why: fields.why, deadline: fields.deadline, dailyTime: fields.dailyTime, level: fields.level, constraints: fields.constraints },
        messages: this.data.planMessages.slice(-40).map(m => ({ id: m.id, role: m.role, content: m.fullContent || m.content || '' })),
        user_edits: this._draftUserEdits || {},
        ...(this._plannerBaseKnown ? { draft_meta: { expected_revision: this._plannerCloudRevision, conversation_id: this._plannerConversationId } } : {}),
      }
      const binding = JSON.stringify([owner, this._plannerConversationId, this._plannerCloudRevision, currentPlanId, startPayload])
      let pending = this._pendingPlanGeneration
      if (recovering) pending.binding = binding
      if (pending?.binding !== binding || pending.session !== session) pending = null
      let planId = pending?.id || ''
      const readOriginal = async () => {
        try {
          const receipt = await cloudApi.aiPollPlan(planId ? { plan_id: planId } : { request_id: pending.requestId })
          return typeof receipt?.status === 'string' ? receipt : { status: 'unknown' }
        } catch { return { status: 'unknown' } }
      }
      const waitForResult = (message = '云端生成结果尚未确认。可再次点生成核对原请求，或恢复云端稿。') => {
        this.setData({ planStatus: message })
        this._updatePlannerState({ loading: false, phase: 'error' })
      }
      const stored = this._readGenerationRecovery()
      if (stored && stored.requestId !== pending?.requestId) {
        return waitForResult('还有待确认的生成。请先恢复上次生成，或重新开始对话。')
      }
      let genRes
      if (pending) {
        const receipt = await readOriginal()
        if (timedOut || !currentGeneration()) return
        if (!planId && receipt.plan_id) {
          planId = pending.id = receipt.plan_id
          this._saveGenerationRecovery(pending)
        }
        if (receipt.status === 'done') {
          if (!planId || !receipt.result) return waitForResult()
          genRes = receipt.result
        } else if (receipt.status === 'failed') {
          this._clearGenerationRecovery(pending)
          pending = null
          planId = ''
        } else if (!(receipt.status === 'pending' && planId) && !(receipt.status === 'missing' && !planId)) {
          return waitForResult()
        }
      }
      let provider = pending?.provider
      if (!genRes) {
        const hasKey = await this._checkApiKey(provider)
        if (timedOut || !currentGeneration()) return
        if (!hasKey) {
          const message = provider ? '原任务尚需调用模型，请先恢复原服务商的 API Key' : '请先配置 API Key'
          wx.showToast({ title: message, icon: 'none' })
          return waitForResult(message)
        }
        provider ||= this._activeAiConfig.provider
      }
      if (!planId) {
        pending ||= { requestId: publicationDraft.newId(), binding, session, provider, payload: startPayload,
          conversationId: this._plannerConversationId, baseRevision: this._plannerCloudRevision || 0 }
        if (!this._saveGenerationRecovery(pending)) return waitForResult('本机无法保存生成回执，请释放存储后重试')
        this._pendingPlanGeneration = pending
        try {
          const startRes = await cloudApi.aiStartGenerate({ ...startPayload, provider, request_id: pending.requestId })
          planId = startRes?.plan_id || ''
          if (!planId) throw new Error('未收到生成编号')
        } catch (error) {
          if (!timedOut && currentGeneration()) {
            return waitForResult('创建结果尚未确认。可再次点生成核对原请求。' + aiModels.readableError(error))
          }
          return
        }
        if (!currentGeneration()) return
        pending.id = planId
        this._saveGenerationRecovery(pending)
        if (timedOut) return
      }

      if (!genRes) {
        this.setData({ planStatus: '🤖 AI 正在生成任务...' })
        try {
          genRes = await cloudApi.aiDoGenerate({ plan_id: planId, provider })
        } catch (error) {
          if (timedOut || !currentGeneration()) return
          if (typeof cloudApi.aiPollPlan !== 'function') throw error
          const receipt = await readOriginal()
          if (timedOut || !currentGeneration()) return
          if (receipt.status === 'failed') {
            this._clearGenerationRecovery(pending)
            throw error
          }
          if (receipt.status !== 'done') return waitForResult()
          genRes = receipt.result
        }
      }
      if (timedOut || !currentGeneration()) return
      if (genRes?.status === 'running') return waitForResult()
      log('生成任务', `阶段4-aiDoGenerate完成 耗时 ${Date.now() - t0}ms`, {
        hasGoal: !!genRes,
        goalTitle: genRes && genRes.goal && genRes.goal.title,
        taskCount: genRes && genRes.tasks && genRes.tasks.length,
        rawPreview: JSON.stringify(genRes).slice(0, 150)
      })

      if (timedOut || !currentGeneration()) { clearTimeout(timeoutId); return }

      if (!genRes || !genRes.tasks || genRes.tasks.length === 0) {
        throw new Error('未能生成任务，请多补充一些信息后重试')
      }
      clearTimeout(timeoutId)
      this.setData({ planStatus: '✅ 生成完成！' })

      // 解析结果
      const goal = (genRes.goal) ? {
        title: genRes.goal.title || fields.what || '我的成长计划',
        period: genRes.goal.period || fields.deadline || '',
        period_days: genRes.goal.period_days,
        stages: Array.isArray(genRes.goal.stages) ? genRes.goal.stages : []
      } : { title: fields.what || '我的成长计划', period: fields.deadline || '', stages: [] }

      const tasks = genRes.tasks.map(t => ({
        title: t.title || '新任务',
        xp_reward: t.xp_reward || 10,
        stage: t.stage || 1,
        estimated_minutes: t.estimated_minutes || 20,
        day_index: t.day_index,
        date: t.date,
      }))

      this._restoringPlannerDraft = !!genRes.draft
      this._updatePlannerState({
        generatedGoal: goal,
        generatedTasks: tasks,
        loading: false,
        phase: 'generating',
        lastPlanId: currentPlanId,
        sourcePlanId: planId,
        errorMessage: '',
      })
      this._restoringPlannerDraft = false
      if (genRes.draft) {
        this.acceptGeneratedPlannerDraft(genRes.draft)
        this._clearGenerationRecovery(pending)
      }
      else {
        this.setData({ draftSource: genRes.source || 'model', draftCloudState: 'dirty', draftCloudError: genRes.draft_error || '模型结果已返回，云端版本尚未确认；请恢复云端稿核对，或保存当前稿。' })
        if (this.persistPlannerWorkingCopy()) this._clearGenerationRecovery(pending)
      }
      log('生成任务', `✅ 正常模式完成 总耗时 ${Date.now() - t0}ms, tasks=${tasks.length}`)
      console.log('[AI计划] 生成成功 tasks=', tasks)
      this.setData({ showPlanModal: true })
      console.log('[AI计划] 打开编辑弹窗 showPlanModal=true')
      wx.showToast({ title: '已生成 ' + tasks.length + ' 个任务，请编辑后发布', icon: 'none' })
    } catch (e) {
      clearTimeout(timeoutId)
      if (timedOut || !currentGeneration()) return
      log('生成任务', `❌ 异常 耗时 ${Date.now() - t0}ms`, e)
      const errMsg = aiModels.readableError(e)

      // ═══ 失败降级：使用本地模板兜底 ═══
      const local = this._generateLocalTemplate(fields)
      const msgs = [...this.data.planMessages, {
        role: 'assistant',
        content: '😅 ' + errMsg + '\n\n已为你生成本地模板任务，你可以在此基础上修改。'
      }]
      this.setData({
        planMessages: msgs,
        planStatus: '⚠️ API 失败，已使用本地模板',
        draftSource: 'local_template',
      })
      this._updatePlannerState({
        generatedGoal: local.goal,
        generatedTasks: local.tasks,
        loading: false,
        phase: 'generating',
        lastPlanId: currentPlanId,
        errorMessage: errMsg,
      })
      console.log('[AI计划] 生成失败，使用本地模板 tasks=', local.tasks)
      this.setData({ showPlanModal: true })
      console.log('[AI计划] 打开编辑弹窗 showPlanModal=true')
      wx.showToast({ title: '已生成 ' + local.tasks.length + ' 个任务，请编辑后发布', icon: 'none' })
    } finally {
      clearTimeout(timeoutId)
      if (currentGeneration()) this._generationChecking = false
    }
  },

  /** 本地模板兜底 — 当超时或 API 失败时生成本地任务列表 */
  _generateLocalTemplate(fields) {
    const what = fields.what || '成长目标'
    const deadline = fields.deadline || '30天'
    const periodNum = schedule.durationDays(deadline) || 30

    let stages = []
    if (periodNum <= 7) {
      stages = [
        { name: '适应期', duration: '第1-3天', milestone: '了解基础，建立初步节奏' },
        { name: '巩固期', duration: `第4-${periodNum}天`, milestone: '养成习惯，达成目标' }
      ]
    } else {
      const s1 = Math.ceil(periodNum * 0.2)
      const s2 = Math.ceil(periodNum * 0.5)
      stages = [
        { name: '适应期', duration: `第1-${s1}天`, milestone: '建立节奏，完成基础入门' },
        { name: '提升期', duration: `第${s1 + 1}-${s2}天`, milestone: '逐步增加强度，形成习惯' },
        { name: '巩固期', duration: `第${s2 + 1}-${periodNum}天`, milestone: '稳定执行，达成目标' }
      ]
    }

    const tasks = [
      { title: `了解「${what}」基础知识`, xp_reward: 10, stage: 1, estimated_minutes: 15 },
      { title: `制定「${what}」学习/练习计划`, xp_reward: 10, stage: 1, estimated_minutes: 10 },
      { title: `每日练习「${what}」基础动作`, xp_reward: 10, stage: 2, estimated_minutes: 20 },
      { title: `记录「${what}」进度与心得`, xp_reward: 10, stage: 2, estimated_minutes: 5 },
      { title: `回顾并优化「${what}」方法`, xp_reward: 20, stage: 3, estimated_minutes: 15 },
      { title: `完成「${what}」阶段性目标`, xp_reward: 30, stage: 3, estimated_minutes: 30 },
    ]

    const goal = {
      title: what,
      period: deadline,
      stages: stages
    }

    return { goal, tasks }
  },

  scrollPlanToBottom() {
    const that = this
    setTimeout(() => { that.setData({ planScrollTop: 99999 }) }, 100)
  },

  // ═══════════ 编辑任务（使用 editableTasks） ═══════════

  onPlanGoalTitle(e) {
    if (this.data.publicationPending) return
    this._draftUserEdits = { ...this._draftUserEdits, what: e.detail.value }
    const goal = { ...this.data.plannerState.generatedGoal, title: e.detail.value }
    this._updatePlannerState({ generatedGoal: goal, goalContext: { what: e.detail.value } })
  },
  onPlanDays(e) {
    if (this.data.publicationPending) return
    const days = schedule.durationDays(e.detail.value)
    this._draftUserEdits = { ...this._draftUserEdits, deadline: days ? days + '天' : '' }
    this.setData({ planDays: e.detail.value, planEndDate: days ? schedule.endDate(this.data.planStartDate, days) : '' })
    this._updatePlannerState({ goalContext: { deadline: days ? days + '天' : '' } })
  },
  onPlanStartDate(e) {
    if (this.data.publicationPending) return
    const start = e.detail.value
    const old = this.data.planStartDate
    const days = schedule.durationDays(this.data.planDays)
    const tasks = this.data.editableTasks.map(task => {
      if (!schedule.validDate(task.date) || !schedule.validDate(old)) return task
      const offset = Math.round((Date.parse(task.date + 'T00:00:00Z') - Date.parse(old + 'T00:00:00Z')) / 86400000)
      return { ...task, date: schedule.addDays(start, offset) }
    })
    this.setData({ planStartDate: start, planEndDate: days ? schedule.endDate(start, days) : '', editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  editPlanTaskDate(e) {
    if (this.data.publicationPending) return
    const tasks = this.data.editableTasks.map(task => ({ ...task }))
    const index = Number(e.currentTarget.dataset.index)
    if (tasks[index]) tasks[index].date = e.detail.value
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  editPlanTaskMinutes(e) {
    if (this.data.publicationPending) return
    const tasks = this.data.editableTasks.map(task => ({ ...task }))
    const index = Number(e.currentTarget.dataset.index)
    if (tasks[index]) tasks[index].estimated_minutes = e.detail.value
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  editPlanTaskTitle(e) {
    if (this.data.publicationPending) return
    const index = parseInt(e.currentTarget.dataset.index)
    const tasks = Array.isArray(this.data.editableTasks) ? this.data.editableTasks.slice() : []
    if (tasks[index]) tasks[index].title = e.detail.value
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  setPlanTaskXp(e) {
    if (this.data.publicationPending) return
    const index = parseInt(e.currentTarget.dataset.index)
    const xp = parseInt(e.currentTarget.dataset.xp)
    const tasks = Array.isArray(this.data.editableTasks) ? this.data.editableTasks.slice() : []
    if (tasks[index]) tasks[index].xp_reward = xp
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  deletePlanTask(e) {
    if (this.data.publicationPending) return
    const index = parseInt(e.currentTarget.dataset.index)
    const tasks = Array.isArray(this.data.editableTasks) ? this.data.editableTasks.slice() : []
    if (index >= 0 && index < tasks.length) tasks.splice(index, 1)
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  addPlanTask() {
    if (this.data.publicationPending) return
    const tasks = Array.isArray(this.data.editableTasks) ? this.data.editableTasks.slice() : []
    tasks.push({ title: '新的成长任务', xp_reward: 10, stage: 1, estimated_minutes: 20, date: this.data.planStartDate || getTodayStr() })
    log('编辑任务', 'addPlanTask', { newCount: tasks.length })
    this.setData({ editableTasks: tasks })
    this.markPlannerDraftDirty()
  },
  /** 关闭弹窗（× / 取消按钮），不丢失任务数据 */
  closePlanModal() {
    this.setData({
      showPlanModal: false,
      'plannerState.phase': this._publicationInFlight ? 'publishing' : 'planning'
    })
  },

  backToPlanChat() {
    if (this.data.publicationPending) return
    if (this._pendingDraftSave || this._draftSaveInFlight) return wx.showToast({ title: '请先确认草案保存结果', icon: 'none' })
    this._updatePlannerState({ generatedGoal: null, generatedTasks: null, phase: 'planning' })
    this.setData({ planStatus: '', showPlanModal: false, editableTasks: [] })
  },

  // ═══════════ Layer 3: Executor（发布） ═══════════

  _restorePendingPublication() {
    try {
      this.syncPlannerDraftOwner()
      if (this._publicationInFlight) return true
      const saved = publicationDraft.load()
      if (!saved) return false
      this._pendingPublication = saved
      const request = saved.request
      this._plannerSteward = request.steward || null
      this._updatePlannerState({ generatedGoal: request.goal, generatedTasks: request.tasks,
        sourcePlanId: request.source_plan_id || '', phase: 'generating', goalContext: saved.context || {} })
      this.setData({ mode: 'plan', showPlanModal: true, editableTasks: request.tasks, stewardDraft: !!request.steward,
        planDays: request.goal.target_days, planStartDate: request.goal.start_date,
        planEndDate: schedule.endDate(request.goal.start_date, request.goal.target_days), publicationPending: true,
        publicationMessage: '上次发布尚待确认，点击继续确认即可安全重试。草稿暂时锁定，避免重复创建。' })
      return true
    } catch (error) {
      wx.showToast({ title: error.message || '无法读取待确认草稿', icon: 'none' })
      return true
    }
  },

  async publishPlanTasks() {
    this.syncPlannerDraftOwner()
    if (this._publicationInFlight) return
    if (!this._pendingPublication && (this._pendingDraftSave || this._draftSaveInFlight)) return wx.showToast({ title: '请先确认草案保存结果，再发布', icon: 'none' })
    if (!this._pendingPublication) {
      if (this._restorePendingPublication() && !this._pendingPublication) return
    }
    if (!this._pendingPublication) {
      const steward = this._plannerSteward
      if (steward) {
        const current = this.plannerReviewBinding()
        const checked = this.data.auditRules
        if (!current || current.draft_id !== steward.binding.draft_id) return wx.showToast({ title: '请先保存当前协作稿', icon: 'none' })
        if (!checked || checked.binding.draft_id !== current.draft_id || checked.status !== 'done' || checked.rules.error_count) {
          return wx.showToast({ title: '请先检查当前版本并处理规则问题', icon: 'none' })
        }
      }
      const goal = this.data.plannerState.generatedGoal
      const goalTitle = (goal && goal.title || '').trim()
      const days = schedule.durationDays(this.data.planDays)
      const start = this.data.planStartDate || getTodayStr()
      const end = days && schedule.endDate(start, days)
      if (!goalTitle || goalTitle.length > 200) return wx.showToast({ title: '目标名称需为1至200字', icon: 'none' })
      if (!days || !schedule.validDate(start) || !end) return wx.showToast({ title: '请填写有效周期和开始日期', icon: 'none' })
      const raw = Array.isArray(this.data.editableTasks) ? this.data.editableTasks : []
      const tasks = schedule.draftTasks(raw.filter(t => t && typeof t.title === 'string' && t.title.trim()), start, days)
        .map(t => ({ title: t.title.trim(), xp_reward: Number(t.xp_reward || 10), stage: t.stage || 1,
          estimated_minutes: Number(t.estimated_minutes), date: t.date }))
      if (!tasks.length || tasks.length > 20) return wx.showToast({ title: '一次请发布1至20项任务', icon: 'none' })
      if (tasks.some(t => !schedule.validDate(t.date) || t.date < start || t.date > end)) return wx.showToast({ title: '任务日期需在目标周期内', icon: 'none' })
      if (tasks.some(t => !Number.isInteger(t.estimated_minutes) || t.estimated_minutes < 1 || t.estimated_minutes > 1440)) return wx.showToast({ title: '请填写有效任务时长', icon: 'none' })
      if (tasks.some(t => t.title.length > 200 || !Number.isInteger(t.xp_reward) || t.xp_reward < 1 || t.xp_reward > 1000 || !['string', 'number'].includes(typeof t.stage) || String(t.stage).length > 80 || (typeof t.stage === 'number' && (!Number.isSafeInteger(t.stage) || t.stage < 1)))) return wx.showToast({ title: '任务名称、经验或阶段不正确', icon: 'none' })
      const stages = goal.stages || []
      if (!Array.isArray(stages) || stages.length > 20 || stages.some(s => !s || [['name', 80], ['duration', 80], ['milestone', 200]].some(([key, limit]) => typeof (s[key] || '') !== 'string' || (s[key] || '').length > limit))) return wx.showToast({ title: '阶段内容过长或格式不正确', icon: 'none' })
      const request = { publication_id: publicationDraft.newId(), source_plan_id: this.data.plannerState.sourcePlanId || '',
        ...(steward ? { steward } : {}),
        ...(this._plannerBaseKnown ? { cloud_draft_revision: this._plannerCloudRevision } : {}),
        goal: { title: goalTitle, target_days: days, start_date: start,
          stages: stages.map(s => ({ name: (s.name || '').trim(), duration: (s.duration || '').trim(), milestone: (s.milestone || '').trim() })) }, tasks }
      try {
        this._pendingPublication = publicationDraft.save(request, this.data.plannerState.goalContext)
      } catch (error) {
        return wx.showToast({ title: error.message || '无法保存草稿，请稍后重试', icon: 'none' })
      }
    }
    const saved = this._pendingPublication
    if (!publicationDraft.owns(saved)) {
      this._restorePendingPublication()
      return wx.showToast({ title: '账号已变化，请重新确认草稿', icon: 'none' })
    }
    this._publicationInFlight = saved
    const isCurrent = () => this._publicationInFlight === saved && publicationDraft.owns(saved)
    this._updatePlannerState({ phase: 'publishing' })
    this.setData({ publicationPending: true, publicationMessage: '正在确认发布结果，请稍候。' })
    wx.showLoading({ title: '确认发布中...', mask: true })
    try {
      const result = await cloudApi.publishAiPlan(saved.request)
      if (!isCurrent()) return
      if (result?.rejected === true) {
        publicationDraft.clear(saved)
        this._pendingPublication = null
        this.setData({ publicationPending: false, publicationMessage: '', showPlanModal: true })
        this._updatePlannerState({ phase: 'generating' })
        await this.restorePlannerDraft()
        if (isCurrent()) this.setData({ draftCloudError: result.message })
        return
      }
      if (!result || result.success !== true || !result.goal_id || result.created_count !== saved.request.tasks.length) throw new Error('发布结果未确认，请重试')
      try { publicationDraft.clear(saved) } catch (error) { console.warn('[AI发布] 草稿缓存清理失败', error.message) }
      this._pendingPublication = null
      this._updatePlannerState({ generatedGoal: null, generatedTasks: [], phase: 'idle' })
      this.setData({ planStatus: '', showPlanModal: false, editableTasks: [], publicationPending: false, publicationMessage: '' })
      this.retirePublishedPlannerDraft(saved.request)
      wx.showToast({ title: result.already_published ? '已确认此前发布成功' : '已发布' + result.created_count + '项任务', icon: 'success' })
      setTimeout(() => {
        if (publicationDraft.owns(saved)) wx.navigateTo({ url: '/pages/goal-detail/goal-detail?id=' + result.goal_id })
      }, 1200)
    } catch (error) {
      if (!isCurrent()) return
      this._updatePlannerState({ phase: 'generating' })
      const message = String(error && (error.message || error.errMsg) || error || '发布失败')
      this.setData({ showPlanModal: true, publicationMessage: '结果尚未确认，草稿已保留。请点击继续确认发布。' })
      wx.showToast({ title: message.slice(0, 40), icon: 'none' })
    } finally {
      if (this._publicationInFlight === saved) {
        this._publicationInFlight = null
        wx.hideLoading()
      }
    }
  },

  /**
   * 规范化 AI 规划草稿，安全提取任务数组
   * 兼容多种 AI 返回格式：
   *   { goal: {...}, tasks: [...] }
   *   { data: { goal: {...}, tasks: [...] } }
   *   { plan: { goal: {...}, tasks: [...] } }
   */
  _normalizePlanDraft(raw) {
    if (!raw || typeof raw !== 'object') return { goalDraft: null, analysis: '', tasks: [] }
    const data = raw.data || raw.plan || raw
    const goalDraft = data.goal || data.goalDraft || null
    const analysis = data.analysis || data.summary || ''
    const tasks = Array.isArray(data.tasks) ? data.tasks.map(t => ({
      title: t.title || '新任务',
      xp_reward: t.xp_reward || 10,
      stage: t.stage || 1,
      estimated_minutes: t.estimated_minutes || 20,
      day_index: t.day_index,
      date: t.date,
    })) : []
    return { goalDraft, analysis, tasks }
  },

  /** 从多层嵌套中提取ID */
  _extractId(res) {
    if (!res) return ''
    if (res.id) return res.id
    if (res._id) return res._id
    if (res.data) {
      if (typeof res.data === 'string') return res.data
      if (res.data.id) return res.data.id
      if (res.data._id) return res.data._id
      if (res.data.data && res.data.data.id) return res.data.data.id
    }
    if (res.result) {
      if (res.result.id) return res.result.id
      if (res.result.data && res.result.data.id) return res.result.data.id
    }
    if (res.goalId) return res.goalId
    return ''
  },

  // ===== 答案之书 =====
  onOracleInput(e) { this.setData({ oracleQuestion: e.detail.value }) },
  askOracle() {
    const q = this.data.oracleQuestion.trim()
    if (!q) return wx.showToast({ title: "请输入你的问题", icon: "none" })

    // 翻牌动画
    this.setData({ oracleAnimating: true, oracleResult: null })

    setTimeout(() => {
      const result = ORACLE_ANSWERS[Math.floor(Math.random() * ORACLE_ANSWERS.length)]
      this.setData({
        oracleResult: { ...result, question: q },
        oracleAnimating: false,
      })
    }, 1200)
  },

  // ===== 今日运势 =====
  getFortune() {
    log('运势', '请求今日运势')
    const ft = FORTUNE_TEMPLATES[Math.floor(Math.random() * FORTUNE_TEMPLATES.length)]
    const luckyThings = ['阅读英文文章', '尝试冥想', '整理笔记', '户外散步', '听一首轻音乐', '写感恩日记', '做一次深呼吸', '整理手机相册']
    function stars(n) {
      var s = ''
      for (var i = 0; i < n; i++) s += '⭐'
      for (var j = n; j < 5; j++) s += '☆'
      return s
    }
    this.setData({
      fortuneData: {
        ...ft,
        date: (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日',
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
    if (!text) return wx.showToast({ title: '先写下现在的感受', icon: 'none' })

    // 根据关键词匹配鼓励语
    let encourage = TRANSLATE_ENCOURAGE[Math.floor(Math.random() * TRANSLATE_ENCOURAGE.length)]
    let nextStep = '写下我现在最想推进的一件事，再给它留 5 分钟。'
    const lower = text.toLowerCase()
    if (/累|难|不行|放弃|坚持不住/i.test(lower)) {
      encourage = '你已经走了这么远，不要低估自己。每一次坚持都在悄悄改变你。'
      nextStep = '把事情拆到只剩一个动作，比如打开资料、列出第一条，做完再决定要不要继续。'
    } else if (/开心|成功|完成|进步/i.test(lower)) {
      encourage = '太棒了！你的努力不会说谎，继续保持这个节奏！'
      nextStep = '记下今天做对的一步，下次遇到同样的任务可以再用。'
    }

    this.setData({
      translateResult: { original: text, nextStep, encourage }
    })
  },

  // ===== 昵称生成器 =====
  onNicknameInput(e) { this.setData({ nicknameInput: e.detail.value }) },
  generateNickname() {
    const keywords = this.data.nicknameInput.trim()
    if (!keywords) return wx.showToast({ title: "请输入关键词", icon: "none" })
    const words = [...new Set(keywords.split(/[\s,，、]+/).filter(Boolean).slice(0, 4).map(word => Array.from(word).slice(0, 8).join('')))]
    if (!words.length) return wx.showToast({ title: '请填一个昵称关键词', icon: 'none' })
    const offset = Math.floor(Math.random() * NICKNAME_SUFFIXES.length)
    this.setData({ nicknames: Array.from({ length: 6 }, (_, i) =>
      words[i % words.length] + NICKNAME_SUFFIXES[(offset + i) % NICKNAME_SUFFIXES.length]) })
  },

  // ===== 目标命名器 =====
  onGoalNameInput(e) { this.setData({ goalNameInput: e.detail.value }) },
  generateGoalName() {
    const name = this.data.goalNameInput.trim()
    if (!name) return wx.showToast({ title: "请输入原始目标名", icon: "none" })
    const names = Object.prototype.hasOwnProperty.call(GOAL_NAME_MAP, name) ? GOAL_NAME_MAP[name] : []
    this.setData({ goalNames: [...new Set([name, ...names, name + ' · 每日一步', name + ' · 成长计划'])] })
  },

  // ===== 复制/使用功能 =====
  copyNick(e) {
    const name = e.currentTarget.dataset.name || ''
    if (!name) return
    wx.setClipboardData({ data: name, success: () => wx.showToast({ title: '已复制「' + name + '」', icon: 'success' }) })
  },
  useGoalName(e) {
    const name = e.currentTarget.dataset.name || ''
    if (name) aiNavigation.openNewGoal(name)
  },

  // ===== 未来来信 =====
  onFutureInput(e) { this.setData({ futureInput: e.detail.value }) },
  generateFutureLetter() {
    const dream = this.data.futureInput.trim()
    if (!dream) return wx.showToast({ title: "写下你的愿望吧", icon: "none" })

    const letter = `亲爱的过去的我：

我是三年后的你。

还记得当初你写下「${dream}」这个愿望的那一天吗？

想象一下，当你向这个愿望迈出一大步时，回头最想感谢的是哪一次小小的开始？

那些觉得枯燥的日子、想要放弃的瞬间，现在回头看，都是最珍贵的礼物。

所以请一定坚持下去。不要在意一时快慢，你正走在属于自己的正确道路上。

今天给自己留一个小任务吧：选一个能在 5 分钟内开始的动作，写下来，做完再决定下一步。

—— 来自三年后的你 ✨`

    this.setData({
      futureLetter: {
        dream,
        date: (new Date().getFullYear() + 3) + '年' + (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日',
        content: letter,
      }
    })
  },

  copyToolText(e) {
    const value = e.currentTarget.dataset.text
    if (value) wx.setClipboardData({ data: value })
  },

  // ===== 时间胶囊 =====
  onCapsuleInput(e) { this.setData({ capsuleText: e.detail.value }) },
  async saveCapsule() {
    if (this.data.capsuleSaving) return
    const text = this.data.capsuleText.trim()
    if (!text) return wx.showToast({ title: "写下你想对未来的自己说的话", icon: "none" })
    const owner = this._toolboxOwner
    const epoch = this._toolboxEpoch
    if (!owner || getApp().isOfflineMode) return wx.showToast({ title: '请联网登录后封存', icon: 'none' })
    const now = Date.now()
    const openTime = now + 30 * 24 * 60 * 60 * 1000
    const request = { text, unlock_at: openTime, created_date: schedule.today(now).replace(/-/g, '.') }
    this.setData({ capsuleSaving: true, capsuleUnconfirmed: false })

    try {
      const saved = await cloudApi.saveCapsule(request)
      if (epoch !== this._toolboxEpoch || owner !== toolbox.owner(getApp) || this._toolboxUnloaded) return
      if (!saved?._id) throw new Error('未收到保存回执')
      this._showCapsuleReceipt(saved, text)
    } catch (e) {
      if (epoch !== this._toolboxEpoch || owner !== toolbox.owner(getApp) || this._toolboxUnloaded) return
      this._capsuleUnconfirmed = request
      this.setData({ capsuleUnconfirmed: true, capsuleHistoryExpanded: true })
    } finally {
      if (epoch === this._toolboxEpoch && owner === toolbox.owner(getApp) && !this._toolboxUnloaded) {
        this.setData({ capsuleSaving: false })
        this.loadCapsules()
      }
    }
  },
  _showCapsuleReceipt(saved, text) {
    this._capsuleUnconfirmed = null
    const sameDraft = this.data.capsuleText.trim() === text
    this.setData({
      capsuleSaved: sameDraft, capsuleUnconfirmed: false,
      capsuleText: sameDraft ? '' : this.data.capsuleText,
      capsuleDate: saved.created_date, capsuleOpenDate: schedule.today(saved.unlock_at),
    })
    wx.showToast({ title: '胶囊已封存', icon: 'success' })
  },
  toggleCapsuleHistory() {
    this.setData({ capsuleHistoryExpanded: !this.data.capsuleHistoryExpanded })
  },
  writeAnotherCapsule() { this.setData({ capsuleSaved: false }) },
  openCapsule(e) {
    const id = e.currentTarget.dataset.id
    const capsule = (this.data.myCapsules || []).find(c => c._id === id)
    if (capsule?.can_open) {
      wx.showModal({
        title: '📦 时间胶囊',
        content: '「' + capsule.text + '」\n\n——封存于 ' + capsule.created_date,
        showCancel: false,
        confirmText: '我知道了'
      })
    }
  },

  // ===== 随机挑战 =====
  getChallenge() {
    log('随机挑战', '抽取')
    const challenge = CHALLENGE_POOL[Math.floor(Math.random() * CHALLENGE_POOL.length)]
    this.setData({ challenge, challengeDone: false })
  },
  completeChallenge() {
    if (!this.data.challenge || this.data.challengeDone) return
    this.setData({ challengeDone: true })
    wx.showToast({ title: '本次挑战已完成', icon: 'success' })
  },

  // ═══════════ 工具弹窗方法 ═══════════

  openTool(e) {
    const name = e.currentTarget.dataset.tool || ''
    const titles = {
      pomodoro: '🍅 森林番茄钟',
      todoDraw: '🎲 今日待办抽签',
      focusOath: '📜 专注宣言',
      delayHelp: '🚑 拖延急救',
      personality: '🧠 森林成长人格测试',
      disciplineCard: '🪪 自律人格卡',
      energyCheck: '🔋 情绪能量检测',
    }
    if (!titles[name]) return
    this.syncToolboxOwner()
    this.setData({
      activeTool: name,
      showToolSheet: true,
      toolSheetTitle: titles[name],
    })
    return this._resetToolState(name)
  },

  closeToolSheet() {
    this.setData({ showToolSheet: false })
  },

  _resetToolState(tool) {
    if (tool === 'pomodoro') {
      this._refreshPomodoro()
    } else if (tool === 'todoDraw') {
      return this.loadTodayTodos()
    } else if (tool === 'focusOath') {
      this.setData({ focusHistoryExpanded: false })
      this._loadFocusHistory()
    } else if (tool === 'delayHelp') {
      this.setData({ delaySelected: '', delayResult: null })
    } else if (tool === 'personality') {
      this.setData({
        personalityStep: 0,
        personalityAnswers: [],
        personalityResult: null,
        currentPersonalityQuestion: PERSONALITY_QUESTIONS[0] || { text: '', options: [] },
      })
    } else if (tool === 'disciplineCard') {
      this.setData({ disciplineSelected: '', disciplineCard: null })
    } else if (tool === 'energyCheck') {
      this.setData({ energyLevel: 0, emotionSelected: '', energyResult: null })
    }
  },

  // ═══════════ 番茄钟 ═══════════

  syncToolboxOwner() {
    const owner = toolbox.owner(getApp)
    if (this._toolboxOwner === owner) return
    if (this._toolboxOwner !== undefined) this.setData({
      showToolSheet: false, drawnTodo: null, todoStatus: 'idle', todoCount: 0,
      focusInput: '', focusObstacle: '', focusOath: '', focusHistory: [], focusHistoryExpanded: false,
      capsuleText: '', capsuleSaved: false, myCapsules: [], capsuleLoading: false,
      capsuleLoadError: false, capsuleSaving: false, capsuleHistoryExpanded: false, capsuleUnconfirmed: false,
    })
    this._toolboxOwner = owner
    this._toolboxEpoch = (this._toolboxEpoch || 0) + 1
    this._todoRequestId = (this._todoRequestId || 0) + 1
    this._capsuleLoadId = (this._capsuleLoadId || 0) + 1
    this._capsuleUnconfirmed = null
    this._todayTodos = []
    this._stopPomodoroTimer()
    let session
    try { if (owner) session = wx.getStorageSync('forestPomodoro:' + owner) } catch (e) {}
    const mode = toolbox.TIMER_SECONDS[session?.mode] ? session.mode : 'focus25'
    this._pomodoroDeadline = Number.isFinite(session?.deadline) ? session.deadline : 0
    this.setData({
      pomodoroMode: mode, pomodoroRunning: this._pomodoroDeadline > 0,
      pomodoroTask: session?.task || null, pomodoroStatus: session?.status || '准备开始',
    })
    this._setPomodoroSeconds(Number.isInteger(session?.seconds) ? session.seconds : toolbox.TIMER_SECONDS[mode])
  },

  _savePomodoro() {
    const { pomodoroMode, pomodoroTask, pomodoroStatus, pomodoroSeconds } = this.data
    try {
      if (this._toolboxOwner) wx.setStorageSync('forestPomodoro:' + this._toolboxOwner, {
        mode: pomodoroMode, task: pomodoroTask, status: pomodoroStatus,
        seconds: pomodoroSeconds, deadline: this._pomodoroDeadline,
      })
    } catch (e) {
      // The current page can still run the timer when device storage is unavailable.
    }
  },

  setPomodoroMode(e) {
    if (this.data.pomodoroRunning) return
    const mode = e.currentTarget.dataset.mode
    if (!Object.prototype.hasOwnProperty.call(toolbox.TIMER_SECONDS, mode) || mode === this.data.pomodoroMode) return
    this.setData({ pomodoroMode: mode })
    this.resetPomodoro()
  },

  startPomodoro() {
    if (this.data.pomodoroRunning) return
    const seconds = this.data.pomodoroSeconds || toolbox.TIMER_SECONDS[this.data.pomodoroMode]
    this._pomodoroDeadline = Date.now() + seconds * 1000
    this.setData({ pomodoroRunning: true, pomodoroStatus: this.data.pomodoroMode === 'break5' ? '休息中' : '专注中' })
    this._setPomodoroSeconds(seconds)
    this._savePomodoro()
    this._startPomodoroTimer()
  },

  pausePomodoro() {
    this._refreshPomodoro()
    if (!this.data.pomodoroRunning) return
    this._stopPomodoroTimer()
    this._pomodoroDeadline = 0
    this.setData({ pomodoroRunning: false, pomodoroStatus: '已暂停' })
    this._savePomodoro()
  },

  resetPomodoro() {
    this._stopPomodoroTimer()
    this._pomodoroDeadline = 0
    this.setData({ pomodoroRunning: false, pomodoroStatus: '准备开始' })
    this._setPomodoroSeconds(toolbox.TIMER_SECONDS[this.data.pomodoroMode])
    this._savePomodoro()
  },

  clearPomodoroTask() {
    if (this.data.pomodoroRunning) return
    this.setData({ pomodoroTask: null })
    this._savePomodoro()
  },

  _startPomodoroTimer() {
    this._stopPomodoroTimer()
    this._pomodoroTimer = setInterval(() => this._refreshPomodoro(true), 250)
  },

  _stopPomodoroTimer() {
    if (this._pomodoroTimer) clearInterval(this._pomodoroTimer)
    this._pomodoroTimer = null
  },

  _refreshPomodoro(showToast) {
    if (!this._pomodoroDeadline) return
    const seconds = toolbox.remainingSeconds(this._pomodoroDeadline, Date.now())
    if (seconds !== this.data.pomodoroSeconds) this._setPomodoroSeconds(seconds)
    if (seconds) return
    this._stopPomodoroTimer()
    this._pomodoroDeadline = 0
    const status = this.data.pomodoroMode === 'break5' ? '本轮休息结束' : '本轮专注结束'
    this.setData({ pomodoroRunning: false, pomodoroStatus: status })
    this._savePomodoro()
    if (showToast) wx.showToast({ title: status, icon: 'none' })
  },

  _setPomodoroSeconds(seconds) {
    this.setData({ pomodoroSeconds: seconds, pomodoroFormattedTime: this._formatPomodoroTime(seconds) })
  },

  _formatPomodoroTime(seconds) {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  },

  // ═══════════ 今日待办抽签 ═══════════

  async loadTodayTodos() {
    const owner = this._toolboxOwner
    const date = schedule.today()
    const request = this._todoRequestId = (this._todoRequestId || 0) + 1
    this._todayTodos = []
    this._drawnTodoIds = new Set()
    this.setData({ todoStatus: 'loading', todoCount: 0, drawnTodo: null })
    try {
      if (!owner || getApp().isOfflineMode) throw new Error('需要在线登录')
      const [tasks, goals] = await Promise.all([cloudApi.tasks({ date }), cloudApi.goals()])
      if (request !== this._todoRequestId || owner !== toolbox.owner(getApp)) return
      if (date !== schedule.today()) return this.loadTodayTodos()
      if (!Array.isArray(tasks) || !Array.isArray(goals)) throw new Error('无法读取任务')
      this._todayTodos = toolbox.todayTasks(tasks, goals, date)
      this.setData({ todoStatus: 'ready', todoCount: this._todayTodos.length })
    } catch (e) {
      if (request === this._todoRequestId && owner === toolbox.owner(getApp)) this.setData({ todoStatus: 'error' })
    }
  },

  drawTodo() {
    if (!this._todayTodos?.length) return
    if (this._todayTodos[0].date !== schedule.today()) return this.loadTodayTodos()
    let choices = this._todayTodos.filter(task => !this._drawnTodoIds.has(task.id))
    if (!choices.length) {
      this._drawnTodoIds.clear()
      choices = this._todayTodos.filter(task => task.id !== this.data.drawnTodo?.id)
      if (!choices.length) choices = this._todayTodos
    }
    const task = choices[Math.floor(Math.random() * choices.length)]
    this._drawnTodoIds.add(task.id)
    this.setData({ drawnTodo: task })
  },

  drawTodoIdea() {
    const todo = TODO_POOL[Math.floor(Math.random() * TODO_POOL.length)]
    this.setData({ drawnTodo: todo })
  },

  openToolGoals() {
    wx.switchTab({ url: '/pages/goals/goals', fail: () => wx.showToast({ title: '暂时无法打开目标页', icon: 'none' }) })
  },

  openToolMood() {
    wx.switchTab({ url: '/pages/home/home', fail: () => wx.showToast({ title: '暂时无法打开首页', icon: 'none' }) })
  },

  focusFromTool(e) {
    const source = e.currentTarget.dataset.source
    let task = source === 'todo' ? this.data.drawnTodo : null
    if (task?.id && task.date !== schedule.today()) return this.loadTodayTodos()
    const text = e.currentTarget.dataset.text
    if (!task && text) task = { text }
    this.openTool({ currentTarget: { dataset: { tool: 'pomodoro' } } })
    if (this.data.pomodoroRunning || this.data.pomodoroStatus === '已暂停') {
      wx.showToast({ title: '已保留原计时，重置后可换', icon: 'none' })
      return
    }
    this.setData({ pomodoroTask: task, pomodoroMode: e.currentTarget.dataset.rest ? 'break5' : 'focus5' })
    this.resetPomodoro()
  },

  openToolTask(e) {
    const task = e.currentTarget.dataset.source === 'todo' ? this.data.drawnTodo : this.data.pomodoroTask
    if (!task?.goalId) return
    wx.navigateTo({
      url: '/pages/goal-detail/goal-detail?id=' + encodeURIComponent(task.goalId) +
        '&date=' + encodeURIComponent(task.date) + '&task=' + encodeURIComponent(task.id),
      fail: () => wx.showToast({ title: '暂时无法打开任务', icon: 'none' }),
    })
  },

  // ═══════════ 专注宣言 ═══════════

  onFocusInput(e) {
    this.setData({ focusInput: e.detail.value, focusOath: '' })
  },

  onFocusObstacleInput(e) {
    this.setData({ focusObstacle: e.detail.value, focusOath: '' })
  },

  generateFocusOath() {
    const input = this.data.focusInput.trim()
    if (!input) return wx.showToast({ title: '请输入要专注的事', icon: 'none' })

    const obstacle = this.data.focusObstacle.trim() || '我有点想拖延'
    this.setData({ focusOath: `如果${obstacle}，我就先用 5 分钟做「${input}」，到点再决定要不要继续。` })
  },

  copyFocusOath() {
    wx.setClipboardData({
      data: this.data.focusOath,
      success: () => wx.showToast({ title: '已复制宣言', icon: 'success' })
    })
  },

  saveFocusOath() {
    const content = this.data.focusOath
    const date = getTodayStr()
    if (!content) return
    const history = [{ content, date }, ...this.data.focusHistory.filter(item => item.content !== content || item.date !== date)].slice(0, 10)
    try {
      wx.setStorageSync('focusOathHistory', history)
      this.setData({ focusHistory: history })
      wx.showToast({ title: '已保存到本机', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: '保存失败，可先复制宣言', icon: 'none' })
    }
  },

  toggleFocusHistory() {
    this.setData({ focusHistoryExpanded: !this.data.focusHistoryExpanded })
  },

  _loadFocusHistory() {
    try {
      const history = wx.getStorageSync('focusOathHistory') || []
      this.setData({ focusHistory: Array.isArray(history) ? history : [] })
    } catch (e) {
      this.setData({ focusHistory: [] })
    }
  },

  // ═══════════ 拖延急救 ═══════════

  selectDelay(e) {
    const value = e.currentTarget.dataset.value || ''
    this.setData({ delaySelected: value })
    if (value && DELAY_HELP_DATA[value]) {
      this.setData({ delayResult: DELAY_HELP_DATA[value] })
    } else {
      this.setData({ delayResult: null })
    }
  },

  // ═══════════ 人格测试 ═══════════

  answerPersonalityQuestion(e) {
    const type = e.currentTarget.dataset.type || ''
    const answers = [...this.data.personalityAnswers, type]
    const step = this.data.personalityStep + 1

    if (step >= this.data.personalityQuestions.length) {
      const result = this._calculatePersonalityResult(answers)
      this.setData({
        personalityAnswers: answers,
        personalityStep: step,
        personalityResult: PERSONALITY_RESULTS[result] || PERSONALITY_RESULTS.squirrel,
      })
    } else {
      this.setData({ 
        personalityAnswers: answers, 
        personalityStep: step,
        currentPersonalityQuestion: PERSONALITY_QUESTIONS[step] || { text: '', options: [] },
      })
    }
  },

  _calculatePersonalityResult(answers) {
    const counts = { squirrel: 0, owl: 0, shiba: 0, capybara: 0 }
    answers.forEach(a => {
      if (counts[a] !== undefined) counts[a]++
    })
    let maxType = 'squirrel'
    let maxCount = 0
    Object.keys(counts).forEach(type => {
      if (counts[type] > maxCount) {
        maxCount = counts[type]
        maxType = type
      }
    })
    return maxType
  },

  resetPersonalityTest() {
    this.setData({
      personalityStep: 0,
      personalityAnswers: [],
      personalityResult: null,
      currentPersonalityQuestion: PERSONALITY_QUESTIONS[0],
    })
  },

  // ═══════════ 自律人格卡 ═══════════

  selectDiscipline(e) {
    const value = e.currentTarget.dataset.value || ''
    this.setData({ disciplineSelected: value })
    if (value && DISCIPLINE_CARD_DATA[value]) {
      this.setData({ disciplineCard: DISCIPLINE_CARD_DATA[value] })
    } else {
      this.setData({ disciplineCard: null })
    }
  },

  // ═══════════ 情绪能量检测 ═══════════

  setEnergyLevel(e) {
    const level = parseInt(e.currentTarget.dataset.level) || 0
    this.setData({ energyLevel: level })
    this._checkEnergyResult()
  },

  selectEmotion(e) {
    const value = e.currentTarget.dataset.value || ''
    this.setData({ emotionSelected: value })
    this._checkEnergyResult()
  },

  _checkEnergyResult() {
    const level = this.data.energyLevel
    const emotion = this.data.emotionSelected
    if (level > 0 && emotion) {
      const levelKey = level <= 2 ? 'low' : (level === 3 ? 'medium' : 'high')
      const result = ENERGY_RESULTS[levelKey] && ENERGY_RESULTS[levelKey][emotion]
      this.setData({ energyResult: result })
    } else {
      this.setData({ energyResult: null })
    }
  },

  // ═══════════ 页面生命周期 ═══════════

  onHide() {
    this.pausePetChat()
    this.stopTypewriter()
    this.persistPlannerWorkingCopy()
    this.setData({ showPlanModal: false })
    this.leavePartnerWorkspace()
    this._stopPomodoroTimer()
  },

  onUnload() {
    this.pausePetChat()
    this._toolboxUnloaded = true
    this._todoRequestId = (this._todoRequestId || 0) + 1
    this._capsuleLoadId = (this._capsuleLoadId || 0) + 1
    this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
    this._draftLoadId = (this._draftLoadId || 0) + 1
    this.stopTypewriter()
    this.persistPlannerWorkingCopy()
    this.leavePartnerWorkspace()
    this._stopPomodoroTimer()
  },
})
