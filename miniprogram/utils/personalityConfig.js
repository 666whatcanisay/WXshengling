/**
 * Pet V4 - 性格系统配置
 *
 * 每只孵化出的宠物随机获得一种性格
 * 性格影响：对话文案、互动反馈、心情倾向、动画表现
 *
 * 同一物种 + 不同性格 = 完全不同的宠物体验 → 收藏价值暴涨
 */

module.exports.PERSONALITY_CONFIG = {

  lively: {
    key: 'lively',
    name: '活泼',
    icon: '🎉',
    color: '#FF7043',
    desc: '精力充沛，永远停不下来',

    // 对话风格模板（{name}=宠物名）
    dialoguePool: [
      '{name}今天也要元气满满！冲鸭！',
      '主人主人！{name}想出去玩！',
      '嘿嘿，{name}等不及啦～',
      '哇！{name}觉得今天超棒的！',
      '{name}的尾巴摇得停不下来！',
    ],

    // 互动反馈后缀
    interactSuffix: [
      '开心地转了三个圈！',
      '兴奋地蹦了起来！',
      '眼睛亮晶晶地看着你！',
      '发出快乐的叫声！',
    ],

    // 心情倾向（这个性格更容易出现哪些心情）
    moodBias: { excited: 0.35, happy: 0.40, normal: 0.15, sleepy: 0.05, bored: 0.03, sad: 0.02 },

    // 动画偏好
    animStyle: 'bouncy',     // bouncy / calm / lazy / nervous / proud

    // 特殊触发条件文案
    specialLines: {
      onLevelUp: ['升级啦！{name}更强了！', '耶！{name}变厉害了！'],
      onHatch: ['哇——！{name}出生啦！！世界好大啊！！'],
      onAwaken: ['感觉...身体里涌出了力量！！！{name}觉醒了！！！'],
      onLongLeave: ['主人你去哪了呀！{name}等好久！'],
    },
  },

  cool: {
    key: 'cool',
    name: '高冷',
    icon: '😎',
    color: '#42A5F5',
    desc: '话少但靠谱，内心其实很在乎你',

    dialoguePool: [
      '...',
      '嗯。',
      '{name}知道了。',
      '无聊。（但其实在偷偷看你）',
      '哼。',
    ],

    interactSuffix: [
      '面无表情地看了你一眼（耳朵微微动了）',
      '轻轻点了点头',
      '别误会，{name}只是不讨厌你而已',
      '转过身去，但尾巴摇了一下',
    ],

    moodBias: { excited: 0.05, happy: 0.15, normal: 0.45, sleepy: 0.15, bored: 0.15, sad: 0.05 },
    animStyle: 'calm',

    specialLines: {
      onLevelUp: ['...变强了。'],
      onHatch: ['......（睁开眼睛）你是谁。'],
      onAwaken: ['（周身泛起光芒）...终于，到了这一步。'],
      onLongLeave: ['...回来了就好。'],
    },
  },

  tsundere: {
    key: 'tsundere',
    name: '傲娇',
    icon: '💢',
    color: '#EF5350',
    desc: '嘴上不说，行动很诚实',

    dialoguePool: [
      '才、才不是在等你呢！',
      '哼，{name}才没有想你！',
      '笨蛋主人，又来烦{name}...',
      '（小声）...其实挺开心的。',
      '别、别误会啊！',
    ],

    interactSuffix: [
      '一边说"才不要"一边凑过来蹭了蹭',
      '脸红着把头扭到一边',
      '"就这一次哦..."然后开心地吃了',
      '假装不在意但尾巴暴露了一切',
    ],

    moodBias: { excited: 0.10, happy: 0.25, normal: 0.30, sleepy: 0.05, bored: 0.20, sad: 0.10 },
    animStyle: 'nervous',

    specialLines: {
      onLevelUp: ['才不是因为升级高兴呢！（嘴角上扬）'],
      onHatch: ['谁、谁要你抱啊！（钻进怀里）'],
      onAwaken: ['哼，觉醒了而已...没什么大不了的！（光芒四射）'],
      onLongLeave: ['你终于回来了...不是{name}在等你！'],
    },
  },

  airhead: {
    key: 'airhead',
    name: '天然呆',
    icon: '🌸',
    color: '#F48FB1',
    desc: '总是慢半拍，天然治愈系',

    dialoguePool: [
      '诶？刚才有什么声音吗？',
      '嗯...{name}在想事情...',
      '啊哈哈，原来是这样～',
      '主人你在说什么呢？',
      '(´・ω・`)',
    ],

    interactSuffix: [
      '呆呆地眨了眨眼，然后笑了',
      '慢悠悠地靠过来',
      '歪着头看了半天，最后打了个哈欠',
      '好像没反应过来，但很开心地摇了摇尾巴',
    ],

    moodBias: { excited: 0.10, happy: 0.30, normal: 0.30, sleepy: 0.20, bored: 0.07, sad: 0.03 },
    animStyle: 'lazy',

    specialLines: {
      onLevelUp: ['咦？{name}好像...变大了？'],
      onHatch: ['(睁眼) 哇...世界...好圆...'],
      onAwaken: ['诶？身上发光了...是{name}变漂亮了吗？'],
      onLongLeave: ['啊...主人...你去哪儿了呀...'],
    },
  },

  scholar: {
    key: 'scholar',
    name: '学霸',
    icon: '📚',
    color: '#7CB342',
    desc: '热爱知识，总在学习新东西',

    dialoguePool: [
      '根据{name}的研究，今天效率提升23%！',
      '主人今天背单词了吗？',
      '让{name}来分析一下今天的任务优先级...',
      '知识就是力量！{name}又学到了新东西！',
      '这本书已经读了第7遍了～',
    ],

    interactSuffix: [
      '边吃边翻开了书',
      '认真记录了这次互动的数据',
      '推了推眼镜（虽然没戴眼镜）',
      '若有所思地点了点头',
    ],

    moodBias: { excited: 0.10, happy: 0.25, normal: 0.40, sleepy: 0.10, bored: 0.10, sad: 0.05 },
    animStyle: 'calm',

    specialLines: {
      onLevelUp: ['经验值达到阈值！理论验证成功！'],
      onHatch: ['（睁眼）数据采集开始...你好，观察对象。'],
      onAwaken: ['所有理论...在这一刻得到了升华！'],
      onLongLeave: ['你离开了284700秒...{name}一直在计算你的回归概率。'],
    },
  },

  foodie: {
    key: 'foodie',
    name: '吃货',
    icon: '🍖',
    color: '#FFA726',
    desc: '人生意义就是吃，吃就是人生',

    dialoguePool: [
      '打卡完能吃饭吗？',
      '主人...那个看起来好好吃...',
      '{name}的肚子又在叫了',
      '今天的第3顿饭什么时候来？',
      '美食是生命的意义！(¯﹃¯)',
    ],

    interactSuffix: [
      '两眼放光地扑向食物',
      '幸福地眯起眼睛，腮帮子鼓鼓的',
      '吃完还意犹未尽地舔了舔嘴',
      '满足地拍了拍肚皮',
    ],

    moodBias: { excited: 0.25, happy: 0.35, normal: 0.15, sleepy: 0.10, bored: 0.10, sad: 0.05 },
    animStyle: 'bouncy',

    specialLines: {
      onLevelUp: ['升级了！可以吃更多好吃的了！'],
      onHatch: ['（嗅）有食物的味道吗？！{name}饿了！'],
      onAwaken: ['觉醒后的第一件事...找吃的！'],
      onLongLeave: ['你不在的时候...{name}好饿...'],
    },
  },

  socialphobia: {
    key: 'socialphobia',
    name: '社恐',
    icon: '🫣',
    color: '#AB47BC',
    desc: '害怕陌生人，但对主人很依赖',

    dialoguePool: [
      '我、我今天不太想说话...',
      '（躲在角落）别看{name}...',
      '只有主人在的时候才安心...',
      '外面好可怕...我想回家...',
      '（小声）...谢谢主人陪着我...',
    ],

    interactSuffix: [
      '缩了缩但还是乖乖让你摸了',
      '紧张地把头埋进你怀里',
      '小声地说了句"...喜欢"',
      '耳朵红了，不敢看你',
    ],

    moodBias: { excited: 0.03, happy: 0.15, normal: 0.25, sleepy: 0.12, bored: 0.20, sad: 0.25 },
    animStyle: 'nervous',

    specialLines: {
      onLevelUp: ['变、变强了...这样就能更好地保护自己了...'],
      onHatch: ['（颤抖睁眼）不、不要看{name}...（看到是你）...啊，是你啊...'],
      onAwaken: ['（光芒中）...只要和主人在一起...{name}就不怕...'],
      onLongLeave: ['主人不在...{name}好害怕...（发抖）'],
    },
  },
}

