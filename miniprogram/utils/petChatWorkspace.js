const petConstants = require('./petConstants')
const { getPetPortrait } = require('./petPortrait')
const personalityConfig = require('./personalityConfig')
const stageNames = { BABY: '幼年', YOUTH: '少年', ADULT: '成年', PERFECT: '完美形态' }
const habitOptions = {
  comfort: [['listen', '先陪一会儿'], ['suggest', '给一点建议']],
  celebration: [['quiet', '轻声肯定'], ['enthusiastic', '热情庆祝']],
  humor: [['reserved', '少开玩笑'], ['playful', '可以轻轻打趣']],
}
const firstLines = {
  lively: ['咦，是你一直照顾我呀？', '那我该叫你什么？', '哇，外面好亮！一直陪着我的是你吗？'],
  cool: ['嗯……是你把我从蛋里养大的吗？', '我该怎么叫你呀？', '嗯……壳外一直陪着我的，是你吗？'],
  tsundere: ['我就靠近一点点。一直照顾我的，是你吧？', '告诉我怎么叫你，我记得住。', '壳开了，我可没害怕。外面那个熟悉的声音，是你吧？'],
  airhead: ['唔，我想起来了……守着我的人，是你吗？', '我还没问呢，我该叫你什么？', '等等……原来壳外面还有这么大一块地方。刚才陪我的，是你吗？'],
  scholar: ['我想弄明白一件事。照顾我的人是你吗？', '我应该怎么称呼你？', '这就是蛋壳外面呀。一直照顾我的是你吗？'],
  foodie: ['醒来觉得暖乎乎的。是你一直在照顾我吗？', '我可以怎么叫你呀？', '壳外暖乎乎的。刚才一直守着我的是你吗？'],
  socialphobia: ['我先探个头……一直陪着我的，是你吗？', '我能小声问一下，该怎么叫你吗？', '我先从壳里探个头……你就是一直陪着我的那个人吗？'],
}
const shortDate = timestamp => Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8640000000000000 - 28800000
  ? new Date(timestamp + 28800000).toISOString().slice(0, 10) : ''

const groups = [
  ['tone', '说话语气', [['reserved', '收着说'], ['warm', '温和'], ['playful', '俏皮']]],
  ['pace', '接话节奏', [['quick', '及时接话'], ['wait', '等我说完']]],
  ['comfort', '我累的时候', [['listen', '先听我说'], ['suggest', '给一点建议']]],
  ['lead', '主动接话', [['off', '只回我'], ['visit', '进来时偶尔说']]],
  ['length', '消息长短', [['short', '短句'], ['normal', '正常']]],
  ['expression', '小动作', [['some', '少量'], ['off', '关闭']]],
  ['recall', '回提约定', [['relevant', '相关时提'], ['asked', '仅我提起']]],
].map(([key, title, values]) => ({ key, title, values: values.map(([value, label]) => ({ value, label })) }))

const examples = {
  reserved: { listen: '最后两题明天再说。你先坐会儿。', suggest: '最后两题留到明天吧。先把卡住的地方圈一下。' },
  warm: { listen: '同一段听了三遍，确实会累。我陪你歇会儿。', suggest: '这段反复听很耗神。要不要先记下卡住的那一句，明天从那里接？' },
  playful: { listen: '练习册先下班，你也下班。明天再找那两题算账。', suggest: '给那两题夹张书签，让它俩在那儿等你下班。' },
}

function displayPet(pet) {
  const app = petConstants.getPetAppearance(pet)
  const species = petConstants.SpeciesConfig.getSpecies(pet.species)
  const mood = petConstants.getMoodDisplay(pet.mood || 'normal')
  const innate = pet.innatePersonality || pet.personality
  const personality = personalityConfig.PERSONALITY_KEYS.includes(innate) ? personalityConfig.getPersonalityConfig(innate) : null
  const color = app.rarityEffect?.colorLayer
  return { ...pet, portrait: getPetPortrait(pet, app), emoji: app.fallbackEmoji, speciesName: species?.name || '森林伙伴',
    stageName: pet.is_hatched ? (stageNames[app.stage] || app.stage) : '待孵化',
    temperamentName: personality?.name || '',
    talentName: app.talentName, talentGrade: app.talentGrade, colorName: app.colorTier === 'shiny' ? '异色' : app.isRare ? '稀有色' : '普通色',
    rarityName: app.rarityEffect?.name || '', rarityColor: app.rarityEffect?.color || '#9f8b55',
    colorStyle: color ? 'filter: hue-rotate(' + color.hueRotate + 'deg) saturate(' + (1 + color.saturate / 100) + ')' : '',
    moodName: mood.name, personality: personality ? personality.name + ' · ' + personality.desc : pet.personality,
    innateLabel: personality ? personality.name + ' · ' + personality.desc : '还在慢慢认识世界',
    forestPersonality: pet.forestPersonality || (pet.personality !== innate ? pet.personality : ''),
    attrList: petConstants.buildAttrList(pet.attributes),
    since: shortDate(pet.hatch_time),
    records: (Array.isArray(pet.growth_records) ? pet.growth_records : []).filter(Boolean).map((row, index) => ({ ...row, index,
      date: shortDate(row.time) })),
  }
}

