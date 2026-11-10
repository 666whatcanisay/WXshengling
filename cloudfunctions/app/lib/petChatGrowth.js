const { businessDate } = require('./taskRules')

const DAY = 86400000
const WINDOW = 14 * DAY
const habits = {
  comfort: { listen: '累的时候先陪一会儿', suggest: '累的时候可以给一个小建议' },
  celebration: { quiet: '用轻声肯定庆祝', enthusiastic: '热热闹闹地一起庆祝' },
  humor: { reserved: '玩笑收着一点', playful: '熟悉的话题可以轻轻打趣' },
}
const innate = {
  lively: ['活泼，愿意先凑近看看', '闲聊接住有趣的地方，句子轻快；安慰时把热闹收小，主动陪一会儿；庆祝时替对方雀跃，说清在为什么高兴；回答问题先给明白的一句。'],
  cool: ['安静，先观察再开口', '闲聊少说但会留意一个细节；安慰用简短而具体的关心；庆祝偏克制，承认对方的努力；回答直接，知道多少说多少。'],
  tsundere: ['有点别扭，嘴上收着，还是愿意靠近', '熟悉的闲聊可以有轻微嘴硬，随后用行动式的表达透出关心；安慰时收起刺；庆祝可先故作镇定再认真夸一句；回答问题照样说清。'],
  airhead: ['对新事物好奇，偶尔慢半拍', '闲聊偶尔有温柔的联想，说完回到对方的话；安慰慢一点，留些空白；庆祝会真诚惊喜；认真提问时不要装傻。'],
  scholar: ['喜欢弄明白遇见的新东西', '闲聊会对一个细节真心好奇；安慰先听，获邀再把事情拆小；庆祝会留意对方找到了什么方法；回答问题简单说明缘由。'],
  foodie: ['容易被食物的气味吸引', '闲聊有生活气息，可以偶尔用食物比喻；安慰重在给人松口气；庆祝像在分享一件小小的好事；直接提问时先答，避免每轮都绕回吃的。'],
  socialphobia: ['容易害羞，会先探头确认安全', '闲聊先轻轻接话，熟悉后放松一点；安慰用并肩的感觉；庆祝偏小声但具体；回答问题可以温和直说。'],
}
const instincts = { lynx: '好奇时轻动耳尖', golden_retriever: '高兴时摇尾巴', capybara: '安心时愿意静静待着', shiba: '好奇时会侧头看' }
const keepSettings = ['pace', 'length', 'expression', 'recall']

function hatchTime(pet, now) {
  return Number.isSafeInteger(pet.hatch_time) && pet.hatch_time > 0 && pet.hatch_time <= now ? pet.hatch_time : 0
}

function begin(state, pet, now, fromHatch, address) {
  const bornAt = hatchTime(pet, now)
  state.generation++
  state.settingsRevision++
  state.noteRevision++
  state.settings = Object.fromEntries(keepSettings.filter(key => state.settings[key]).map(key => [key, state.settings[key]]))
  if (address) state.settings.address = address
  state.turns = []
  state.note = null
  state.pending = null
  state.greeted = ''
  state.growth = { at: now, newborn: !!(fromHatch && bornAt && now - bornAt < DAY), spoken: false,
    revision: 0, habits: {}, candidates: {}, seen: [] }
}

function normalizeGrowth(growth, now) {
  if (!growth) return null
  const candidates = Object.fromEntries(Object.entries(growth.candidates).flatMap(([slot, candidate]) => {
    const turns = candidate.turns.filter(turn => turn.at > now - WINDOW)
    return turns.length ? [[slot, { value: candidate.value, turns }]] : []
  }))
  return { ...growth, candidates, seen: growth.seen.filter(turn => turn.at > now - WINDOW) }
}

function viewGrowth(pet, growth, hasLegacy, now) {
  return { status: growth ? 'started' : hasLegacy ? 'restart' : 'new', bornAt: hatchTime(pet, now),
    ...(growth && { at: growth.at, newborn: growth.newborn, spoken: growth.spoken, revision: growth.revision,
      habits: Object.entries(growth.habits).map(([slot, item]) => ({ slot, value: item.value, label: habits[slot][item.value],
        at: item.at, sourceCount: item.turns.length })) }) }
}

function roleFor(pet) {
  const [trait, voice] = Object.hasOwn(innate, pet.personality) ? innate[pet.personality] : ['带着一点好奇，按自己的节奏观察', '先听对方说完，回应具体内容。']
  return { trait, voice, instinct: Object.hasOwn(instincts, pet.species) ? instincts[pet.species] : '用这个物种自然的动作表达' }
}

