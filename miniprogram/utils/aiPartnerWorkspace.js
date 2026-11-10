// Partner navigation and coach facts. Versioned review execution lives in plannerReviewWorkspace.
const FEEDBACK_PREFIX = 'ai_coach_feedback_v2:'
const STATUS = { active: '进行中', doing: '进行中', todo: '待开始', done: '已完成', abandoned: '已放弃' }
const REASONS = ['时间不够', '任务偏难', '容易忘记', '状态不好', '其他']
const CLOSED_COACH_SECTIONS = { days: false, tasks: false, feedback: false, report: false }
function rows(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  throw new Error('返回格式不正确')
}
function createWorkspace({ wx, cloudApi, schedule, publicationDraft }) {
  const scope = publicationDraft.accountScope
  return {
    data: {
      reviewDraft: null, reviewError: '', reviewExpanded: false, reviewRulesExpanded: false, reviewAIExpanded: false,
      coachGoals: [], coachGoalLabels: [], coachGoalId: '', coachGoalTitle: '', coachGoalIndex: -1,
      coachDate: '', coachToday: '', coachGoalsLoading: false, coachGoalsError: '',
      coachTasksLoading: false, coachTasksError: '', coachFacts: null, coachTasks: [],
      coachSections: CLOSED_COACH_SECTIONS,
      coachReasons: REASONS, coachReason: '', coachNote: '', coachFeedbackStatus: '', coachFeedbackError: '', coachFeedbackReadError: false
    },
    methods: {
      coachFeedbackStorageKey() {
        return FEEDBACK_PREFIX + JSON.stringify([scope(), this.data.coachGoalId, this.data.coachDate])
      },
      syncPartnerOwner() {
        const id = scope()
        this._partnerClosed = false
        if (this._partnerScope === id) return
        this._partnerScope = id
        if (typeof this.resetCoachCloud === 'function') this.resetCoachCloud()
        if (typeof this.resetPlannerReviewOwner === 'function') this.resetPlannerReviewOwner()
        this._coachLoadId = (this._coachLoadId || 0) + 1
        this._reviewKey = ''
        this._reviewRevision = 0
        this._coachFeedbackDirty = false
        this._coachFeedbackReadFailed = false
        this.setData({ reviewDraft: null, reviewError: '', reviewExpanded: false, reviewRulesExpanded: false, reviewAIExpanded: false,
          coachGoals: [], coachGoalLabels: [], coachGoalId: '', coachGoalTitle: '', coachGoalIndex: -1,
          coachDate: schedule.today(), coachToday: schedule.today(), coachFacts: null, coachTasks: [],
          coachGoalsLoading: false, coachTasksLoading: false, coachGoalsError: '', coachTasksError: '', coachSections: CLOSED_COACH_SECTIONS,
          coachReason: '', coachNote: '', coachFeedbackStatus: '', coachFeedbackError: '', coachFeedbackReadError: false })
      },
      leavePartnerWorkspace() {
        if (this._coachFeedbackDirty) this.saveCoachFeedback()
        if (typeof this.pauseCoachCloud === 'function') this.pauseCoachCloud()
        this._partnerClosed = true
        this._coachLoadId = (this._coachLoadId || 0) + 1
      },
      loadReviewDraft(skipCloud = false) {
        this.syncPartnerOwner()
        this.setData({ reviewError: '', reviewExpanded: false, reviewRulesExpanded: false, reviewAIExpanded: false })
        try {
          const id = scope()
          if (!id) throw new Error('请先登录，再查看自己的计划草案。')
          const saved = publicationDraft.load()
          const pending = saved || (publicationDraft.owns(this._pendingPublication) ? this._pendingPublication : null)
          const state = this.data.plannerState
          const live = id && this._plannerDraftScope === id && state.generatedGoal
          const goal = pending ? pending.request.goal : live ? state.generatedGoal : null
          if (!goal) {
            this.setData({ reviewDraft: null })
            if (skipCloud !== true && typeof this.restorePlannerDraft === 'function') return this.restorePlannerDraft().then(restored => {
              if (id !== scope()) return
              if (restored) return this.loadReviewDraft(true)
              if (this.data.draftCloudError) this.setData({ reviewError: this.data.draftCloudError })
            })
            return
          }
          const tasks = pending ? pending.request.tasks : this.data.editableTasks
          if (!Array.isArray(tasks)) throw new Error('草案任务格式异常，请返回规划师查看。')
          const context = (pending ? pending.context : state.goalContext) || {}
          const start = pending ? goal.start_date : this.data.planStartDate
          const days = pending ? goal.target_days : this.data.planDays
          const key = JSON.stringify({ goal, tasks, context, start, days, locked: !!pending })
          if (key !== this._reviewKey) { this._reviewRevision++; this._reviewKey = key }
          const requirementLabels = [['what', '目标'], ['why', '动机'], ['deadline', '周期'], ['dailyTime', '每天投入'], ['level', '当前基础'], ['constraints', '其他要求']]
          const requirements = requirementLabels.filter(([field]) => context[field]).map(([field, label]) => ({ label, text: String(context[field]) }))
          this.setData({ reviewDraft: {
            title: goal.title || '未命名计划', source: pending ? '待确认发布原稿' : '规划师当前编辑稿',
            revision: this._reviewRevision, locked: !!pending, count: tasks.length,
            versionLabel: !pending && this.data.draftCloudState === 'saved' ? '云端版本 ' + this.data.cloudDraftRevision : '当前本机快照 ' + this._reviewRevision,
            start: start || '未设置', days: days || '未设置', requirements,
            tasks: tasks.map((task, index) => ({ key: task.draft_task_id || index, title: task.title || '未填写任务名', date: task.date || '未设置日期',
              minutes: Number.isFinite(Number(task.estimated_minutes)) && Number(task.estimated_minutes) > 0 ? task.estimated_minutes + ' 分钟（预计）' : '未设置预计时长' }))
          } })
          if (typeof this.loadSavedPlannerReviews === 'function') return this.loadSavedPlannerReviews()
        } catch (error) { this.setData({ reviewDraft: null, reviewError: error.message || '草案暂时读取失败，请重试。' }) }
      },
      toggleReviewTasks() { this.setData({ reviewExpanded: !this.data.reviewExpanded }) },
      toggleReviewRules() { this.setData({ reviewRulesExpanded: !this.data.reviewRulesExpanded }) },
      toggleReviewAI() { this.setData({ reviewAIExpanded: !this.data.reviewAIExpanded }) },
      toggleCoachSection(e) {
        const section = e.currentTarget.dataset.section
        this.setData({ coachSections: { ...this.data.coachSections, [section]: !this.data.coachSections[section] } })
      },
      openDraftReview() {
        this.setData({ mode: 'review', showPlanModal: false })
        this.loadReviewDraft()
      },
      openPartnerPlanner() {
        if (typeof this.openPlannerWorkspace === 'function') return this.openPlannerWorkspace()
        if (this._restorePendingPublication()) return
        this.setData({ mode: 'plan' })
        if (this.data.plannerState.generatedGoal) this.setData({ showPlanModal: true })
        else if (!this.data.planMessages.length) this.initPlanChat()
      },
      async loadCoachGoals() {
        this.syncPartnerOwner()
        if (!this.saveCoachFeedback()) return
        const id = scope(), loadId = this._coachLoadId = (this._coachLoadId || 0) + 1
        this.setData({ coachGoalsLoading: false, coachGoalsError: '', coachTasksError: '', coachTasksLoading: false,
          coachFacts: null, coachTasks: [], coachToday: schedule.today() })
        if (!id) { this.setData({ coachGoals: [], coachGoalLabels: [], coachGoalsError: '请先登录，再读取自己的执行记录。' }); return }
        this.setData({ coachGoalsLoading: true })
        try {
          const listing = typeof cloudApi.getCoachGoals === 'function' ? await cloudApi.getCoachGoals() : null
          const goals = (listing ? rows(listing.goals) : rows(await cloudApi.goals())).filter(g => g && g.status !== 'deleted').map(g => ({
            id: String(g._id || g.id || ''), title: g.title || '未命名目标', status: STATUS[g.status || 'active'] || '状态未知'
          })).filter(g => g.id)
          if (this._partnerClosed || loadId !== this._coachLoadId || id !== scope()) return
          const index = goals.findIndex(g => g.id === this.data.coachGoalId)
          const goal = index >= 0 ? goals[index] : null
          this.setData({ coachGoals: goals, coachGoalLabels: goals.map(g => g.title + ' · ' + g.status), coachGoalsLoading: false, coachGoalListComplete: listing ? listing.complete : true,
            coachGoalIndex: index, coachGoalId: goal ? goal.id : '', coachGoalTitle: goal ? goal.title : '' })
          if (goal) return this.loadCoachTasks()
          if (typeof this.resetCoachCloud === 'function') this.resetCoachCloud()
          this.setData({ coachFacts: null, coachTasks: [] })
          this.setData({ coachReason: '', coachNote: '', coachFeedbackStatus: '', coachFeedbackError: '' })
        } catch (error) {
          if (this._partnerClosed || loadId !== this._coachLoadId || id !== scope()) return
          this.setData({ coachWindow: null, coachFingerprint: '', coachReport: null, coachReportUncertain: true })
          this.setData({ coachGoalsLoading: false, coachGoalsError: '目标读取失败，请重试；不会用示例数据代替。' })
        }
      },
      async loadCoachTasks() {
        if (!this.data.coachGoalId) return
        if (typeof cloudApi.getCoachWorkspace === 'function' && typeof this.loadCoachEvidence === 'function') return this.loadCoachEvidence()
        const goalId = this.data.coachGoalId, date = this.data.coachDate, id = scope()
        const loadId = this._coachLoadId = (this._coachLoadId || 0) + 1
        this.setData({ coachTasksLoading: true, coachTasksError: '', coachFacts: null, coachTasks: [] })
        try {
          if (!id || !schedule.validDate(date) || date > schedule.today()) throw new Error('身份或日期无效')
          const tasks = rows(await cloudApi.tasks({ goal_id: goalId, date })).filter(t => t && String(t.goal_id) === goalId && t.date === date)
          if (this._partnerClosed || loadId !== this._coachLoadId || id !== scope()) return
          const completed = tasks.filter(t => t.completed === true).length
          this.setData({ coachTasksLoading: false, coachFacts: { total: tasks.length, completed, pending: tasks.length - completed,
            rate: tasks.length ? Math.round(completed / tasks.length * 100) : null },
            coachTasks: tasks.map((t, index) => ({ key: index, title: t.title || '未命名任务', completed: t.completed === true })) })
        } catch (error) {
          if (this._partnerClosed || loadId !== this._coachLoadId || id !== scope()) return
          this.setData({ coachTasksLoading: false, coachTasksError: '这一天的任务读取失败，请重试，暂不判断执行情况。' })
        }
      },
      onCoachGoalChange(e) {
        if (this._partnerScope !== scope()) return
        const index = Number(e.detail.value), goal = this.data.coachGoals[index]
        if (!goal || this.data.coachGoalsLoading || this.data.coachCloudSaving || !this.saveCoachFeedback()) return
        this.setData({ coachGoalIndex: index, coachGoalId: goal.id, coachGoalTitle: goal.title, coachSections: CLOSED_COACH_SECTIONS })
        this.restoreCoachFeedback()
        return this.loadCoachTasks()
      },
      onCoachDateChange(e) {
        if (this._partnerScope !== scope()) return
        if (this.data.coachGoalsLoading || this.data.coachCloudSaving) return
        const date = e.detail.value
        if (!schedule.validDate(date) || date > schedule.today() || !this.saveCoachFeedback()) return
        this.setData({ coachDate: date, coachSections: CLOSED_COACH_SECTIONS })
        this.restoreCoachFeedback()
        return this.loadCoachTasks()
      },
      restoreCoachFeedback() {
        if (this._partnerScope !== scope()) return
        if (typeof this.resetCoachCloud === 'function') this.resetCoachCloud()
        this._coachFeedbackDirty = false
        this.setData({ coachReason: '', coachNote: '', coachFeedbackStatus: '', coachFeedbackError: '', coachFeedbackReadError: false })
        if (!scope() || !this.data.coachGoalId) return
        try {
          const key = this.coachFeedbackStorageKey()
          const entry = wx.getStorageSync(key)
          const saved = entry?.version === 2 ? entry : null
          this._coachLocalRestored = !!saved
          if (saved) this.setData({ coachReason: REASONS.includes(saved.reason) ? saved.reason : '',
            coachNote: typeof saved.note === 'string' ? saved.note.slice(0, 500) : '', coachFeedbackStatus: '本机稿已恢复 · 云端同步状态待核对',
            coachDifficulty: ['轻松', '合适', '偏难'].includes(saved.difficulty) ? saved.difficulty : '',
            coachActualMinutes: saved.actual_minutes === undefined || saved.actual_minutes === null ? '' : String(saved.actual_minutes) })
          this._coachFeedbackBaseRevision = saved && Number.isSafeInteger(saved.base_revision) ? saved.base_revision : null
          this._coachFeedbackPending = saved && saved.pending || null
          this.setData({ coachCloudBackup: !!wx.getStorageSync(key + ':backup') })
        } catch (error) { this.setData({ coachFeedbackError: '本机反馈读取失败，请重试后再填写，避免覆盖已有记录。', coachFeedbackReadError: true }); this._coachFeedbackReadFailed = true; return }
        this._coachFeedbackReadFailed = false
      },
      onCoachReason(e) {
        if (this.data.coachGoalsLoading || this.data.coachEvidenceLoading || this.data.coachCloudSaving || !this.data.coachGoalId || this._coachFeedbackReadFailed || this._partnerScope !== scope()) return
        const reason = e.currentTarget.dataset.reason
        if (!REASONS.includes(reason)) return
        this.setData({ coachReason: this.data.coachReason === reason ? '' : reason, coachFeedbackStatus: '尚未保存' })
        this._coachFeedbackDirty = true
        if (typeof this.invalidateCoachReport === 'function') this.invalidateCoachReport()
      },
      onCoachNote(e) {
        if (this.data.coachGoalsLoading || this.data.coachEvidenceLoading || this.data.coachCloudSaving || !this.data.coachGoalId || this._coachFeedbackReadFailed || this._partnerScope !== scope()) return
        this.setData({ coachNote: e.detail.value.slice(0, 500), coachFeedbackStatus: '尚未保存' })
        this._coachFeedbackDirty = true
        if (typeof this.invalidateCoachReport === 'function') this.invalidateCoachReport()
      },
      saveCoachFeedback(force = false) {
        if (!this._coachFeedbackDirty && force !== true) return true
        if (this._partnerScope !== scope() || !scope() || !this.data.coachGoalId) return false
        if (this._coachFeedbackReadFailed) {
          wx.showToast({ title: '请先保留文字并重试读取本机反馈', icon: 'none' })
          return false
        }
        try {
          wx.setStorageSync(this.coachFeedbackStorageKey(), { version: 2, reason: this.data.coachReason, note: this.data.coachNote,
            difficulty: this.data.coachDifficulty || '', actual_minutes: this.data.coachActualMinutes === undefined ? '' : this.data.coachActualMinutes,
            base_revision: this._coachFeedbackBaseRevision === undefined ? null : this._coachFeedbackBaseRevision, pending: this._coachFeedbackPending || null })
          this._coachLocalRestored = true
          this._coachFeedbackDirty = false
          this.setData({ coachFeedbackStatus: typeof this.coachFeedbackStatusText === 'function' ? this.coachFeedbackStatusText() : '已保存到本机 · 未提交给 AI', coachFeedbackError: '' })
          return true
        } catch (error) {
          this.setData({ coachFeedbackError: '本机保存失败，请先复制反馈文字；本次不会切换记录。' })
          return false
        }
      }
    }
  }
}
module.exports = { createWorkspace }