function createWorkspace({ wx, getApp, cloudApi }) {
  const owner = () => {
    const app = getApp().globalData || {}
    return app.currentOpenid || app.userInfo?.openid || app.userInfo?._openid || ''
  }
  const key = (id, pet) => 'forest:pet-chat:v1:' + id + ':' + pet
  const requestId = () => 'pc-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  const errorText = error => typeof error === 'string' ? error : error?.message || '网络不可用'
  const readable = error => errorText(error).slice(0, 95)
  const missingAction = (error, action) => errorText(error).trim() === '未知操作: ' + action
  const upgradeMessage = '当前云端版本暂未开放宠物聊天，更新云函数后可使用。'
  function readLocal(id, pet) {
    try { return wx.getStorageSync(key(id, pet)) || {} } catch (_) { return {} }
  }
  function storeLocal(id, pet, value) {
    try { wx.setStorageSync(key(id, pet), value) } catch (_) {}
  }
  const eligible = pet => pet.is_hatched === true
  const needsIntro = remote => !!remote?.growth && remote.growth.status !== 'started'
  const editingFailed = session => session.remote?.pending?.status === 'failed' &&
    session.remote.pending.id === session.editFailed ? session.remote.pending : null
  const matches = (page, session) => page._pcOwner === owner() && page._pcCurrent === session && page._pcVisible &&
    page.data.mode === 'chat' && page.data.pcScreen === 'conversation' && !page.data.pcLoading && !page.data.pcUpgrade && !page.data.pcLoadError

  function persist(session) {
    storeLocal(session.owner, session.id, { input: session.input, queue: session.queue, held: session.held,
      request: session.request, listening: session.listening, reviewQueue: session.reviewQueue,
      editFailed: session.editFailed, generation: session.generation })
  }
  function show(page, session, scroll = false) {
    if (!matches(page, session)) return
    const remote = session.remote
    const ready = !!remote && !session.unavailable && !needsIntro(remote)
    const growth = remote?.growth
    const nickname = remote?.settings?.address
    const temperament = remote?.pet.innatePersonality
    const opener = Object.prototype.hasOwnProperty.call(firstLines, temperament) ? firstLines[temperament] : firstLines.cool
    const firstLine = growth?.status === 'started' && !growth.spoken
      ? (growth.newborn ? opener[2] : opener[0]) +
        (nickname && nickname !== '你' ? '我可以叫你「' + nickname + '」吗？' : opener[1]) : ''
    const pending = remote?.pending
    const editing = editingFailed(session)
    const unresolved = session.request && !session.flight
    const list = remote?.turns || []
    const last = list.at(-1)
    const today = shortDate(Date.now())
    let previousDate = ''
    const turns = list.map(turn => {
      const date = shortDate(turn.at)
      const dateLabel = date !== previousDate ? (date === today ? '今天' : date) : ''
      previousDate = date
      return { ...turn, dateLabel }
    })
    page.setData({
      pcPet: session.petDisplay || session.pet,
      pcSettings: remote?.settings || null, pcTurns: turns,
      pcPending: editing ? [] : session.request?.messages || pending?.messages || [],
      pcQueue: editing ? [...editing.messages, ...session.queue] : session.queue,
      pcHeld: session.held, pcInput: session.input, pcListen: session.listening,
      pcNote: remote?.note || null, pcReady: ready, pcSending: !!session.flight,
      pcMeet: needsIntro(remote) ? growth.status : '', pcFirstLine: firstLine,
      pcBondGrowth: growth ? { ...growth, bornDate: shortDate(growth.bornAt), date: shortDate(growth.at),
        habits: (growth.habits || []).map(habit => ({ ...habit, date: shortDate(habit.at) })) } : null,
      pcStatus: session.error || (!editing && !session.flight && pending?.status === 'failed' ? pending.error || '这次回复没有完成'
        : ready && unresolved && !pending ? '发送结果待确认' : ''),
      pcCanCheck: ready && (!!unresolved || pending?.status === 'running'),
      pcCanRetry: ready && (unresolved ? !!session.retryOriginal : pending?.status === 'failed'),
      pcCanRevise: ready && !editing && !session.request && pending?.status === 'failed' && !session.flight, pcSaving: !!session.changing,
      pcNeedsConfig: /AI 配置/.test(pending?.error || ''),
      pcAnimate: ready && remote.settings.expression !== 'off' && !!(session.flight || session.listening || session.reaction || pending?.status === 'running'),
      ...(scroll ? { pcAnchor: last || session.queue.length || session.held.length || pending || session.request
        ? (page.data.pcAnchor === 'pc-bottom' ? 'pc-end' : 'pc-bottom') : '' } : {}),
    })
  }
  function accept(session, result) {
    if (!result?.pet || result.pet.id !== session.id || !Array.isArray(result.turns)) throw new Error('会话返回无效')
    if (session.remote && result.generation < session.remote.generation) return false
    if (session.remote?.generation === result.generation) {
      const previous = session.remote
      if (previous.growth?.revision > result.growth?.revision) result.growth = previous.growth
      else if (previous.growth?.spoken && result.growth) result.growth = { ...result.growth, spoken: true }
      if (previous.settingsRevision > result.settingsRevision) {
        result.settingsRevision = previous.settingsRevision
        result.settings = previous.settings
        result.settingFields = previous.settingFields
      }
    }
    if (result.generation !== session.generation && (session.generation || result.growth?.status === 'started')) {
      session.input = ''
      session.queue = []
      session.held = []
      session.request = null
      session.editFailed = ''
      session.listening = false
      session.reviewQueue = false
      session.batchStart = 0
      session.batchDeadline = 0
    }
    session.generation = result.generation
    if (!session.petDisplay || JSON.stringify(session.remote?.pet) !== JSON.stringify(result.pet)) {
      session.petDisplay = { ...displayPet(result.pet), distinction: session.pet.distinction || '' }
    }
    session.remote = result
    if (result.pending?.id !== session.editFailed) session.editFailed = ''
    session.retryOriginal = false
    if (session.request && (result.completed_request === session.request.id || result.turns.some(turn => turn.id === session.request.id))) session.request = null
    if (result.pending && session.request?.id === result.pending.id) session.request = null
    persist(session)
    return true
  }

  const methods = {
    async enterPetChat(hatchPetId, resume = false) {
      const id = owner()
      if (!id) {
        this.pausePetChat()
        this._pcOwner = ''
        this._pcCurrent = null
        return this.setData({ pcScreen: 'picker', pcPanel: '', pcPet: null, pcPets: [], pcNote: null, pcUpgrade: '', pcLoadError: '请先登录', pcLoading: false })
      }
      const changed = id !== this._pcOwner
      if (changed) {
        this.pausePetChat()
        this._pcOwner = id
        this._pcSessions = new Map()
        this._pcCurrent = null
        this.setData({ pcPet: null, pcPets: [], pcCanChoose: false, pcTurns: [], pcPanel: '', pcDraft: null, pcInput: '', pcStatus: '',
          pcQueue: [], pcHeld: [], pcPending: [], pcNote: null, pcReady: false })
      }
      const resumeId = resume && this.data.pcScreen === 'conversation' ? this._pcCurrent?.id : ''
      const focusedId = resume && this.data.pcScreen === 'picker' ? this.data.pcPets[this.data.pcPickerIndex]?.id : ''
      const preferred = typeof hatchPetId === 'string' && hatchPetId ? hatchPetId : ''
      if (!resumeId) this._pcCurrent = null
      this._pcVisible = true
      const load = this._pcListLoad = (this._pcListLoad || 0) + 1
      const current = () => load === this._pcListLoad && this._pcVisible && owner() === id && this.data.mode === 'chat'
      this.setData({ pcScreen: resumeId ? 'conversation' : 'picker', pcLoading: true, pcLoadError: '', pcUpgrade: '', pcPanel: '' })
      try {
        let items
        try { items = await cloudApi.petChatPets() }
        catch (error) {
          if (!missingAction(error, 'petChatPets')) throw error
          if (!current()) return
          this.setData({ pcUpgrade: upgradeMessage })
          items = await cloudApi.petOverview()
        }
        if (!current()) return
        if (!Array.isArray(items)) throw new Error('宠物列表不可用')
        const pets = items.map(displayPet)
        for (const pet of pets) {
          if (pets.filter(other => other.name === pet.name && other.species === pet.species && other.stageName === pet.stageName).length > 1) {
            pet.distinction = '档案 ' + pet.id.slice(-6)
          }
        }
        const ready = pets.filter(eligible)
        const selected = readLocal(id, 'selected').id
        const index = pets.findIndex(pet => pet.id === (focusedId || selected))
        this.setData({ pcPets: pets, pcCanChoose: !!ready.length,
          pcPickerIndex: index >= 0 ? index : Math.max(0, pets.findIndex(eligible)), pcLoading: false })
        const target = ready.find(pet => pet.id === (preferred || resumeId))
        if (target) return this._pcSelect(target, !!preferred)
        if (preferred) wx.showToast({ title: '这只宠物暂不可聊天', icon: 'none' })
        this._pcCurrent = null
        this.setData({ pcScreen: 'picker', pcPet: null, pcReady: false })
      } catch (error) {
        if (current()) this.setData({ pcLoading: false, pcLoadError: readable(error) })
      }
    },

    pcReload() { return this.enterPetChat('', true) },

    pcBackToPicker() {
      this.pausePetChat()
      this._pcCurrent = null
      this._pcVisible = true
      this.setData({ pcScreen: 'picker', pcPet: null, pcPanel: '', pcDraft: null, pcReady: false })
    },

    pcTouchStart(e) {
      const point = e.touches?.[0]
      this._pcTouch = point && e.touches.length === 1 ? {
        x: point.clientX ?? point.pageX, y: point.clientY ?? point.pageY,
        header: e.currentTarget?.dataset?.region === 'header',
      } : null
    },

    pcTouchMove(e) {
      if (e.touches?.length === 1) this._pcSwipeHead(e.touches[0])
    },

    pcTouchEnd(e) {
      this._pcSwipeHead(e.changedTouches?.[0])
      this.pcTouchCancel()
    },

    _pcSwipeHead(point) {
      const start = this._pcTouch
      if (!start || !point || this.data.pcScreen !== 'conversation') return
      const dy = start.y - (point.clientY ?? point.pageY)
      const dx = start.x - (point.clientX ?? point.pageX)
      if (Math.abs(dy) >= 20 && Math.abs(dy) > Math.abs(dx)) {
        this._pcApplyHeadGesture(start, dy, start.header || (this._pcScrollTop || 0) <= 6)
      }
    },

    pcTouchCancel() { this._pcTouch = null },

    pcMessageScroll(e) { this._pcScrollTop = e.detail.scrollTop },

    pcDragStart(e) {
      // The native scroll view can take over and cancel the touch stream mid-drag.
      this._pcDrag = { top: e.detail.scrollTop, gesture: this._pcTouch || {} }
    },

    pcDragging(e) {
      if (!this._pcDrag) return
      const top = e.detail.scrollTop
      const distance = top - this._pcDrag.top
      if (Math.abs(distance) >= 14) this._pcApplyHeadGesture(this._pcDrag.gesture, distance, top <= 6)
    },

    pcDragEnd(e) {
      this.pcDragging(e)
      this._pcDrag = null
    },

    _pcApplyHeadGesture(gesture, direction, canExpand) {
      if (gesture.handled || this.data.pcScreen !== 'conversation') return
      if (this.data.pcHeadCollapsed && (direction > 0 || !canExpand)) return
      gesture.handled = true
      this.setData({ pcHeadCollapsed: !this.data.pcHeadCollapsed })
    },

    pcExpandHead() { this.setData({ pcHeadCollapsed: false }) },

    pcSwipe(e) { if (this.data.pcScreen === 'picker') this.setData({ pcPickerIndex: e.detail.current }) },

    pcPickerDot(e) { this.setData({ pcPickerIndex: Number(e.currentTarget.dataset.index) }) },

    pausePetChat() {
      this._pcVisible = false
      this.pcTouchCancel()
      this._pcDrag = null
      this._pcListLoad = (this._pcListLoad || 0) + 1
      for (const session of this._pcSessions?.values() || []) {
        clearTimeout(session.timer)
        clearTimeout(session.reaction)
        clearTimeout(session.poll)
        session.timer = null
        session.reaction = null
        session.poll = null
        session.batchStart = 0
        session.batchDeadline = 0
        persist(session)
      }
      if (this.data.pcAnimate || this.data.pcKeyboard) this.setData({ pcAnimate: false, pcKeyboard: 0 })
    },

    async _pcSelect(pet, fromHatch = false) {
      const id = this._pcOwner
      if (!eligible(pet) || id !== owner()) return
      if (this.data.pcUpgrade) {
        this._pcCurrent = null
        storeLocal(id, 'selected', { id: pet.id })
        return this.setData({ pcScreen: 'picker', pcPet: pet, pcReady: false, pcAnimate: false, pcPanel: 'role', pcTab: 'profile', pcGrowth: false,
          pcDraft: null, pcNote: null, pcBondGrowth: null })
      }
      const previous = this._pcCurrent
      const entering = this.data.pcScreen !== 'conversation' || previous?.id !== pet.id
      if (previous && previous.id !== pet.id) {
        clearTimeout(previous.timer)
        clearTimeout(previous.poll)
        previous.timer = null
        previous.poll = null
        previous.batchStart = 0
        previous.batchDeadline = 0
      }
      let session = this._pcSessions.get(pet.id)
      if (!session) {
        const local = readLocal(id, pet.id)
        session = { owner: id, id: pet.id, pet, input: local.input || '', queue: local.queue || [], held: local.held || [],
          listening: !!local.listening, reviewQueue: !!local.reviewQueue, editFailed: local.editFailed || '',
          request: local.request || null, generation: local.generation }
        this._pcSessions.set(pet.id, session)
      }
      session.pet = pet
      if (fromHatch) session.fromHatch = true
      if (session.petDisplay) session.petDisplay.distinction = pet.distinction || ''
      this._pcCurrent = session
      if (entering) {
        this.pcTouchCancel()
        this._pcDrag = null
        this._pcScrollTop = 0
      }
      storeLocal(id, 'selected', { id: pet.id })
      this.setData({ pcScreen: 'conversation', pcPickerIndex: this.data.pcPets.findIndex(item => item.id === pet.id),
        ...(entering && { pcHeadCollapsed: false }), pcPanel: '', pcDraft: null, pcMeetAddress: '你', pcMeetCustom: '' })
      show(this, session, true)
      if (session.flight) return
      try {
        await this._pcRefresh(session)
        this._pcSchedule(session)
        if (!matches(this, session) || !session.remote || needsIntro(session.remote) || session.request || session.queue.length || session.held.length) return
        if (session.remote.settings.lead === 'visit' && session.remote.note && !session.remote.pending) {
          await this._pcChange(session, { action: 'visit' })
        }
      } catch (error) { this._pcReadError(session, error) }
    },

    async _pcRefresh(session) {
      const version = session.changeVersion || 0
      const read = session.read = (session.read || 0) + 1
      const current = () => owner() === session.owner && session.read === read && (session.changeVersion || 0) === version && !session.flight
      let result
      try { result = await cloudApi.petChatGet({ pet_id: session.id, ...(session.request && { request_id: session.request.id }) }) }
      catch (error) { if (current()) throw error; return }
      if (!current()) return
      const previousPending = session.remote?.pending
      const stillWaiting = previousPending?.status === 'running' &&
        result.pending?.status === 'running' && result.pending.id === previousPending.id
      accept(session, result)
      session.unavailable = false
      session.error = ''
      show(this, session, !stillWaiting)
      this._pcWatchReply(session)
      return true
    },

    _pcWatchReply(session) {
      if (!matches(this, session) || session.flight || session.poll || session.remote?.pending?.status !== 'running') return
      session.poll = setTimeout(() => {
        session.poll = null
        if (matches(this, session)) this.pcCheck()
      }, 1800)
    },

    _pcReadError(session, error) {
      if (missingAction(error, 'petChatGet')) {
        session.unavailable = true
        session.error = upgradeMessage
      } else session.error = readable(error)
      show(this, session)
    },

    pcPick(e) {
      if (!this._pcVisible || this.data.mode !== 'chat' || this.data.pcLoading) return
      const pet = this.data.pcPets.find(item => item.id === e.currentTarget.dataset.id)
      if (pet) return this._pcSelect(pet)
    },
    pcMeetAddress(e) { this.setData({ pcMeetAddress: e.currentTarget.dataset.value }) },
    pcMeetCustom(e) { this.setData({ pcMeetCustom: e.detail.value }) },
    pcBegin() {
      const session = this._pcCurrent
      if (!session || !matches(this, session) || !needsIntro(session.remote) || session.changing) return
      const address = this.data.pcMeetAddress === 'custom' ? this.data.pcMeetCustom.trim() : this.data.pcMeetAddress
      if (!address) return wx.showToast({ title: '先写下想用的称呼', icon: 'none' })
      const restart = session.remote.growth.status === 'restart' || !!(session.input || session.request || session.queue.length || session.held.length)
      const begin = () => {
        if (matches(this, session)) return this._pcChange(session, { action: 'growth_start', address,
          restart, from_hatch: session.fromHatch === true })
      }
      if (!restart) return begin()
      wx.showModal({ title: '重新认识这只宠物？', content: '会清除这只宠物的旧聊天、待续和本机待发文字。森林档案与成长保留。',
        confirmText: '重新认识', success: result => { if (result.confirm) begin() } })
    },
    pcRole() {
      if (this.data.pcPet) this.setData({ pcPanel: 'role', pcTab: 'profile', pcDraft: null, pcMore: false, pcGrowth: false })
    },
    pcClose() { this.setData({ pcPanel: '', pcDraft: null }) },
    pcTab(e) {
      if (!this.data.pcReady) return
      const tab = e.currentTarget.dataset.tab
      const remote = this._pcCurrent.remote
      const draft = this.data.pcDraft || { ...remote.settings }
      this.setData({ pcTab: tab, pcDraft: draft, pcPreview: this._pcPreview(draft),
        ...(this.data.pcDraft ? {} : { pcChangedFields: [], pcResetDraft: false,
          pcManual: Object.fromEntries((remote.settingFields || []).map(field => [field, true])) }) })
    },
    _pcPreview(draft) {
      const sample = (examples[draft.tone] || examples.warm)[draft.comfort === 'suggest' ? 'suggest' : 'listen']
      return (draft.address ? draft.address + '，' : '') + sample
    },
    pcEdit(e) {
      const { key, value } = e.currentTarget.dataset
      const draft = { ...this.data.pcDraft, [key]: e.detail?.value ?? value }
      this.setData({ pcDraft: draft, pcPreview: this._pcPreview(draft),
        pcChangedFields: [...new Set([...this.data.pcChangedFields, key])], pcManual: { ...this.data.pcManual, [key]: true } })
    },
    pcMore() { this.setData({ pcMore: !this.data.pcMore }) },
    pcGrowth() { this.setData({ pcGrowth: !this.data.pcGrowth }) },
    pcReset() {
      const remote = this._pcCurrent.remote
      const draft = { ...remote.defaults, ...(remote.growth?.status === 'started' && { address: remote.settings.address }) }
      this.setData({ pcDraft: draft, pcPreview: this._pcPreview(draft), pcChangedFields: [], pcResetDraft: true, pcManual: {} })
    },
    async _pcChange(session, data) {
      if (!session.remote || session.changing || session.unavailable) return false
      session.changing = true
      session.changeVersion = (session.changeVersion || 0) + 1
      if (matches(this, session)) this.setData({ pcSaving: true })
      try {
        const result = await cloudApi.petChatChange({ ...data, pet_id: session.id, generation: session.remote.generation })
        if (owner() !== session.owner) return false
        accept(session, result)
        session.error = ''
        if (data.action === 'clear') session.input = ''
        persist(session)
        show(this, session, true)
        return true
      } catch (error) {
        if (matches(this, session)) wx.showToast({ title: readable(error), icon: 'none' })
        return false
      } finally {
        session.changing = false
        if (matches(this, session)) this.setData({ pcSaving: false })
        if (data.action === 'settings') this._pcSchedule(session)
      }
    },
    async pcSave() {
      const session = this._pcCurrent
      if (!session?.remote || !this.data.pcDraft) return
      if (await this._pcChange(session, { action: 'settings', revision: session.remote.settingsRevision, settings: this.data.pcDraft,
        changed_fields: this.data.pcChangedFields, reset: this.data.pcResetDraft })) {
        if (matches(this, session)) {
          this.pcClose()
          wx.showToast({ title: '已保存，下轮生效', icon: 'success' })
        }
      }
    },
    pcCorrectHabit(e) {
      const session = this._pcCurrent
      const current = session?.remote?.growth
      const { slot, value } = e.currentTarget.dataset
      if (!current || !Object.prototype.hasOwnProperty.call(habitOptions, slot)) return
      const options = habitOptions[slot].filter(option => option[0] !== value)
      wx.showActionSheet({ itemList: options.map(option => option[1]), success: ({ tapIndex }) => {
        if (matches(this, session) && options[tapIndex]) this._pcChange(session, {
          action: 'habit_correct', slot, value: options[tapIndex][0], growth_revision: current.revision,
        })
      } })
    },
    pcRemoveHabit(e) {
      const session = this._pcCurrent
      const current = session?.remote?.growth
      if (!current) return
      const slot = e.currentTarget.dataset.slot
      wx.showModal({ title: '撤回这个习惯？', content: '它会从新的相处开始重新学习这一项。', confirmText: '撤回', success: result => {
        if (result.confirm && matches(this, session)) this._pcChange(session, { action: 'habit_remove', slot, growth_revision: current.revision })
      } })
    },
    pcOpenNote(e) {
      const session = this._pcCurrent
      if (session?.remote && !session.unavailable) this.setData({ pcPanel: 'note',
        pcNoteSource: e?.currentTarget?.dataset?.turn || session.remote.note?.sourceTurn || '',
        pcNoteInput: String(e?.currentTarget?.dataset?.text || session.remote.note?.text || '').slice(0, 140) })
    },
    pcNoteInput(e) { this.setData({ pcNoteInput: e.detail.value }) },
    async pcSaveNote(e) {
      const session = this._pcCurrent
      if (!session?.remote) return
      if (await this._pcChange(session, { action: 'note', revision: session.remote.noteRevision,
        text: this.data.pcNoteInput, source_turn: this.data.pcNoteSource, remove: e.currentTarget.dataset.remove === true })) {
        if (matches(this, session)) this.pcClose()
      }
    },
    pcClear() {
      const session = this._pcCurrent
      if (!session?.remote) return
      wx.showModal({ title: '清空这只宠物的聊天？', content: '近期消息、待发文字和未养成的线索将清除。已学会的习惯、相处设置和待续单独保留。',
        confirmText: '清空', success: async result => {
          if (result.confirm && matches(this, session) && await this._pcChange(session, { action: 'clear' }) && matches(this, session)) this.pcClose()
        } })
    },

    pcInput(e) {
      const session = this._pcCurrent
      if (!session) return
      session.input = e.detail.value
      this.setData({ pcInput: session.input })
      persist(session)
      if (session.timer) this._pcSchedule(session)
    },
    pcKeyboardChange(e) {
      const session = this._pcCurrent
      if (!session || !matches(this, session)) return
      const height = Number(e.detail?.height)
      if (!Number.isFinite(height) || height < 0 || height === this.data.pcKeyboard) return
      this.setData({ pcKeyboard: height }, () => {
        if (height && this.data.pcKeyboard === height) show(this, session, true)
      })
    },
    pcKeyboardClose() { if (this.data.pcKeyboard) this.setData({ pcKeyboard: 0 }) },
    pcToggleListen() {
      const session = this._pcCurrent
      if (!session?.remote || session.unavailable) return
      session.listening = !session.listening
      if (session.listening) {
        clearTimeout(session.timer)
        session.timer = null
        session.batchStart = 0
        session.batchDeadline = 0
        session.held.push(...session.queue.splice(0))
      } else {
        session.queue.push(...session.held.splice(0))
        session.reviewQueue = false
        if (editingFailed(session)) this._pcSendEdited(session)
        else this._pcSchedule(session, true)
      }
      persist(session)
      show(this, session, true)
    },
    pcSend() {
      const session = this._pcCurrent
      const text = session?.input.trim()
      if (!session?.remote || needsIntro(session.remote) || session.unavailable) return
      const editing = editingFailed(session)
      if (editing && !session.listening && !session.flight && !session.request && !session.changing) {
        return this._pcSendEdited(session, text)
      }
      const batch = session.listening ? session.held : session.queue
      if (!text || batch.length >= 12) {
        if (!session.listening && session.queue.length && !session.flight && !session.request && !session.remote.pending) {
          session.reviewQueue = false
          persist(session)
          return this._pcSchedule(session, true)
        }
        if (text) wx.showToast({ title: '请先处理前面的消息', icon: 'none' })
        return
      }
      batch.push(text)
      session.reviewQueue = false
      session.input = ''
      persist(session)
      show(this, session, true)
      if (!session.listening) this._pcSchedule(session, /[?？]$|^请问/.test(text))
    },
    _pcSendEdited(session, text = '') {
      const failed = editingFailed(session)
      if (!failed || session.flight || session.request || session.changing) return
      const room = 12 - failed.messages.length
      if (text && session.queue.length < room) {
        session.queue.push(text)
        session.input = ''
      }
      session.request = { id: requestId(), replace: failed.id, messages: [...failed.messages, ...session.queue.splice(0, room)] }
      session.editFailed = ''
      session.reviewQueue = false
      return this._pcSendRequest(session)
    },
    _pcSchedule(session, direct = false) {
      if (!matches(this, session) || !session.remote || needsIntro(session.remote) || session.unavailable || session.flight || session.changing || session.request || session.reviewQueue ||
          session.remote?.pending || session.listening || !session.queue.length) return
      clearTimeout(session.timer)
      session.batchStart ||= Date.now()
      const composing = !!session.input.trim()
      session.batchDeadline ||= session.batchStart + 1300
      if (composing) session.batchDeadline = session.batchStart + 2500
      if (direct || session.remote.settings.pace === 'quick') return this._pcFlush(session)
      const wait = Math.min(composing ? 1200 : 800, session.batchDeadline - Date.now())
      session.timer = setTimeout(() => {
        session.timer = null
        this._pcFlush(session)
      }, Math.max(0, wait))
    },
    _pcFlush(session) {
      if (!matches(this, session) || !session.remote || session.unavailable || session.changing || session.listening || session.flight || session.request || session.reviewQueue || !session.queue.length || session.remote.pending) return
      session.batchStart = 0
      session.batchDeadline = 0
      clearTimeout(session.timer)
      session.timer = null
      session.request = { id: requestId(), messages: session.queue.splice(0, 12) }
      return this._pcSendRequest(session)
    },
    async _pcSendRequest(session) {
      if (!matches(this, session) || session.unavailable || session.flight || !session.request) return
      const request = session.request
      const generation = session.remote.generation
      session.flight = true
      session.retryOriginal = false
      session.changeVersion = (session.changeVersion || 0) + 1
      session.error = ''
      persist(session)
      show(this, session, true)
      try {
        const result = await cloudApi.petChatSend({ pet_id: session.id, generation, request_id: request.id,
          messages: request.messages, replace_id: request.replace, with_facts: request.withFacts, goal_id: request.goal,
          ...(session.remote.growth && { growth_v1: true }) })
        if (owner() === session.owner && session.remote?.generation === generation) {
          accept(session, result)
          if (matches(this, session) && result.settings.expression !== 'off' && result.turns.some(turn => turn.id === request.id)) {
            clearTimeout(session.reaction)
            session.reaction = setTimeout(() => { session.reaction = null; show(this, session) }, 1100)
            this.selectComponent?.('#pc-portrait')?.react()
          }
        }
      } catch (error) {
        if (session.remote?.generation === generation) {
          if (missingAction(error, 'petChatSend')) {
            session.unavailable = true
            session.error = upgradeMessage + ' 本次消息已留在本机。'
          } else session.error = '发送结果未确认 · ' + readable(error)
        }
      } finally {
        session.flight = false
        show(this, session, true)
        this._pcWatchReply(session)
        this._pcSchedule(session)
      }
    },
    async pcCheck() {
      const session = this._pcCurrent
      if (!session || session.flight) return
      try { if (!await this._pcRefresh(session)) return }
      catch (error) { this._pcReadError(session, error); return }
      if (!matches(this, session)) return
      if (session.request && (!session.remote?.pending || session.remote.pending.id === session.request.replace)) {
        session.error = '尚未查到回执，可用原编号重试'
        session.retryOriginal = true
        show(this, session)
        return
      }
      this._pcSchedule(session)
    },
    pcRetry() {
      const session = this._pcCurrent
      if (!session?.remote || session.unavailable || session.flight) return
      if (session.retryOriginal && session.request) return this._pcSendRequest(session)
      const pending = session.remote.pending
      if (pending?.status === 'failed') {
        if (session.request) return
        session.request = { id: requestId(), messages: pending.messages, replace: pending.id,
          withFacts: pending.withFacts, goal: pending.goalId }
      } else if (!session.retryOriginal) return
      if (session.request) return this._pcSendRequest(session)
    },
    pcRevise() {
      const session = this._pcCurrent
      const pending = session?.remote?.pending
      if (pending?.status !== 'failed' || session.flight || session.request || session.changing) return
      session.editFailed = pending.id
      session.error = ''
      persist(session)
      show(this, session, true)
    },
    pcForest() { wx.switchTab({ url: '/pages/pets/pets' }) },
    pcConfig() { wx.navigateTo({ url: '/pages/ai-config/ai-config' }) },
  }
  return { methods, data: {
    pcPets: [], pcCanChoose: false, pcScreen: 'picker', pcPickerIndex: 0, pcPet: null, pcTurns: [], pcPending: [], pcQueue: [], pcHeld: [], pcInput: '', pcListen: false,
    pcLoading: false, pcLoadError: '', pcUpgrade: '', pcReady: false, pcStatus: '', pcCanCheck: false, pcCanRetry: false, pcCanRevise: false,
    pcSending: false, pcNeedsConfig: false, pcAnimate: false, pcKeyboard: 0, pcHeadCollapsed: false, pcAnchor: '', pcPanel: '', pcTab: 'profile', pcMore: false, pcGrowth: false,
    pcSettings: null, pcDraft: null, pcPreview: '', pcBasicGroups: groups.slice(0, 4), pcMoreGroups: groups.slice(4), pcSaving: false,
    pcMeet: '', pcMeetAddress: '你', pcMeetCustom: '', pcFirstLine: '', pcBondGrowth: null, pcChangedFields: [], pcResetDraft: false, pcManual: {},
    pcNote: null, pcNoteInput: '', pcNoteSource: '',
  } }
}

module.exports = { createWorkspace }