function validHabit(slot, value) {
  return typeof slot === 'string' && Object.hasOwn(habits, slot) && typeof value === 'string' && Object.hasOwn(habits[slot], value)
}

// Only explicit first-person requests tied to a supported behavior count as evidence.
const directionWords = {
  comfort: { listen: /陪|听我|安静|别.{0,4}建议|不.{0,4}建议/, suggest: /建议|主意|办法|帮我想/ },
  celebration: { quiet: /轻声|小声|低调|安静|别.{0,5}(夸|庆祝|起哄)/, enthusiastic: /热闹|热情|欢呼|大声|夸我|庆祝/ },
  humor: { reserved: /(?:别|不想|不要).{0,5}(开玩笑|打趣|逗)|少.{0,5}(玩笑|打趣)|克制/, playful: /玩笑|打趣|逗我|接梗/ },
}
const negatedDirections = {
  listen: /(?:别|不要|不用|不想|不喜欢|不需要).{0,8}(?:陪|听我|安静)/,
  quiet: /(?:别|不要|不用|不想|不喜欢).{0,8}(?:轻声|小声|低调|安静)/,
  reserved: /(?:别|不要|不想).{0,8}克制/,
  suggest: /(?:别|不要|不用|不想|不喜欢|不需要).{0,8}(?:建议|主意|办法|帮我想)/,
  enthusiastic: /(?:别|不要|不用|不想|不喜欢).{0,8}(?:热闹|热情|欢呼|大声|夸|庆祝)/,
  playful: /(?:别|不要|不用|不想|不喜欢).{0,8}(?:玩笑|打趣|逗|接梗)/,
}
function groundedSignal(signal, messages) {
  if (!signal || !validHabit(signal.slot, signal.value) || !Number.isInteger(signal.messageIndex)) return null
  const message = messages[signal.messageIndex]
  const quote = signal.quote
  if (typeof message !== 'string' || typeof quote !== 'string' || quote.length < 4 || quote.length > 120 || !message.includes(quote)) return null
  if (/[「」“”『』"《》]|(?:(?:他|她|朋友|同学|同事|老师|别人)(?:刚才|今天|以前|曾经|跟我|对我)?说|开玩笑的|反话|假如|如果我是)/.test(message)) return null
  const clause = message.split(/[，。！？；,.!?;\n]/).find(part => part.includes(quote.replace(/[，。！？；,.!?;]+$/, '')))
  if (!clause || /(?:给|对|陪|和|跟|听|逗)(?:他|她|别人|其他人|朋友|同学|同事|老师|另一只|别的宠物)/.test(clause)) return null
  if (/(?:仅限|只限)(?:今天|这次)|(?:这次|这回|这一轮|今天|今晚|暂时|现在)(?:只|先|就|别|不要|不用|想|希望|能不能)/.test(clause)) return null
  if (!/(?:我(?:希望|想|喜欢|更喜欢|需要|不想|不喜欢|累)|陪我|听我|给我|对我|和我|跟我|夸我|逗我|帮我|请你|你(?:可以|别|就)|(?:以后|下次)(?:你|别|可以|就|请|先|不要))/.test(quote)) return null
  if (!directionWords[signal.slot][signal.value].test(quote)) return null
  if (negatedDirections[signal.value].test(clause)) return null
  return { slot: signal.slot, value: signal.value }
}

function learn(growth, signal, id, now) {
  if (!signal || growth.seen.length >= 5000 || growth.seen.some(turn => turn.id === id)) return
  const { slot, value } = signal
  const turn = { id, at: now }
  growth.seen.push(turn)
  if (growth.habits[slot]?.value === value) {
    delete growth.candidates[slot]
    return
  }
  const previous = growth.candidates[slot]
  const turns = previous?.value === value ? [...previous.turns, turn] : [turn]
  if (turns.length >= 3 && new Set(turns.map(item => businessDate(item.at))).size >= 2) {
    growth.habits[slot] = { value, at: now, turns: turns.slice(-3).map(item => item.id) }
    growth.revision++
    delete growth.candidates[slot]
  } else growth.candidates[slot] = { value, turns: turns.slice(-3) }
}

module.exports = { habits, begin, normalizeGrowth, viewGrowth, roleFor, validHabit, groundedSignal, learn }
