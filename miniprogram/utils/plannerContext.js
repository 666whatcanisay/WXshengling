// Pure, shared planner context contract. Deploy copy is checked byte-for-byte.
const FIELDS = ['what', 'why', 'deadline', 'dailyTime', 'level', 'constraints']
const empty = () => Object.fromEntries(FIELDS.map(field => [field, '']))
const isSmallTalk = text => /了解(?:一下|下)?(?:你|您)|介绍(?:一下|下)?(?:你|您|自己)|你是谁|你(能|会|可以).{0,12}(做什么|干什么)|^(你好|您好|谢谢|好的|可以|随便聊聊|先聊聊)[！!。.?？\s]*$/.test(text)
function goal(text, allowShort = false) {
  const input = String(text || '').trim()
  if (!input) return ''
  const match = input.match(/(?:目标(?:是|改成|换成|改为)|(?:(?:现在|这次)?我(?:现在|这次)?(?:想要?|要|打算|准备)|想要|打算|准备)|(?:换成|改成|改为))([^，。！？,;；\n]{1,80})/)
  if (match) {
    const value = match[1].replace(/^(?:把目标)?(?:换成|改成|改为)/, '').replace(/^(?:要|去|开始|先)\s*/, '').trim()
    if (isSmallTalk(value) || /^(知道|了解)(你|您)|^(生成|修改|调整|看看|问问|聊|说)|^(周期|时间|水平|难度)|^(每天|每日|每周)\s*\d+\s*(分钟|小时)|^\d+\s*(天|周|个月|分钟|小时)$/.test(value)) return ''
    return value
  }
  if (isSmallTalk(input)) return ''
  if (allowShort && input.length <= 24 && /^(?:学习?|练习?|养成|坚持|每天|每日)?(?:游泳|跑步|阅读|早起|健身|减肥|减脂|背单词|英语|数学|写作|吉他|编程|Python|Java|复习)(?:.{0,12})?$/i.test(input)) return input
  if (allowShort && input.length <= 24 && /^(?:学习?|练习|养成|完成|培养|掌握|改善|戒掉).+/.test(input)) return input
  return ''
}
function extract(text, options = {}) {
  const input = String(text || '').trim(), result = {}
  const what = goal(input, options.allowShort !== false)
  if (what) result.what = what
  const deadline = input.match(/(?:周期|持续|坚持|计划|用|在|先)?\s*(\d+)\s*(天|周|个月)(?!\s*(?:内)?\s*(分钟|小时))/)
  if (deadline && Number(deadline[1]) > 0 && !new RegExp('(每|隔)\\s*' + deadline[1] + '\\s*' + deadline[2]).test(input)) result.deadline = deadline[1] + deadline[2]
  const daily = input.match(/(?:每天|每日|一天).{0,10}?(\d+(?:\.\d+)?)\s*(分钟|小时)/) || input.match(/(?:每天|每日).{0,6}?(?:改成|改为)?\s*(\d+(?:\.\d+)?)\s*(分钟|小时)/)
  if (daily && Number(daily[1]) > 0) result.dailyTime = daily[1] + daily[2]
  if (/新手|初学者|零基础|小白|刚接触/.test(input)) result.level = '新手'
  else if (/有基础|学过|中级/.test(input)) result.level = '有基础'
  else if (/熟练|精通|高级/.test(input)) result.level = '熟练'
  const why = input.match(/(?:因为|为了|目的是|动力是)([^，。！？\n]{2,120})/)
  if (why) result.why = why[1].trim()
  if (/只(?:能|在)?(?:周末|晚上|早上|工作日)|不能|不方便|避免|不超过|最多|不要.{1,12}(?:跑|跳|安排|任务)/.test(input)) result.constraints = input.slice(0, 200)
  return result
}
function derive(messages, previous) {
  const state = previous ? JSON.parse(JSON.stringify(previous)) : { values: empty(), sources: {}, revision: 0 }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || message.role !== 'user' || typeof message.content !== 'string') continue
    if (/换个目标|换一个目标|重新来|重新开始|换个方向|不想要这个|重新规划|重新计划|再规划|重做计划|再来一次/.test(message.content)) {
      state.values = empty(); state.sources = {}; state.revision++
    }
    const values = extract(message.content), source = { kind: 'user_message', message_id: message.id || 'user-' + index, quote: message.content.slice(0, 500) }
    if (values.what && state.values.what && values.what !== state.values.what) {
      // A new goal starts fresh; old motivation/budget/level aren't silently inherited.
      state.values = empty(); state.sources = {}
    }
    let changed = false
    for (const [field, value] of Object.entries(values)) {
      if (state.values[field] !== value) changed = true
      state.values[field] = value; state.sources[field] = { ...source, value }
    }
    if (changed) state.revision++
  }
  return state
}
function assumptions(context, goalData) {
  const values = context && context.values || empty()
  const output = []
  if (!values.deadline && goalData && goalData.target_days) output.push({ field: 'deadline', value: goalData.target_days + '天', source: 'draft_setting', confirmed: false })
  if (!values.dailyTime) output.push({ field: 'dailyTime', value: '每日投入尚未明确，任务时长仅是草案建议', source: 'missing', confirmed: false })
  if (!values.level) output.push({ field: 'level', value: '当前基础尚未明确', source: 'missing', confirmed: false })
  return output
}
module.exports = { FIELDS, empty, goal, extract, derive, assumptions }
