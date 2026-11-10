const VERSION = 'planner-review-v1'
const same = (a, b) => !!a && !!b && ['draft_id', 'revision', 'fingerprint', 'requirements_revision', 'rules_version'].every(k => a[k] === b[k])
function createWorkspace({ cloudApi, publicationDraft }) {
  const scope = publicationDraft.accountScope
  return {
    data: { auditReady: false, auditBusy: '', auditError: '', auditExpired: false, auditRules: null, auditAI: null, auditUncertain: false },
    methods: {
      plannerReviewBinding() {
        if (!scope() || this.data.draftCloudState !== 'saved' || !this.data.cloudDraftId || !this.data.cloudDraftFingerprint ||
            this.data.publicationPending || this._pendingPublication || (this.data.reviewDraft && this.data.reviewDraft.locked) || !this.data.plannerState.generatedGoal) return null
        return { draft_id: this.data.cloudDraftId, revision: this.data.cloudDraftRevision, fingerprint: this.data.cloudDraftFingerprint,
          requirements_revision: this._requirementsRevision || 0, rules_version: VERSION }
      },
      resetPlannerReviewOwner() {
        this._auditToken = (this._auditToken || 0) + 1; this._auditBinding = null
        this.setData({ auditReady: false, auditBusy: '', auditError: '', auditExpired: false, auditRules: null, auditAI: null, auditUncertain: false })
      },
      invalidatePlannerReview() {
        this._auditToken = (this._auditToken || 0) + 1
        this.setData({ auditReady: false, auditBusy: '', auditExpired: !!(this.data.auditRules || this.data.auditAI) })
      },
      async loadSavedPlannerReviews() {
        if (typeof cloudApi.getPlannerReview !== 'function') return
        const target = this.plannerReviewBinding()
        this.setData({ auditReady: !!target })
        if (!target) { this.invalidatePlannerReview(); return }
        const id = scope(), token = this._auditToken = (this._auditToken || 0) + 1
        const changed = !same(this._auditBinding, target)
        this._auditBinding = target
        this.setData({ auditBusy: 'loading', auditError: '', ...(changed ? { auditRules: null, auditAI: null, auditExpired: false } : {}) })
        const results = await Promise.allSettled(['rules', 'ai'].map(mode => cloudApi.getPlannerReview({ binding: target, mode })))
        if (id !== scope() || token !== this._auditToken || !same(target, this.plannerReviewBinding())) return
        const errors = [], patch = { auditBusy: '', auditUncertain: false }
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const value = result.value.review
            if (value && !same(value.binding, target)) { errors.push('审核返回版本不一致，请重新读取'); return }
            patch[index ? 'auditAI' : 'auditRules'] = value
            if (value && !value.is_current) patch.auditExpired = true
          } else errors.push(String(result.reason && result.reason.message || result.reason || '审核记录读取失败'))
        })
        patch.auditError = errors.join('；'); patch.auditUncertain = errors.length > 0
        if (!errors.length) patch.auditExpired = !!((patch.auditRules && !patch.auditRules.is_current) || (patch.auditAI && !patch.auditAI.is_current))
        this.setData(patch)
      },
      async refreshReviewWorkspace(force = false) {
        if (this.data.auditBusy) {
          if (force !== true) return
          this.invalidatePlannerReview()
        }
        if (this.data.plannerState.generatedGoal && this.data.draftCloudState !== 'saved') {
          this.loadReviewDraft(true)
          return this.setData({ auditError: '本机还有未确认的修改，请先返回规划师保存，或恢复云端稿。' })
        }
        const id = scope()
        if (typeof this.restorePlannerDraft === 'function') await this.restorePlannerDraft()
        if (id === scope()) return this.loadReviewDraft(true)
      },
      async openStewardHandoff(intent) {
        const id = scope(), token = this._auditToken = (this._auditToken || 0) + 1
        const serial = this._draftEditSerial
        const valid = () => id === scope() && token === this._auditToken && !this._partnerClosed
        const current = () => valid() && this.data.mode === 'review'
        this.setData({ auditBusy: 'loading', auditError: '' })
        try {
          const { run } = await cloudApi.getStewardRun({ run_id: intent.stewardRunId })
          if (!current()) return
          if (this._restorePendingPublication()) return
          if (run?.pending_publication) {
            if (this.data.plannerState.generatedGoal && this.data.draftCloudState !== 'saved') throw new Error('本机有未保存修改，请先保留本机稿，再核对管家的发布')
            publicationDraft.save(run.pending_publication, {})
            return this._restorePendingPublication()
          }
          if (!run?.handoff || !same(intent.steward?.binding, run.handoff.binding) || serial !== this._draftEditSerial) {
            throw new Error('草案已换版，请返回管家刷新后打开当前稿')
          }
          if (this.data.plannerState.generatedGoal && this.data.draftCloudState !== 'saved') {
            throw new Error('本机有未保存修改，请先保存或备份后恢复云端稿')
          }
          await this.restorePlannerDraft()
          if (!current()) return
          if (!same(this.plannerReviewBinding(), run.handoff.binding)) throw new Error('当前稿与审核版本不同，请先查看云端稿或保留本机修改')
          this._plannerSteward = run.handoff
          this.setData({ stewardDraft: true, mode: 'review', showPlanModal: false, auditBusy: '' })
          return this.loadReviewDraft(true)
        } catch (error) {
          if (current()) this.setData({ auditError: error.message || String(error) })
        } finally {
          if (valid()) this.setData({ auditBusy: '' })
        }
      },
      openReviewFinding(e) {
        const { task, field, review } = e.currentTarget.dataset
        const binding = this.plannerReviewBinding()
        const result = [this.data.auditRules, this.data.auditAI].find(item => item && item.id === review)
        const index = task ? this.data.editableTasks.findIndex(item => item.draft_task_id === task) : -1
        if (!result?.is_current || this.data.auditExpired || !same(binding, result.binding) || task && index < 0) {
          return this.setData({ auditError: '审核版本已变化或任务已删除，请先查看当前草案' })
        }
        const anchor = task ? 'plan-task-' + index : field === 'tasks' ? 'plan-task-list' : 'plan-settings'
        this.setData({ mode: 'plan', showPlanModal: true, planEditAnchor: '' }, () => {
          if (this.data.showPlanModal) this.setData({ planEditAnchor: anchor })
        })
      },
      runPlannerRules() { return this.runPlannerReview('rules') },
      runPlannerAIReview() { return this.runPlannerReview('ai') },
      async runPlannerReview(mode) {
        const target = this.plannerReviewBinding()
        if (this.data.auditBusy) return
        if (!target) return this.setData({ auditReady: false, auditError: '请先在规划师保存当前草案，再来检查这一版。' })
        if (mode === 'ai' && this.data.auditUncertain) return this.setData({ auditError: '上次结果尚未确认，请先刷新审核结果，不重复调用模型。' })
        if (typeof cloudApi.reviewPlannerDraft !== 'function') return
        const id = scope(), token = this._auditToken = (this._auditToken || 0) + 1
        this.setData({ auditBusy: mode, auditError: '' })
        try {
          const result = await cloudApi.reviewPlannerDraft({ mode, binding: target,
            request_id: 'review_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) })
          if (id !== scope() || token !== this._auditToken || !same(target, this.plannerReviewBinding())) return
          const value = result.review
          if (!value || !same(value.binding, target)) throw new Error('审核返回版本不一致，请刷新核对')
          this.setData({ [mode === 'rules' ? 'auditRules' : 'auditAI']: value,
            auditExpired: !value.is_current, auditUncertain: false })
        } catch (error) {
          if (id === scope() && token === this._auditToken) this.setData({ auditError: String(error && error.message || error || '审核失败'), auditUncertain: mode === 'ai' })
        } finally { if (id === scope() && token === this._auditToken) this.setData({ auditBusy: '' }) }
      }
    }
  }
}
module.exports = { VERSION, createWorkspace }
