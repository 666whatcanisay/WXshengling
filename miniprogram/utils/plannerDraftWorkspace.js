const PREFIX = 'planner_working_copy_v2:'
const { VERSION } = require('./plannerReviewWorkspace')
function stewardReference(saved) {
  if (saved.steward) return saved.steward
  if (!saved.steward_run_id) return null
  return { run_id: saved.steward_run_id, binding: { draft_id: saved.id, revision: saved.revision,
    fingerprint: saved.fingerprint, requirements_revision: saved.context.revision, rules_version: VERSION } }
}
function createWorkspace({ wx, cloudApi, schedule, publicationDraft, contextRules }) {
  const scope = publicationDraft.accountScope
  const newId = prefix => prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12)
  return {
    data: { cloudDraftId: '', cloudDraftRevision: 0, cloudDraftFingerprint: '', draftCloudState: 'unloaded', draftCloudError: '',
      draftSource: '', draftAssumptions: [], plannerContextSources: {}, draftBackupAvailable: false,
      stewardDraft: false, plannerDailyLimit: '', planEditAnchor: '' },
    methods: {
      syncPlannerDraftOwner() {
        const id = scope()
        if (this._workingScope === id) return
        const changed = this._workingScope !== undefined
        this._workingScope = id; this._plannerCloudRevision = 0; this._plannerBaseKnown = false
        this._plannerHasLocalBase = false
        this._plannerConversationId = newId('conversation'); this._draftEditSerial = 0; this._draftUserEdits = {}
        this._pendingDraftSave = null; this._draftLoadId = (this._draftLoadId || 0) + 1
        this._plannerSteward = null
        this._generationChecking = false
        if (changed) {
          this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
          this._pendingPlanGeneration = null
          this._requirementsRevision = 0
          this._draftSaveInFlight = this._draftRestoreInFlight = null
          this._pendingPublication = null
          if (this._publicationInFlight) wx.hideLoading()
          this._publicationInFlight = null
          this.stopTypewriter()
          this.resetPlannerReviewOwner()
          this._updatePlannerState({ goalContext: contextRules.empty(), generatedGoal: null, generatedTasks: [],
            phase: 'idle', loading: false, lastPlanId: '', sourcePlanId: '' })
          this.setData({ planMessages: [], editableTasks: [], planInput: '', showPlanModal: false,
            publicationPending: false, publicationMessage: '', planStatus: '' })
        }
        this.setData({ cloudDraftId: '', cloudDraftRevision: 0, cloudDraftFingerprint: '', draftCloudState: 'unloaded', draftCloudError: '',
          draftSource: '', draftAssumptions: [], plannerContextSources: {}, draftBackupAvailable: false,
          stewardDraft: false, plannerDailyLimit: '', planEditAnchor: '' })
        try { if (id) this.setData({ draftBackupAvailable: !!wx.getStorageSync(PREFIX + id + ':backup') }) } catch (_) {}
      },
      async openPlannerWorkspace() {
        this.syncPlannerDraftOwner()
        const id = scope()
        this.setData({ mode: 'plan' })
        this.refreshGenerationRecovery()
        if (this._restorePendingPublication()) return
        if (this.data.plannerState.generatedGoal) return this.setData({ showPlanModal: true })
        if (this.data.planMessages.length) return
        const restored = await this.restorePlannerDraft()
        if (id !== scope()) return
        if (restored) this.setData({ showPlanModal: true })
        else if (!this.data.planMessages.length) this.initPlanChat()
      },
      collectPlannerUserMessage(text, messageId) {
        const prior = { values: this.data.plannerState.goalContext, sources: this.data.plannerContextSources || {}, revision: this._requirementsRevision || 0 }
        const next = contextRules.derive([{ id: messageId, role: 'user', content: text }], prior)
        const newGoal = prior.values.what && next.values.what && prior.values.what !== next.values.what
        if (newGoal) {
          this._draftEditSerial = (this._draftEditSerial || 0) + 1
          this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
          this._draftUserEdits = {}
          this._plannerSteward = null
          this._updatePlannerState({ generatedGoal: null, generatedTasks: [], lastPlanId: '', sourcePlanId: '' })
          this.setData({ cloudDraftId: '', showPlanModal: false, stewardDraft: false, plannerDailyLimit: '' })
        }
        this._requirementsRevision = next.revision
        this._updatePlannerState({ goalContext: next.values })
        this.setData({ plannerContextSources: next.sources })
      },
      _plannerSnapshot() {
        const goal = this.data.plannerState.generatedGoal
        if (!goal) return null
        const needsIds = this.data.editableTasks.some(task => !task.draft_task_id)
        const tasks = this.data.editableTasks.map(task => ({ ...task, draft_task_id: task.draft_task_id || newId('task') }))
        if (needsIds) this.setData({ editableTasks: tasks })
        return { ...(this._plannerSteward ? { daily_max_minutes: this.data.plannerDailyLimit === '' ? null : this.data.plannerDailyLimit } : {}),
          goal: { title: goal.title || '', target_days: this.data.planDays, start_date: this.data.planStartDate,
          stages: goal.stages || [] }, tasks: tasks.map(t => ({ draft_task_id: t.draft_task_id, title: t.title || '', date: t.date || '',
          stage: t.stage === undefined ? 1 : t.stage, estimated_minutes: t.estimated_minutes === undefined ? '' : t.estimated_minutes,
          xp_reward: t.xp_reward === undefined ? '' : t.xp_reward })) }
      },
      onPlannerDailyLimit(e) {
        if (!this._plannerSteward || this._pendingPublication || this.data.publicationPending) return
        this.setData({ plannerDailyLimit: String(e.detail.value) })
        this.markPlannerDraftDirty()
      },
      markPlannerDraftDirty() {
        if (this._restoringPlannerDraft || this._pendingPublication || this.data.publicationPending || !this.data.plannerState.generatedGoal) return
        this._draftEditSerial = (this._draftEditSerial || 0) + 1
        if (typeof this.invalidatePlannerReview === 'function') this.invalidatePlannerReview()
        this.setData({ draftCloudState: 'dirty', draftCloudError: '',
          draftAssumptions: contextRules.assumptions({ values: this.data.plannerState.goalContext }, { target_days: this.data.planDays }) })
        this.persistPlannerWorkingCopy()
      },
      persistPlannerWorkingCopy(force = false) {
        const id = scope()
        if (!id || this._workingScope !== id || this.data.publicationPending) return true
        if (!force && !this._pendingDraftSave && !['dirty', 'error', 'conflict', 'saving'].includes(this.data.draftCloudState)) return true
        const snapshot = this._plannerSnapshot()
        if (!snapshot && !this._pendingDraftSave) return true
        try {
          wx.setStorageSync(PREFIX + id, { version: 2, scope: id, snapshot,
            conversation_id: this._plannerConversationId, base_revision: this._plannerCloudRevision || 0,
            steward: this._plannerSteward,
            source_plan_id: this.data.plannerState.sourcePlanId || '', source: this.data.draftSource || 'user_draft',
            messages: this.data.planMessages.slice(-40).map(m => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.fullContent || m.content || '' })),
            user_edits: this._draftUserEdits || {}, serial: this._draftEditSerial || 0,
            context: { values: this.data.plannerState.goalContext, sources: this.data.plannerContextSources || {}, revision: this._requirementsRevision || 0 },
            pending: this._pendingDraftSave, pending_serial: this._pendingDraftSaveSerial })
          return true
        } catch (error) { this.setData({ draftCloudError: '本机草案备份失败，请先保留编辑内容再离开。' }); return false }
      },
      async ensurePlannerBase() {
        if (this._plannerBaseKnown) return true
        if (typeof cloudApi.getPlannerDraft !== 'function') return false
        const id = scope(), value = await cloudApi.getPlannerDraft()
        if (id !== scope()) throw new Error('账号已变化，请重新进入规划师')
        if (this._plannerHasLocalBase && this._plannerCloudRevision !== value.revision) throw new Error('云端已有新版本，本机稿已保留，请先恢复云端稿核对')
        this._plannerCloudRevision = value.revision
        this._plannerBaseKnown = true
        return true
      },
      async savePlannerDraft() {
        this.syncPlannerDraftOwner()
        if (this._draftSaveInFlight || this.data.publicationPending || (!this.data.plannerState.generatedGoal && !this._pendingDraftSave)) return
        if (!scope()) return this.setData({ draftCloudState: 'error', draftCloudError: '请先登录后保存草案' })
        if (typeof cloudApi.savePlannerDraft !== 'function') return // isolated legacy harnesses
        const id = scope()
        const operation = this._draftSaveInFlight = {}
        const isCurrent = () => id === scope() && this._draftSaveInFlight === operation
        try {
          await this.ensurePlannerBase()
          if (!isCurrent()) return
          if (!this._pendingDraftSave) {
            const snapshot = this._plannerSnapshot()
            if (this._plannerSteward && snapshot.daily_max_minutes !== null) {
              const limit = snapshot.daily_max_minutes
              if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1440) throw new Error('每日上限需为1至1440分钟整数，或留空')
              snapshot.daily_max_minutes = Number(limit)
            }
            this._pendingDraftSave = { request_id: newId('save'), expected_revision: this._plannerCloudRevision,
              conversation_id: this._plannerConversationId, snapshot,
              ...(this._plannerSteward ? { steward: this._plannerSteward } : {}),
              source_plan_id: this.data.plannerState.sourcePlanId || '', source: this.data.draftSource || 'user_draft',
              messages: this.data.planMessages.slice(-40).map(m => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.fullContent || m.content || '' })),
              user_edits: this._draftUserEdits || {} }
            this._pendingDraftSaveSerial = this._draftEditSerial || 0
          }
          if (!this.persistPlannerWorkingCopy()) return
          this.setData({ draftCloudState: 'saving', draftCloudError: '' })
          const saved = await cloudApi.savePlannerDraft(this._pendingDraftSave)
          if (!isCurrent()) return
          const unchanged = this._pendingDraftSaveSerial === this._draftEditSerial
          this._pendingDraftSave = null
          this._plannerCloudRevision = saved.current_revision || saved.revision
          this._plannerBaseKnown = true
          const conflict = this._plannerCloudRevision !== saved.revision
          // Acknowledging an old request does not grant permission to overwrite a newer draft.
          if (conflict) this._plannerCloudRevision = saved.revision
          this._plannerSteward = stewardReference(saved)
          this.setData({ cloudDraftId: saved.id, cloudDraftRevision: saved.revision, cloudDraftFingerprint: saved.fingerprint || '',
            draftCloudState: conflict ? 'conflict' : unchanged ? 'saved' : 'dirty',
            draftCloudError: conflict ? '保存请求已成功，但云端已有更新稿，请查看云端版本后继续。' : '', draftSource: saved.source,
            draftAssumptions: saved.assumptions || [], stewardDraft: !!this._plannerSteward })
          if (unchanged && !conflict && this.data.plannerState.generatedGoal) {
            this._requirementsRevision = saved.context.revision || 0
            this.setData({ plannerContextSources: saved.context.sources })
            wx.removeStorageSync(PREFIX + id)
          } else this.persistPlannerWorkingCopy()
          return saved
        } catch (error) {
          if (isCurrent()) this.setData({ draftCloudState: 'error', draftCloudError: String(error && error.message || error || '保存失败') })
        } finally { if (this._draftSaveInFlight === operation) this._draftSaveInFlight = null }
      },
      applyPlannerDraft(saved, baseRevision) {
        this._restoringPlannerDraft = true
        try {
          this._draftUserEdits = {}; this._draftEditSerial = 0; this._pendingDraftSave = null
          this._plannerConversationId = saved.conversation_id
          this._plannerCloudRevision = baseRevision === undefined ? saved.revision : baseRevision
          this._plannerBaseKnown = true
          this._plannerHasLocalBase = false
          const snapshot = saved.snapshot, goal = snapshot.goal
          this._plannerSteward = stewardReference(saved)
          const context = saved.context || contextRules.derive(saved.messages || [])
          this._requirementsRevision = context.revision || 0
          this._updatePlannerState({ generatedGoal: { ...goal, period_days: goal.target_days }, generatedTasks: snapshot.tasks,
            sourcePlanId: saved.source_plan_id || '', goalContext: context.values, phase: 'planning', loading: false })
          this.setData({ editableTasks: snapshot.tasks, planDays: goal.target_days, planStartDate: goal.start_date,
            planEndDate: schedule.durationDays(goal.target_days) && schedule.validDate(goal.start_date) ? schedule.endDate(goal.start_date, schedule.durationDays(goal.target_days)) : '',
            planMessages: saved.messages || [], cloudDraftId: saved.id || '', cloudDraftRevision: saved.revision || baseRevision || 0,
            cloudDraftFingerprint: saved.fingerprint || '',
            draftSource: saved.source || 'user_draft', draftAssumptions: saved.assumptions || contextRules.assumptions(context, goal),
            plannerContextSources: context.sources, draftCloudState: 'saved', draftCloudError: '',
            stewardDraft: !!this._plannerSteward, plannerDailyLimit: String(snapshot.daily_max_minutes ?? ''), planEditAnchor: '' })
        } finally { this._restoringPlannerDraft = false }
      },
      acceptGeneratedPlannerDraft(saved) {
        this.applyPlannerDraft(saved)
        try { wx.removeStorageSync(PREFIX + scope()) }
        catch (_) { this.setData({ draftCloudError: '云端已保存，但本机旧备份未能清理，可恢复云端稿核对。' }) }
      },
      async restorePlannerDraft(forceCloud = false) {
        this.syncPlannerDraftOwner()
        if (this._draftRestoreInFlight || this.data.publicationPending || this._pendingPublication) return false
        if (!scope() || typeof cloudApi.getPlannerDraft !== 'function') return false
        const id = scope(), loadId = this._draftLoadId = (this._draftLoadId || 0) + 1
        const editSerial = this._draftEditSerial || 0
        const preserveNewerEdits = () => {
          this._plannerBaseKnown = false; this._plannerHasLocalBase = true
          this.setData({ draftCloudState: 'dirty', draftCloudError: '读取期间已有新编辑，已保留本机修改；保存时会重新核对云端版本。' })
          this.persistPlannerWorkingCopy()
          return !!this.data.plannerState.generatedGoal
        }
        this._draftRestoreInFlight = loadId
        this.setData({ draftCloudState: 'loading', draftCloudError: '' })
        let local
        try {
          local = wx.getStorageSync(PREFIX + id)
          const current = await cloudApi.getPlannerDraft()
          if (id !== scope() || loadId !== this._draftLoadId) return false
          if ((this._draftEditSerial || 0) !== editSerial) return preserveNewerEdits()
          this._plannerCloudRevision = current.revision; this._plannerBaseKnown = true
          if (local && local.version === 2 && local.scope === id && !forceCloud && local.pending && current.draft && current.draft.request_id === local.pending.request_id) {
            if ((local.serial || 0) === (local.pending_serial || 0)) {
              this.applyPlannerDraft(current.draft, current.revision)
              wx.removeStorageSync(PREFIX + id)
              return true
            }
            local.base_revision = current.revision
            local.pending = null
          }
          if (local && local.version === 2 && local.scope === id && !forceCloud) {
            this.applyPlannerDraft(local, local.base_revision)
            this._plannerHasLocalBase = true
            this._draftEditSerial = local.serial || 0; this._draftUserEdits = local.user_edits || {}
            this._pendingDraftSave = local.pending || null; this._pendingDraftSaveSerial = local.pending_serial
            const conflict = local.base_revision !== current.revision
            this.setData({ draftCloudState: conflict ? 'conflict' : 'dirty', draftCloudError: conflict ? '本机有未保存修改，云端也有新版本；本机稿已保留，可先备份后恢复云端稿。' : '已恢复本机未保存修改，请保存到云端。' })
            return true
          }
          if (current.draft) { this.applyPlannerDraft(current.draft, current.revision); return true }
          this.setData({ draftCloudState: 'empty', cloudDraftRevision: current.revision, draftCloudError: forceCloud ? '云端暂无当前草案，本机内容仍保留。' : '' })
          return false
        } catch (error) {
          if (id === scope() && loadId === this._draftLoadId) {
            if ((this._draftEditSerial || 0) !== editSerial) return preserveNewerEdits()
            if (!forceCloud && local && local.version === 2 && local.scope === id && local.snapshot) {
              this.applyPlannerDraft(local, local.base_revision)
              this._plannerBaseKnown = false; this._plannerHasLocalBase = true
              this._draftEditSerial = local.serial || 0; this._draftUserEdits = local.user_edits || {}
              this._pendingDraftSave = local.pending || null; this._pendingDraftSaveSerial = local.pending_serial
              this.setData({ draftCloudState: 'error', draftCloudError: '已恢复本机稿，云端读取失败；联网后请重新核对再保存。' })
              return true
            }
            this.setData({ draftCloudState: 'error', draftCloudError: String(error && error.message || error || '读取失败') })
          }
          return false
        } finally { if (this._draftRestoreInFlight === loadId) this._draftRestoreInFlight = null }
      },
      recoverCloudPlannerDraft() {
        this.syncPlannerDraftOwner()
        const id = scope()
        if (!id) return
        const restore = async () => {
          if (id !== scope()) return
          this._plannerGenerationId = (this._plannerGenerationId || 0) + 1
          this._generationChecking = false
          this.setData({ 'plannerState.loading': false })
          if (this.data.plannerState.generatedGoal) {
            if (!this.persistPlannerWorkingCopy(true)) return
            try { wx.setStorageSync(PREFIX + id + ':backup', wx.getStorageSync(PREFIX + id)); this.setData({ draftBackupAvailable: true }) }
            catch (_) { return this.setData({ draftCloudError: '备份失败，未替换本机稿，请先自行保留内容。' }) }
          }
          if (await this.restorePlannerDraft(true)) this.setData({ showPlanModal: true })
        }
        if (['dirty', 'error', 'conflict', 'saving'].includes(this.data.draftCloudState) && this.data.plannerState.generatedGoal) {
          wx.showModal({ title: '恢复云端稿', content: '当前本机稿会先另存备份，再显示云端最新版本。可用“恢复本机备份”找回。', success: r => { if (r.confirm) restore() } })
        } else return restore()
      },
      recoverPlannerLocalBackup() {
        this.syncPlannerDraftOwner()
        const id = scope()
        try {
          const saved = id && wx.getStorageSync(PREFIX + id + ':backup')
          if (!saved || saved.version !== 2 || saved.scope !== id) throw new Error('没有可恢复的本机备份')
          this.applyPlannerDraft(saved, saved.base_revision)
          this._plannerHasLocalBase = true; this._plannerBaseKnown = false
          this._draftEditSerial = saved.serial || 0; this._draftUserEdits = saved.user_edits || {}
          this._pendingDraftSave = saved.pending || null; this._pendingDraftSaveSerial = saved.pending_serial
          this.setData({ showPlanModal: true, draftCloudState: 'dirty', draftCloudError: '已恢复备份，保存前需核对云端版本。' })
          this.persistPlannerWorkingCopy()
        } catch (error) { this.setData({ draftCloudError: error.message || '本机备份无法读取' }) }
      },
      async retirePublishedPlannerDraft(request) {
        const id = scope()
        try {
          if (!request.steward) wx.removeStorageSync(PREFIX + id)
          if (!Number.isSafeInteger(request.cloud_draft_revision) || typeof cloudApi.clearPlannerDraft !== 'function') return
          const result = await cloudApi.clearPlannerDraft({ expected_revision: request.cloud_draft_revision, request_id: 'published_' + request.publication_id })
          if (id !== scope()) return
          if (result.preserved_newer_draft) throw new Error('云端已有新稿')
          this._plannerSteward = null
          this._plannerCloudRevision = result.revision; this._plannerBaseKnown = true
          this.setData({ cloudDraftId: '', cloudDraftRevision: result.revision, draftCloudState: 'empty', draftCloudError: '', stewardDraft: false, plannerDailyLimit: '' })
        } catch (_) {
          if (id === scope()) this.setData({ draftCloudState: 'error', draftCloudError: '计划已发布，草案归档未完成或云端已有新稿；请勿重复发布，可恢复云端稿核对。' })
        }
      },
      async clearCloudPlannerDraft() {
        this.syncPlannerDraftOwner()
        if (this._draftSaveInFlight) { wx.showToast({ title: '草案正在保存，请完成后再重新开始', icon: 'none' }); return false }
        this._draftLoadId = (this._draftLoadId || 0) + 1
        const id = scope()
        if (!id) return false
        if (typeof cloudApi.clearPlannerDraft !== 'function') return true
        try {
          await this.ensurePlannerBase()
          if (id !== scope()) return false
          const result = await cloudApi.clearPlannerDraft({ expected_revision: this._plannerCloudRevision, request_id: newId('clear') })
          if (id !== scope()) return false
          if (result.preserved_newer_draft) throw new Error('上次清理已完成，但云端已保存新稿，请先查看云端版本')
          this._plannerCloudRevision = result.revision; this._plannerBaseKnown = true
          this._pendingDraftSave = null; this._draftUserEdits = {}; this._plannerConversationId = newId('conversation')
          this._plannerSteward = null
          wx.removeStorageSync(PREFIX + scope())
          this.setData({ cloudDraftId: '', cloudDraftRevision: result.revision, draftCloudState: 'empty', draftCloudError: '', stewardDraft: false, plannerDailyLimit: '' })
          return true
        } catch (error) { if (id === scope()) this.setData({ draftCloudError: String(error && error.message || error), draftCloudState: 'error' }); return false }
      }
    }
  }
}
module.exports = { createWorkspace }
