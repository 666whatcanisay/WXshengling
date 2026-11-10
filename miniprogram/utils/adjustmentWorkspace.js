const { describe } = require('./adjustmentPresentation')
const { accountScope } = require('./userSession')
const STATUS = { ready: '可以继续', running: '当前步骤处理中', failed: '本步未完成', cancelled: '已取消', awaiting_review: '草案与检查已保存', applied: '已应用到正式任务' }
const LABELS = { manager: '森林管家', planner: '调整规划师', rules: '代码规则检查', review: 'AI审核师' }
function sameSuggestion(a, b) {
  if (!a || !b) return !a && !b
  return a.report_id === b.report_id && a.fingerprint === b.fingerprint && a.index === b.index
}
function resolveSuggestion(workspace, reference) {
  const snapshot = workspace?.snapshot, report = snapshot?.report
  if (!reference || !report || report.id !== reference.report_id || snapshot.coach_fingerprint !== reference.fingerprint) return null
  const item = report.analysis?.suggestions?.[reference.index]
  return item ? { ...item, reference } : null
}
function createWorkspace({ wx, getApp, cloudApi }) {
  const scope = () => accountScope(getApp().globalData)
  const context = p => JSON.stringify([scope(), p.data.currentGoal && p.data.currentGoal.id, p.data.coachSummaryDate || p.data.today])
  const key = p => 'forest_adjustment_input_v2:' + context(p)
  const applicationKey = p => key(p) + ':application'
  const requestId = () => 'adjust_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
  const errorText = e => String(e && (e.message || e.errMsg) || e || '请求结果待确认，请刷新查询')
  return {
    data: { adjustmentWorkspace: null, adjustmentRun: null, adjustmentLoading: false, adjustmentBusy: '', adjustmentError: '',
      adjustmentInstructions: '', adjustmentMinutes: '', adjustmentEdits: [], adjustmentDirty: false, adjustmentInputChanged: false, adjustmentConflict: false, adjustmentBackup: false,
      adjustmentShowInputs: false, adjustmentShowDetails: false, adjustmentShowComparison: false, adjustmentPendingApplication: null, adjustmentApplicationReceipt: null, adjustmentApplicationChecked: false, adjustmentShowMore: false, adjustmentFlow: describe({}),
      adjustmentSuggestion: null },
    methods: {
      setAdjustmentData(patch, callback) {
        const next = { ...this.data, ...patch }
        next.adjustmentSuggestionChanged = !!(next.adjustmentInputChanged && next.adjustmentRun &&
          !sameSuggestion(next.adjustmentSuggestion?.reference, next.adjustmentRun.requirements?.coach_suggestion?.reference))
        this.setData({ ...patch, adjustmentSuggestionChanged: next.adjustmentSuggestionChanged,
          adjustmentFlow: describe(next, this._adjustmentContext === context(this)) }, callback)
      },
      refreshAdjustmentFlow() { this.setAdjustmentData({}) },
      toggleAdjustmentMore() { this.setAdjustmentData({ adjustmentShowMore: !this.data.adjustmentShowMore }) },
      openAdjustmentGoals() { this._goalPickerReturnTab = 'summary'; this.setData({ goalPickerOpen: true }) },
      toggleAdjustmentComparison() { this.setData({ adjustmentShowComparison: !this.data.adjustmentShowComparison }) },
      scrollAdjustmentComparison() {
        if (this.data.adjustmentShowComparison) return this.scrollAdjustmentTo('#adjustment-comparison')
        this.setData({ adjustmentShowComparison: true }, () => this.scrollAdjustmentTo('#adjustment-comparison'))
      },
      scrollAdjustmentTo(selector) {
        const fallback = () => wx.showToast({ title: '请向下查看调整内容', icon: 'none' })
        if (typeof wx.pageScrollTo !== 'function') return fallback()
        wx.pageScrollTo({ selector, duration: 200, fail: fallback })
      },
      showAdjustmentRequirements() {
        this.setAdjustmentData({ adjustmentShowInputs: true }, () => this.scrollAdjustmentTo('#adjustment-requirements'))
      },
      handleAdjustmentNext() {
        const flow = describe(this.data, this._adjustmentContext === context(this))
        this.setAdjustmentData({})
        if (flow.disabled) return
        const actions = { choose: 'openAdjustmentGoals', refresh: 'loadAdjustment', query: 'queryAdjustmentApplication', retry: 'submitAdjustmentApplication', save: 'saveAdjustmentEdits', readCloud: 'readAdjustmentCloud', start: 'startAdjustment', cancel: 'cancelAdjustment', requirements: 'showAdjustmentRequirements', continue: 'continueAdjustment', check: 'checkAdjustmentRules', compare: 'scrollAdjustmentComparison', apply: 'confirmAdjustmentApplication' }
        if (actions[flow.action]) return this[actions[flow.action]]()
      },
      toggleAdjustmentInputs() { this.setAdjustmentData({ adjustmentShowInputs: !this.data.adjustmentShowInputs }) },
      toggleAdjustmentDetails() { this.setAdjustmentData({ adjustmentShowDetails: !this.data.adjustmentShowDetails }) },
      markAdjustmentEditBase() {
        if (!this.data.adjustmentDirty) this._adjustmentEditBase = this.data.adjustmentRun ? { id: this.data.adjustmentRun.id, revision: this.data.adjustmentRun.revision } : null
      },
      pauseAdjustment() { this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1; this.setAdjustmentData({ adjustmentLoading: false, adjustmentBusy: '' }) },
      cacheAdjustment() {
        if (this._adjustmentContext !== context(this)) return false
        try {
          const base = this.data.adjustmentDirty ? this._adjustmentEditBase : this.data.adjustmentRun
          wx.setStorageSync(key(this), { instructions: this.data.adjustmentInstructions, minutes: this.data.adjustmentMinutes,
            edits: this.data.adjustmentEdits, run_id: base && base.id,
            revision: base && base.revision, dirty: this.data.adjustmentDirty, inputChanged: this.data.adjustmentInputChanged,
            suggestion: this.data.adjustmentSuggestion })
          return true
        } catch (_) { this.setAdjustmentData({ adjustmentError: '本机保存失败，请先保留输入，暂未提交云端。' }); return false }
      },
      showAdjustmentRun(run) {
        this.setAdjustmentData({ adjustmentRun: run ? { ...run, statusLabel: STATUS[run.status] || run.status,
          beforeById: (run.diff || []).reduce((map, d) => ({ ...map, [d.task_id || d.after.task_id]: d.before }), {}),
          stepLabels: Object.entries(LABELS).map(([name, label]) => ({ name, label, status: run.steps[name] ? run.steps[name].status === 'done' ? '已完成' : run.steps[name].status === 'skipped' ? '本轮跳过' : '处理中 / 结果待确认' : name === 'planner' && run.revision > 1 || name === 'review' && run.status === 'awaiting_review' && !run.review ? '本轮跳过' : '等待执行' })) } : null })
        if (run && !run.application && this.data.adjustmentApplicationReceipt && this.data.adjustmentApplicationReceipt.run_id !== run.id) this.setAdjustmentData({ adjustmentApplicationReceipt: null })
        if (run && run.application) this.acceptAdjustmentApplication(run.application)
        else if (run && run.status === 'cancelled' && this.data.adjustmentPendingApplication && this.data.adjustmentPendingApplication.run_id === run.id) this.clearAdjustmentApplication()
      },
      async loadAdjustment() {
        if (typeof cloudApi.getAdjustmentWorkspace !== 'function') return
        const ctx = context(this)
        if (!this.ownsWorkspace() || !this.data.currentGoal) { this.pauseAdjustment(); this._adjustmentContext = ''; this.setAdjustmentData({ adjustmentWorkspace: null, adjustmentRun: null }); return }
        if (this._adjustmentContext !== ctx) {
          this.pauseAdjustment(); this._adjustmentContext = ctx
          this._adjustmentEditBase = null
          this.setAdjustmentData({ adjustmentWorkspace: null, adjustmentRun: null, adjustmentInstructions: '', adjustmentMinutes: '', adjustmentEdits: [],
            adjustmentDirty: false, adjustmentInputChanged: false, adjustmentConflict: false, adjustmentBackup: false, adjustmentError: '',
            adjustmentShowInputs: false, adjustmentShowDetails: false, adjustmentShowComparison: false, adjustmentShowMore: false, adjustmentApplicationChecked: false, adjustmentSuggestion: null })
          this.setAdjustmentData({ adjustmentPendingApplication: null, adjustmentApplicationReceipt: null })
          try {
            const saved = wx.getStorageSync(key(this))
            this.setAdjustmentData({ adjustmentPendingApplication: wx.getStorageSync(applicationKey(this)) || null })
            this._adjustmentLocal = saved || null
            this.setAdjustmentData({ adjustmentBackup: !!wx.getStorageSync(key(this) + ':backup') })
            if (saved && saved.dirty) this._adjustmentEditBase = { id: saved.run_id, revision: saved.revision }
            if (saved) this.setAdjustmentData({ adjustmentInstructions: saved.instructions || '', adjustmentMinutes: saved.minutes || '',
              adjustmentEdits: saved.edits || [], adjustmentDirty: !!saved.dirty, adjustmentInputChanged: !!saved.inputChanged, adjustmentShowInputs: !!saved.inputChanged,
              adjustmentSuggestion: saved.suggestion || null })
          } catch (_) { this.setAdjustmentData({ adjustmentError: '本机输入读取失败，先保留原文再重试。' }); return }
        }
        if (this.data.adjustmentBusy) return
        const epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        this.setAdjustmentData({ adjustmentLoading: true, adjustmentError: '' })
        try {
          const w = await cloudApi.getAdjustmentWorkspace({ goal_id: this.data.currentGoal.id, date: this.data.coachSummaryDate || this.data.today })
          if (!valid()) return
          const cached = this._adjustmentLocal, previous = this.data.adjustmentRun
          const base = this._adjustmentEditBase || previous || cached && { id: cached.run_id, revision: cached.revision }
          const changed = !!(this.data.adjustmentDirty && (!w.run || !base || base.id !== w.run.id || base.revision !== w.run.revision))
          this.setAdjustmentData({ adjustmentWorkspace: w, adjustmentConflict: changed })
          this.showAdjustmentRun(w.run)
          const selected = this.data.adjustmentSuggestion || (!this.data.adjustmentInputChanged && w.run?.requirements?.coach_suggestion) || null
          const resolved = selected && resolveSuggestion(w, selected.reference)
          this.setAdjustmentData({ adjustmentSuggestion: resolved || (selected ? { ...selected, stale: true } : null) })
          if (w.run && !this.data.adjustmentDirty) this.setAdjustmentData({ adjustmentEdits: w.run.changes || [],
            ...(!this.data.adjustmentInputChanged ? { adjustmentInstructions: w.run.requirements.instructions, adjustmentMinutes: w.run.requirements.daily_minutes === null ? '' : String(w.run.requirements.daily_minutes) } : {}) })
          // An interrupted generation may leave the input cache marked changed.
          // Reconcile against this exact cloud version before offering a save/apply.
          if (w.run && !this.data.adjustmentDirty && this.data.adjustmentInputChanged && w.run.is_current &&
            sameSuggestion(this.data.adjustmentSuggestion?.reference, w.run.requirements.coach_suggestion?.reference) &&
            w.run.changes && ['awaiting_review', 'failed'].includes(w.run.status)) {
            const same = this.data.adjustmentInstructions === w.run.requirements.instructions &&
              String(this.data.adjustmentMinutes) === (w.run.requirements.daily_minutes === null ? '' : String(w.run.requirements.daily_minutes))
            this._adjustmentEditBase = same ? null : { id: w.run.id, revision: w.run.revision }
            this.setAdjustmentData({ adjustmentInputChanged: !same, adjustmentDirty: !same })
            this.cacheAdjustment()
          }
          this._adjustmentLocal = null
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentWorkspace: null, adjustmentError: errorText(e) }) }
        finally {
          if (valid()) {
            this.setAdjustmentData({ adjustmentLoading: false })
            const pending = this._pendingCoachSuggestion
            if (pending && pending.scope === scope() && pending.goalId === this.data.currentGoal.id && pending.date === (this.data.coachSummaryDate || this.data.today) && this.data.adjustmentWorkspace) {
              this._pendingCoachSuggestion = null
              this.selectAdjustmentSuggestion(pending.reference)
            }
          }
        }
      },
      selectAdjustmentSuggestion(reference) {
        if (this._adjustmentContext !== context(this) || this.data.adjustmentLoading || this.data.adjustmentBusy ||
          this.data.adjustmentPendingApplication || this.data.adjustmentDirty || ['ready', 'running'].includes(this.data.adjustmentRun?.status)) {
          return this.setAdjustmentData({ adjustmentError: '请先处理当前调整或本机改稿，再选择教练建议。' })
        }
        const suggestion = reference && resolveSuggestion(this.data.adjustmentWorkspace, reference)
        if (reference && !suggestion) return this.setAdjustmentData({ adjustmentError: '这条教练建议已变化，请刷新复盘后重新选择。' })
        this.setAdjustmentData({ adjustmentSuggestion: suggestion || null, adjustmentInputChanged: true, adjustmentShowInputs: true, adjustmentError: '',
          ...(suggestion && !this.data.adjustmentInstructions.trim() ? { adjustmentInstructions: suggestion.action } : {}) })
        this.cacheAdjustment()
        this.scrollAdjustmentTo('#adjustment-requirements')
      },
      removeAdjustmentSuggestion() { return this.selectAdjustmentSuggestion(null) },
      onAdjustmentInstructions(e) {
        if (this.data.adjustmentPendingApplication) return
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        if (this.data.adjustmentRun && ['ready', 'running'].includes(this.data.adjustmentRun.status)) return
        this.markAdjustmentEditBase()
        this.setAdjustmentData({ adjustmentInstructions: e.detail.value.slice(0, 1200), adjustmentInputChanged: true,
          adjustmentDirty: this.data.adjustmentDirty || this.canEditAdjustmentInputs() }); this.cacheAdjustment()
      },
      onAdjustmentMinutes(e) {
        if (this.data.adjustmentPendingApplication) return
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        if (this.data.adjustmentRun && ['ready', 'running'].includes(this.data.adjustmentRun.status)) return
        this.markAdjustmentEditBase()
        this.setAdjustmentData({ adjustmentMinutes: String(e.detail.value).slice(0, 5), adjustmentInputChanged: true,
          adjustmentDirty: this.data.adjustmentDirty || this.canEditAdjustmentInputs() }); this.cacheAdjustment()
      },
      canEditAdjustmentInputs() {
        const run = this.data.adjustmentRun
        return !!(run?.changes && run.is_current && ['awaiting_review', 'failed'].includes(run.status) &&
          sameSuggestion(this.data.adjustmentSuggestion?.reference, run.requirements?.coach_suggestion?.reference))
      },
      onAdjustmentEdit(e) {
        if (this.data.adjustmentPendingApplication || this.data.adjustmentSuggestionChanged) return
        const { index, field } = e.currentTarget.dataset
        if (this.data.adjustmentBusy || !['title', 'date', 'estimated_minutes', 'reason'].includes(field) || this._adjustmentContext !== context(this)) return
        if (!this.data.adjustmentRun || !this.data.adjustmentRun.is_current || !['awaiting_review', 'failed'].includes(this.data.adjustmentRun.status)) return
        const edits = this.data.adjustmentEdits.map(c => ({ ...c })), item = edits[Number(index)]
        if (!item) return
        this.markAdjustmentEditBase()
        item[field] = field === 'estimated_minutes' ? Number(e.detail.value) : String(e.detail.value).slice(0, field === 'reason' ? 400 : field === 'title' ? 200 : 10)
        this.setAdjustmentData({ adjustmentEdits: edits, adjustmentDirty: true }); this.cacheAdjustment()
      },
      keepAdjustmentOriginal(e) {
        if (this.data.adjustmentPendingApplication || this.data.adjustmentSuggestionChanged) return
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this) || !this.data.adjustmentRun || !this.data.adjustmentRun.is_current) return
        if (!['awaiting_review', 'failed'].includes(this.data.adjustmentRun.status)) return
        const index = Number(e.currentTarget.dataset.index)
        if (!Number.isInteger(index) || index < 0 || index >= this.data.adjustmentEdits.length) return
        this.markAdjustmentEditBase()
        this.setAdjustmentData({ adjustmentEdits: this.data.adjustmentEdits.filter((_, i) => i !== index), adjustmentDirty: true }); this.cacheAdjustment()
      },
      async startAdjustment() {
        if (this.data.adjustmentPendingApplication) return this.setAdjustmentData({ adjustmentError: '上次应用结果待确认，请先查询回执。' })
        if (this.data.adjustmentBusy || this.data.adjustmentLoading || !this.data.adjustmentWorkspace || !this.data.currentGoal || !this.cacheAdjustment()) return
        const w = this.data.adjustmentWorkspace
        if (!w.snapshot.eligible) return this.setAdjustmentData({ adjustmentError: w.snapshot.blocked_reason })
        if (this.data.adjustmentDirty) return this.setAdjustmentData({ adjustmentError: '本机还有草案修改，请先保存，或备份后读取云稿。' })
        if (!w.snapshot.complete || !w.snapshot.tasks.length) return this.setAdjustmentData({ adjustmentError: '没有可调整任务或超过首版20项范围，未调用模型。' })
        const suggestion = this.data.adjustmentSuggestion
        if (suggestion && !resolveSuggestion(w, suggestion.reference)) return this.setAdjustmentData({ adjustmentError: '这条教练建议已变化，请重新选择或移除。' })
        const minutes = this.data.adjustmentMinutes
        if (!this.data.adjustmentInstructions.trim() || minutes !== '' && (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 1440)) return this.setAdjustmentData({ adjustmentError: '请填写本轮调整要求；可用分钟未知可留空。' })
        return this.mutateAdjustment('建立调整草案', () => cloudApi.startAdjustment({ goal_id: this.data.currentGoal.id, date: this.data.coachSummaryDate || this.data.today,
          fingerprint: w.fingerprint, instructions: this.data.adjustmentInstructions, daily_minutes: minutes, request_id: requestId(),
          ...(suggestion ? { coach_suggestion: suggestion.reference } : {}) }), true)
      },
      async mutateAdjustment(label, work, advance = false) {
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        const ctx = context(this), epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        this.setAdjustmentData({ adjustmentBusy: label, adjustmentError: '' })
        try {
          const result = await work()
          if (!valid()) return
          this.showAdjustmentRun(result.run)
          this.setAdjustmentData({ adjustmentEdits: result.run.changes || [], adjustmentDirty: false, adjustmentInputChanged: false, adjustmentConflict: false, adjustmentShowInputs: false })
          this._adjustmentEditBase = null
          this.cacheAdjustment()
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentError: errorText(e) + '；先刷新查询结果，不重复发起模型请求。' }); advance = false }
        finally { if (valid()) this.setAdjustmentData({ adjustmentBusy: '' }) }
        if (valid() && advance) return this.continueAdjustment()
      },
      async continueAdjustment() {
        if (this.data.adjustmentPendingApplication) return
        let run = this.data.adjustmentRun
        if (!run || this.data.adjustmentBusy || this.data.adjustmentDirty || !run.is_current || run.status !== 'ready' && !(run.status === 'running' && run.can_recover)) return
        const ctx = context(this), epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        this.setAdjustmentData({ adjustmentBusy: '分步规划与审核', adjustmentError: '' })
        try {
          for (let i = 0; i < 6 && valid(); i++) {
            const response = await cloudApi.stepAdjustment({ run_id: run.id, request_id: requestId() })
            if (!valid()) return
            run = response.run; this.showAdjustmentRun(run)
            this.setAdjustmentData({ adjustmentEdits: run.changes || [] }); this.cacheAdjustment()
            if (run.status !== 'ready' || !run.is_current) break
          }
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentError: errorText(e) + '；刷新查询，不自动重新调用模型。' }) }
        finally { if (valid()) this.setAdjustmentData({ adjustmentBusy: '' }) }
      },
      saveAdjustmentEdits() {
        if (this.data.adjustmentPendingApplication || this.data.adjustmentSuggestionChanged) return
        const run = this.data.adjustmentRun
        if (!run || !run.is_current || !this.data.adjustmentDirty || this.data.adjustmentConflict || !this.cacheAdjustment()) return
        return this.mutateAdjustment('保存新版本', () => cloudApi.saveAdjustment({ run_id: run.id, expected_revision: run.revision,
          changes: this.data.adjustmentEdits, instructions: this.data.adjustmentInstructions, daily_minutes: this.data.adjustmentMinutes }))
      },
      cancelAdjustment() {
        const run = this.data.adjustmentRun
        if (!run || !this.cacheAdjustment()) return
        if (this.data.adjustmentDirty) return this.setAdjustmentData({ adjustmentError: '本机修改已保留，请先保存或备份后读取云稿，再取消协作。' })
        this.pauseAdjustment()
        return this.mutateAdjustment('取消后续调整', () => cloudApi.cancelAdjustment({ run_id: this.data.adjustmentPendingApplication ? this.data.adjustmentPendingApplication.run_id : run.id }))
      },
      checkAdjustmentRules() {
        const run = this.data.adjustmentRun
        if (!run || !run.is_current || this.data.adjustmentPendingApplication || this.data.adjustmentDirty || this.data.adjustmentConflict || this.data.adjustmentLoading || this.data.adjustmentBusy) return
        return this.mutateAdjustment('检查当前版本规则', () => cloudApi.checkAdjustment({ run_id: run.id, expected_revision: run.revision, confirmation: run.confirmation }))
      },
      clearAdjustmentApplication() {
        this.setAdjustmentData({ adjustmentPendingApplication: null, adjustmentApplicationChecked: false })
        try { wx.removeStorageSync(applicationKey(this)) }
        catch (_) { this.setAdjustmentData({ adjustmentError: '回执已核对，本机确认缓存清理失败；重进后可再次查询。' }) }
      },
      acceptAdjustmentApplication(receipt) {
        const pending = this.data.adjustmentPendingApplication, run = this.data.adjustmentRun
        if (!receipt || receipt.goal_id !== (this.data.currentGoal && this.data.currentGoal.id) ||
          pending && (receipt.run_id !== pending.run_id || receipt.revision !== pending.expected_revision || receipt.confirmation !== pending.confirmation) ||
          !pending && (!run || receipt.run_id !== run.id || receipt.confirmation !== run.confirmation)) throw Error('应用回执与本次确认不一致，请保留状态后查询')
        this.setAdjustmentData({ adjustmentApplicationReceipt: receipt })
        this.clearAdjustmentApplication()
      },
      async confirmAdjustmentApplication() {
        const run = this.data.adjustmentRun
        if (!run || !run.can_apply || !run.is_current || this.data.adjustmentDirty || this.data.adjustmentConflict || this.data.adjustmentInputChanged || this.data.adjustmentPendingApplication || this.data.adjustmentLoading || this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        const ctx = context(this), epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        const request = { run_id: run.id, expected_revision: run.revision, confirmation: run.confirmation }
        this.setAdjustmentData({ adjustmentBusy: '等待你确认', adjustmentError: '' })
        let answer
        try {
          answer = await new Promise((resolve, reject) => wx.showModal({ title: '确认应用第' + run.revision + '版？',
            content: run.diff.map(d => d.before.title + ' → ' + d.after.title + '；' + d.after.date + '，' + d.after.estimated_minutes + '分钟').join('\n').slice(0, 1400) + '\n共' + run.changes.length + '项。仅修改名称、日期和预计分钟，不改完成记录或奖励。', confirmText: '确认应用', success: resolve, fail: reject }))
          if (!valid() || !answer.confirm) return
          // Persist the exact envelope before sending. Re-entry may query or
          // explicitly retry this version, but never silently submit another.
          wx.setStorageSync(applicationKey(this), request)
          this.setAdjustmentData({ adjustmentPendingApplication: request, adjustmentApplicationChecked: false })
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentError: errorText(e) + '；尚未提交应用。' }); return }
        finally { if (valid()) this.setAdjustmentData({ adjustmentBusy: '' }) }
        if (valid() && answer.confirm) return this.submitAdjustmentApplication()
      },
      async submitAdjustmentApplication() {
        const request = this.data.adjustmentPendingApplication
        if (!request || this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        const ctx = context(this), epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        this.setAdjustmentData({ adjustmentBusy: '提交确认版本', adjustmentLoading: false, adjustmentError: '' })
        try {
          const result = await cloudApi.applyAdjustment(request)
          if (!valid()) return
          this.acceptAdjustmentApplication(result.application)
          // A pending confirmation can be restored even when the draft read
          // failed. Accept its receipt without inventing a partial run object.
          if (this.data.adjustmentRun && this.data.adjustmentRun.id === request.run_id) {
            this.showAdjustmentRun({ ...this.data.adjustmentRun, status: 'applied', application: result.application, can_apply: false })
          }
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentError: errorText(e) + '；应用结果待核对。先查询回执，不重新生成或改稿。' }) }
        finally { if (valid()) this.setAdjustmentData({ adjustmentBusy: '' }) }
        if (valid() && this.data.adjustmentApplicationReceipt) return this.loadAdjustment()
      },
      async queryAdjustmentApplication() {
        const request = this.data.adjustmentPendingApplication
        if (!request || this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        const ctx = context(this), epoch = this._adjustmentEpoch = (this._adjustmentEpoch || 0) + 1
        const valid = () => ctx === context(this) && epoch === this._adjustmentEpoch && !this._closed
        this.setAdjustmentData({ adjustmentBusy: '查询应用回执', adjustmentLoading: false, adjustmentApplicationChecked: false, adjustmentError: '' })
        try {
          const result = await cloudApi.getAdjustmentApplication(request)
          if (!valid()) return
          if (result.application) this.acceptAdjustmentApplication(result.application)
          else if (result.status === 'cancelled') this.clearAdjustmentApplication()
          else this.setAdjustmentData({ adjustmentApplicationChecked: true, adjustmentError: '' })
        } catch (e) { if (valid()) this.setAdjustmentData({ adjustmentError: errorText(e) }) }
        finally { if (valid()) this.setAdjustmentData({ adjustmentBusy: '' }) }
        if (valid() && !this.data.adjustmentPendingApplication) return this.loadAdjustment()
      },
      async readAdjustmentCloud() {
        if (this.data.adjustmentPendingApplication) return
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this) || !this.cacheAdjustment()) return
        try { wx.setStorageSync(key(this) + ':backup', wx.getStorageSync(key(this))) }
        catch (_) { return this.setAdjustmentData({ adjustmentError: '本机副本保存失败，未替换当前修改。' }) }
        this.setAdjustmentData({ adjustmentDirty: false, adjustmentInputChanged: false, adjustmentConflict: false, adjustmentBackup: true, adjustmentSuggestion: null })
        this._adjustmentEditBase = null
        return this.loadAdjustment()
      },
      restoreAdjustmentBackup() {
        if (this.data.adjustmentPendingApplication) return
        if (this.data.adjustmentBusy || this._adjustmentContext !== context(this)) return
        try {
          const saved = wx.getStorageSync(key(this) + ':backup')
          if (!saved) return this.setAdjustmentData({ adjustmentError: '没有本机副本' })
          this._adjustmentEditBase = { id: saved.run_id, revision: saved.revision }
          this.setAdjustmentData({ adjustmentInstructions: saved.instructions || '', adjustmentMinutes: saved.minutes || '', adjustmentEdits: saved.edits || [],
            adjustmentSuggestion: saved.suggestion || null,
            adjustmentDirty: true, adjustmentInputChanged: true, adjustmentConflict: !!(this.data.adjustmentRun && (saved.run_id !== this.data.adjustmentRun.id || saved.revision !== this.data.adjustmentRun.revision)),
            adjustmentError: '已恢复本机副本供核对；版本冲突时请先保留文字，再读取云稿后重填。' })
          this.cacheAdjustment()
        } catch (e) { this.setAdjustmentData({ adjustmentError: errorText(e) }) }
      }
    }
  }
}
module.exports = { createWorkspace }
