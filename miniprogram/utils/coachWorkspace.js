const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function createWorkspace({ wx, cloudApi, publicationDraft }) {
  const scope = publicationDraft.accountScope
  const text = error => String(error && (error.message || error.errMsg) || error || '请求未确认，请刷新核对')
  const requestId = () => 'coach_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
  return {
    data: { coachWindow: null, coachFingerprint: '', coachSource: null, coachEvidenceLoading: false, coachCloudRevision: null,
      coachCloudDirty: false, coachCloudConflict: false, coachCloudSaving: false, coachCloudMessage: '', coachCloudError: '', coachCloudBackup: false,
      coachDifficulty: '', coachDifficulties: ['轻松', '合适', '偏难'], coachActualMinutes: '',
      coachReport: null, coachReportBusy: false, coachReportError: '', coachReportUncertain: false, coachReportExpired: false, coachGoalListComplete: true },
    methods: {
      coachFeedbackStatusText() {
        if (this._coachFeedbackPending) return '本机副本已保存 · 云端保存结果待确认'
        let synced = false
        try { synced = !!this._coachCloudFeedback && same(this.coachFeedbackValues(), this._coachCloudFeedback.values) } catch (_) { /* Keep invalid inputs local. */ }
        return synced && !this.data.coachCloudConflict ? '已同步云端 · 版本 ' + this._coachCloudFeedback.revision : '已保存到本机 · 尚未同步云端'
      },
      resetCoachCloud() {
        this._coachEvidenceEpoch = (this._coachEvidenceEpoch || 0) + 1; this._coachReportEpoch = (this._coachReportEpoch || 0) + 1
        this._coachCloudFeedback = null; this._coachFeedbackBaseRevision = null; this._coachFeedbackPending = null; this._coachLocalRestored = false
        this.setData({ coachWindow: null, coachFingerprint: '', coachSource: null, coachEvidenceLoading: false, coachCloudRevision: null,
          coachCloudDirty: false, coachCloudConflict: false, coachCloudSaving: false, coachCloudMessage: '', coachCloudError: '', coachCloudBackup: false,
          coachDifficulty: '', coachActualMinutes: '', coachReport: null, coachReportBusy: false, coachReportError: '', coachReportUncertain: false, coachReportExpired: false })
      },
      pauseCoachCloud() {
        this._coachEvidenceEpoch = (this._coachEvidenceEpoch || 0) + 1; this._coachReportEpoch = (this._coachReportEpoch || 0) + 1
        this.setData({ coachEvidenceLoading: false, coachCloudSaving: false, coachReportBusy: false })
      },
      coachFeedbackValues() {
        const raw = this.data.coachActualMinutes
        if (raw !== '' && (!/^\d+$/.test(String(raw)) || Number(raw) > 1440)) throw Error('自述用时请填0至1440分钟整数，未知可留空')
        return { reason: this.data.coachReason || '', difficulty: this.data.coachDifficulty || '', actual_minutes: raw === '' ? null : Number(raw), note: (this.data.coachNote || '').trim() }
      },
      applyCoachCloudFeedback(feedback) {
        const values = feedback.values
        this._coachFeedbackBaseRevision = feedback.revision; this._coachFeedbackPending = null
        this.setData({ coachReason: values.reason, coachNote: values.note, coachDifficulty: values.difficulty,
          coachActualMinutes: values.actual_minutes === null ? '' : String(values.actual_minutes), coachCloudDirty: false, coachCloudConflict: false })
      },
      invalidateCoachReport() {
        this._coachReportEpoch = (this._coachReportEpoch || 0) + 1
        let dirty = true
        try { dirty = !this._coachCloudFeedback || !same(this.coachFeedbackValues(), this._coachCloudFeedback.values) } catch (_) { /* Invalid input remains an unsaved local draft. */ }
        this.setData({ coachCloudDirty: dirty, coachReportExpired: !!this.data.coachReport && dirty, coachReportBusy: false, coachCloudMessage: '',
          coachFeedbackStatus: dirty ? '有本机修改 · 尚未同步云端' : this.coachFeedbackStatusText() })
      },
      onCoachDifficulty(e) {
        if (this.data.coachEvidenceLoading || this.data.coachCloudSaving || !this.data.coachGoalId || this._coachFeedbackReadFailed || this._partnerScope !== scope()) return
        const value = e.currentTarget.dataset.difficulty
        if (!this.data.coachDifficulties.includes(value)) return
        this.setData({ coachDifficulty: this.data.coachDifficulty === value ? '' : value }); this._coachFeedbackDirty = true; this.invalidateCoachReport()
      },
      onCoachActualMinutes(e) {
        if (this.data.coachEvidenceLoading || this.data.coachCloudSaving || !this.data.coachGoalId || this._coachFeedbackReadFailed || this._partnerScope !== scope()) return
        this.setData({ coachActualMinutes: String(e.detail.value).slice(0, 5) }); this._coachFeedbackDirty = true; this.invalidateCoachReport()
      },
      async loadCoachEvidence(forceCloud = false) {
        if (typeof cloudApi.getCoachWorkspace !== 'function' || !scope() || this._partnerScope !== scope() || !this.data.coachGoalId) return
        if (this.data.coachCloudSaving) return
        const ctx = this.coachFeedbackStorageKey(), epoch = this._coachEvidenceEpoch = (this._coachEvidenceEpoch || 0) + 1
        this._coachReportEpoch = (this._coachReportEpoch || 0) + 1
        this.setData({ coachTasksLoading: true, coachEvidenceLoading: true, coachTasksError: '', coachCloudError: '', coachReportError: '', coachReportBusy: false })
        try {
          const result = await cloudApi.getCoachWorkspace({ goal_id: this.data.coachGoalId, date: this.data.coachDate })
          if (ctx !== this.coachFeedbackStorageKey() || epoch !== this._coachEvidenceEpoch || this._partnerClosed) return
          const changed = this.data.coachFingerprint && this.data.coachFingerprint !== result.fingerprint
          this._coachCloudFeedback = result.feedback
          if (forceCloud === true || !this._coachLocalRestored && !this._coachFeedbackDirty) this.applyCoachCloudFeedback(result.feedback)
          else {
            let values = null
            try { values = this.coachFeedbackValues() } catch (error) { this.setData({ coachCloudDirty: true, coachCloudError: text(error) }) }
            const pending = this._coachFeedbackPending
            if (pending && result.feedback.request_id === pending.request_id) {
              this._coachFeedbackBaseRevision = result.feedback.revision; this._coachFeedbackPending = null
            }
            const dirty = !values || !same(values, result.feedback.values)
            if (!dirty || this._coachFeedbackBaseRevision === null && result.feedback.revision === 0) this._coachFeedbackBaseRevision = result.feedback.revision
            this.setData({ coachCloudDirty: dirty, coachCloudConflict: dirty && !this._coachFeedbackPending && this._coachFeedbackBaseRevision !== result.feedback.revision })
          }
          const selected = result.facts.daily.find(day => day.date === this.data.coachDate)
          this.setData({ coachWindow: result.facts, coachFingerprint: result.fingerprint, coachSource: result.source, coachCloudRevision: result.feedback.revision,
            coachFacts: { total: selected.total, completed: selected.completed, pending: selected.pending, unknown: selected.unknown, rate: selected.rate },
            coachTasks: result.day_tasks.map(task => ({ key: task.id, title: task.title, completed: task.completed })),
            coachReport: result.report, coachReportUncertain: false, coachReportExpired: !!(result.report && this.data.coachCloudDirty),
            coachCloudMessage: this.data.coachCloudConflict ? '云端反馈已有新版本，本机稿已保留，请先核对。' : this._coachFeedbackPending ? '上次保存结果待确认，重试会使用原请求。' : this.data.coachCloudDirty ? '本机反馈尚未同步到云端。' : '已读取云端反馈 · 版本 ' + result.feedback.revision,
            coachReportError: changed && !result.report ? '任务或反馈已有变化，旧复盘不作为当前结论。' : '' })
          this.setData({ coachFeedbackStatus: this.coachFeedbackStatusText() })
          if (forceCloud === true || this._coachLocalRestored) this.saveCoachFeedback(true)
        } catch (error) {
          if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachEvidenceEpoch) this.setData({ coachTasksError: '近7天记录读取未完成：' + text(error), coachWindow: null, coachFacts: null,
            coachFingerprint: '', coachReport: null, coachReportUncertain: true })
        } finally { if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachEvidenceEpoch) this.setData({ coachTasksLoading: false, coachEvidenceLoading: false }) }
      },
      async saveCoachCloudFeedback() {
        if (typeof cloudApi.saveCoachFeedback !== 'function' || this.data.coachCloudSaving || this.data.coachEvidenceLoading || this._coachFeedbackReadFailed || !this.data.coachGoalId || this._partnerScope !== scope()) return
        if (!this.data.coachCloudDirty && !this._coachFeedbackPending) return this.setData({ coachCloudMessage: this.coachFeedbackStatusText() + '，无需重复保存' })
        if (this._coachFeedbackBaseRevision === null || this.data.coachCloudConflict) return this.setData({ coachCloudError: '请先核对云端反馈，再保存本机修改。' })
        const ctx = this.coachFeedbackStorageKey(), epoch = this._coachEvidenceEpoch = (this._coachEvidenceEpoch || 0) + 1
        try {
          if (!this._coachFeedbackPending) this._coachFeedbackPending = { goal_id: this.data.coachGoalId, date: this.data.coachDate,
            request_id: requestId(), expected_revision: this._coachFeedbackBaseRevision, values: this.coachFeedbackValues() }
          if (!this.saveCoachFeedback(true)) return
          const pending = this._coachFeedbackPending
          this.setData({ coachCloudSaving: true, coachCloudError: '', coachCloudMessage: '正在保存到云端…' })
          const result = await cloudApi.saveCoachFeedback(pending)
          if (ctx !== this.coachFeedbackStorageKey() || epoch !== this._coachEvidenceEpoch || this._partnerClosed) return
          this._coachFeedbackPending = null; this._coachFeedbackBaseRevision = result.applied_revision; this._coachCloudFeedback = result.feedback
          const unchanged = same(this.coachFeedbackValues(), pending.values), conflict = result.current_revision !== result.applied_revision
          this.setData({ coachCloudRevision: result.current_revision, coachCloudDirty: !unchanged || conflict, coachCloudConflict: conflict,
            coachCloudMessage: conflict ? '上次保存已成功，但云端已有更新稿，请保留本机内容后核对。' : unchanged ? '反馈已保存到云端' : '上一版已保存，本机还有新修改待同步。' })
          this.saveCoachFeedback(true)
          this.setData({ coachCloudSaving: false })
          await this.loadCoachEvidence()
          if (ctx === this.coachFeedbackStorageKey() && !this._partnerClosed && !this.data.coachCloudDirty && !this.data.coachCloudConflict && !this.data.coachTasksError) wx.showToast({ title: '反馈已保存到云端', icon: 'success' })
        } catch (error) {
          if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachEvidenceEpoch) {
            const conflict = text(error).includes('新版本')
            if (conflict) { this._coachFeedbackPending = null; this.saveCoachFeedback(true) }
            this.setData({ coachCloudError: text(error), coachCloudConflict: conflict,
              coachCloudMessage: conflict ? '本机稿已保留，请先核对云端反馈。' : '保存结果未确认，本机反馈已保留，可重试原请求。' })
          }
        } finally { if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachEvidenceEpoch) this.setData({ coachCloudSaving: false }) }
      },
      async restoreCoachCloudFeedback() {
        if (this.data.coachCloudSaving || !this.data.coachGoalId || this._partnerScope !== scope()) return
        try {
          wx.setStorageSync(this.coachFeedbackStorageKey() + ':backup', { values: { reason: this.data.coachReason, note: this.data.coachNote, difficulty: this.data.coachDifficulty,
            actual_minutes: this.data.coachActualMinutes === '' ? null : this.data.coachActualMinutes }, base_revision: this._coachFeedbackBaseRevision, pending: this._coachFeedbackPending })
          this.setData({ coachCloudBackup: true })
        } catch (error) { return this.setData({ coachCloudError: '本机副本保存失败，未替换当前内容，请先保留文字。' }) }
        return this.loadCoachEvidence(true)
      },
      restoreCoachLocalBackup() {
        if (this.data.coachCloudSaving || !this.data.coachGoalId || this._partnerScope !== scope()) return
        try {
          const backup = wx.getStorageSync(this.coachFeedbackStorageKey() + ':backup')
          if (!backup || !backup.values) throw Error('没有本机副本')
          this.applyCoachCloudFeedback({ values: backup.values, revision: backup.base_revision })
          this._coachFeedbackBaseRevision = backup.base_revision; this._coachFeedbackPending = backup.pending || null; this._coachLocalRestored = true
          this._coachFeedbackDirty = true; this.invalidateCoachReport(); this.saveCoachFeedback(true)
          return this.loadCoachEvidence()
        } catch (error) { this.setData({ coachCloudError: text(error) }) }
      },
      async runCoachReview() {
        if (this.data.coachReportBusy || this.data.coachEvidenceLoading || this.data.coachCloudSaving || this._coachFeedbackReadFailed || this._partnerScope !== scope()) return
        if (this.data.coachCloudDirty || this.data.coachCloudConflict || this._coachFeedbackPending) return this.setData({ coachReportError: '请先将本机反馈保存到云端，或核对云端反馈后再复盘。' })
        if (!this.data.coachWindow || !this.data.coachWindow.complete || !this.data.coachWindow.has_evidence || !this.data.coachFingerprint) return this.setData({ coachReportError: '记录未读全或没有任务/反馈，请先补充和刷新。' })
        if (this.data.coachReportUncertain || this.data.coachReport && this.data.coachReport.status === 'running') return this.setData({ coachReportError: '上次复盘结果待确认，请先刷新查询，不重复调用模型。' })
        if (this.data.coachReport && this.data.coachReport.status === 'done') return this.loadCoachEvidence()
        const ctx = this.coachFeedbackStorageKey(), epoch = this._coachReportEpoch = (this._coachReportEpoch || 0) + 1
        this.setData({ coachReportBusy: true, coachReportError: '' })
        try {
          await cloudApi.reviewCoach({ goal_id: this.data.coachGoalId, date: this.data.coachDate, fingerprint: this.data.coachFingerprint, request_id: requestId() })
          if (ctx !== this.coachFeedbackStorageKey() || epoch !== this._coachReportEpoch || this._partnerClosed) return
          this.setData({ coachReportBusy: false })
          return this.loadCoachEvidence()
        } catch (error) {
          if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachReportEpoch) this.setData({ coachReportError: text(error), coachReportUncertain: true })
        } finally { if (ctx === this.coachFeedbackStorageKey() && epoch === this._coachReportEpoch) this.setData({ coachReportBusy: false }) }
      }
    }
  }
}
module.exports = { createWorkspace }
