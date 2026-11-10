const { accountScope } = require('./userSession')
const LABELS = { ready: '可以继续', running: '正在处理', failed: '本步未完成', cancelled: '已取消', awaiting_confirmation: '等待你确认',
  publication_pending: '发布结果待确认', published: '已发布' }
const STEPS = { waiting: '尚未运行', running: '处理中', done: '已完成', skipped: '本次跳过', failed: '未完成', interrupted: '已停止等待' }
function createWorkspace({ cloudApi, getApp, navigation }) {
  const scope = () => accountScope(getApp().globalData)
  const requestId = () => 'steward_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
  const message = e => String(e && (e.message || e.errMsg) || e || '协作状态未确认，请刷新核对')
  return {
    data: { stewardRun: null, stewardBusy: '', stewardError: '', stewardUncertain: false,
      stewardBaseRevision: null, stewardHasDraft: false, stewardDraftTitle: '', stewardAvailable: false },
    methods: {
      showStewardRun(run) {
        this.setData({ stewardRun: run ? { ...run, statusLabel: LABELS[run.status] || '请核对状态',
          steps: run.steps.map(step => ({ ...step, statusLabel: STEPS[step.status] || '请核对状态' })) } : null,
          ...(run && run.is_current ? { stewardBaseRevision: run.draft_revision, stewardHasDraft: true, stewardDraftTitle: run.draft_title } : {}) })
      },
      pauseSteward() { this._stewardVisible = false; this._stewardEpoch = (this._stewardEpoch || 0) + 1 },
      async refreshSteward() {
        if (typeof cloudApi.getStewardRun !== 'function') return
        this._stewardVisible = true
        const id = scope(), epoch = this._stewardEpoch = (this._stewardEpoch || 0) + 1
        if (this._stewardScope !== id) {
          this._stewardScope = id
          this.setData({ stewardRun: null, stewardBaseRevision: null, stewardHasDraft: false, stewardDraftTitle: '' })
        }
        if (!id) return this.setData({ stewardAvailable: false, stewardBusy: '', stewardError: '请先登录', stewardUncertain: true })
        this.setData({ stewardBusy: '读取状态', stewardError: '' })
        try {
          const [result, current] = await Promise.all([cloudApi.getStewardRun(), cloudApi.getPlannerDraft()])
          if (id !== scope() || epoch !== this._stewardEpoch || !this._stewardVisible) return
          this.showStewardRun(result.run)
          this.setData({ stewardAvailable: true, stewardUncertain: false, stewardBaseRevision: current.revision,
            stewardHasDraft: !!current.draft, stewardDraftTitle: current.draft ? current.draft.snapshot.goal.title : '' })
        } catch (error) {
          if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardError: message(error), stewardUncertain: true })
        } finally { if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardBusy: '' }) }
      },
      startNewSteward() { return this.startSteward('new') },
      startDraftSteward() { return this.startSteward('draft') },
      async startSteward(mode) {
        if (this.data.stewardBusy || this.data.stewardUncertain || !this.data.stewardAvailable || !this.ownsWorkspace()) return
        if (this.data.stewardRun && ['ready', 'running', 'publication_pending'].includes(this.data.stewardRun.status)) return this.setData({ stewardError: '请先处理当前协作或核对发布结果。' })
        const demand = (this.data.demand || '').trim()
        if (mode === 'new' && !demand) return this.setData({ stewardError: '先在下方写明想完成的目标；不确定时也可以先到规划师聊聊。' })
        const id = scope(), epoch = this._stewardEpoch = (this._stewardEpoch || 0) + 1
        this.setData({ stewardBusy: '建立协作', stewardError: '' })
        try {
          const result = await cloudApi.startStewardRun({ mode, demand, expected_revision: this.data.stewardBaseRevision, request_id: requestId() })
          if (id !== scope() || epoch !== this._stewardEpoch || !this._stewardVisible) return
          this.showStewardRun(result.run); this.setData({ stewardBusy: '', stewardUncertain: false })
          return this.continueSteward()
        } catch (error) {
          if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardError: message(error), stewardUncertain: true })
        } finally { if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardBusy: '' }) }
      },
      async continueSteward() {
        const run = this.data.stewardRun
        if (!run || this.data.stewardBusy || this.data.stewardUncertain || !this._stewardVisible || !this.ownsWorkspace() || !['ready', 'failed', 'running'].includes(run.status)) return
        if (run.status === 'running' && !run.can_recover) return this.setData({ stewardError: '当前步骤可能仍在执行，请先刷新查询。' })
        const id = scope(), epoch = this._stewardEpoch = (this._stewardEpoch || 0) + 1
        this.setData({ stewardBusy: '执行协作', stewardError: '' })
        try {
          let current = run
          for (let i = 0; i < 6; i++) {
            if (id !== scope() || epoch !== this._stewardEpoch || !this._stewardVisible) return
            const result = await cloudApi.stepStewardRun({ run_id: current.id, request_id: requestId(), recover: current.status !== 'ready' })
            if (id !== scope() || epoch !== this._stewardEpoch || !this._stewardVisible) return
            current = result.run; this.showStewardRun(current)
            if (current.status !== 'ready') break
          }
        } catch (error) {
          if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardError: message(error), stewardUncertain: true })
        } finally { if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardBusy: '' }) }
      },
      async cancelSteward() {
        const run = this.data.stewardRun
        if (!run || !this.ownsWorkspace()) return
        const id = scope(), epoch = this._stewardEpoch = (this._stewardEpoch || 0) + 1
        this.setData({ stewardBusy: '取消协作', stewardError: '' })
        try {
          const result = await cloudApi.cancelStewardRun({ run_id: run.id })
          if (id === scope() && epoch === this._stewardEpoch && this._stewardVisible) this.showStewardRun(result.run)
        } catch (error) {
          if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardError: message(error), stewardUncertain: true })
        } finally { if (id === scope() && epoch === this._stewardEpoch) this.setData({ stewardBusy: '' }) }
      },
      openStewardDraft() {
        const run = this.data.stewardRun
        if (!this.ownsWorkspace() || !run || !run.is_current && run.status !== 'publication_pending') return
        if (run.handoff || run.status === 'publication_pending') {
          return navigation.openPartner('review', { stewardRunId: run.id, steward: run.handoff })
        }
        return navigation.openPartner('review', { refreshDraft: true })
      }
    }
  }
}
module.exports = { createWorkspace }