/** 所有性格key列表 */
module.exports.PERSONALITY_KEYS = Object.keys(module.exports.PERSONALITY_CONFIG)

/**
 * 随机生成性格（均等概率）
 */
function rollPersonality() {
  const keys = module.exports.PERSONALITY_KEYS
  return keys[Math.floor(Math.random() * keys.length)]
}

/**
 * 获取性格配置
 */
function getPersonalityConfig(key) {
  return module.exports.PERSONALITY_CONFIG[key] || module.exports.PERSONALITY_CONFIG.airhead
}

/**
 * 根据性格获取随机对话
 */
function getPersonalityDialogue(personalityKey, petName) {
  const cfg = getPersonalityConfig(personalityKey)
  const pool = cfg.dialoguePool
  const text = pool[Math.floor(Math.random() * pool.length)]
  return (petName ? text.replace(/\{name\}/g, petName) : text)
}

/**
 * 根据性格+动作获取互动反馈后缀
 */
function getPersonalityInteractSuffix(personalityKey, actionType) {
  const cfg = getPersonalityConfig(personalityKey)
  return cfg.interactSuffix[Math.floor(Math.random() * cfg.interactSuffix.length)]
}

/**
 * 根据性格偏置roll心情
 */
function rollMoodByPersonality(personalityKey) {
  const cfg = getPersonalityConfig(personalityKey)
  const bias = cfg.moodBias
  const rand = Math.random()
  let cumulative = 0
  for (const [mood, prob] of Object.entries(bias)) {
    cumulative += prob
    if (rand < cumulative) return mood
  }
  return 'normal'
}

module.exports.rollPersonality = rollPersonality
module.exports.getPersonalityConfig = getPersonalityConfig
module.exports.getPersonalityDialogue = getPersonalityDialogue
module.exports.getPersonalityInteractSuffix = getPersonalityInteractSuffix
module.exports.rollMoodByPersonality = rollMoodByPersonality
