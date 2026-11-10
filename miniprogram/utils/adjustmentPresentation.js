// Presentation only: actions still use the existing guarded workspace methods.
function describe(d, contextMatches = true) {
  const run = d.adjustmentRun, w = d.adjustmentWorkspace
  const result = (phase, title, detail, action, label, disabled = false, stage = 0) => ({ phase, title, detail, action, label, disabled, stage })
  if (!d.currentGoal) return result('choose', '先选择一个目标', '本轮调整只针对一个目标的未来任务。', 'choose', '选择目标', !!d.loading)
  if (d.adjustmentBusy) return result('busy', d.adjustmentBusy, '请稍候，操作完成后会更新当前状态。', '', '正在处理…', true)
  if (!contextMatches) return result('loading', '正在切换目标', '正在读取当前目标，先不提交旧目标的内容。', '', '正在读取…', true)
  if (d.adjustmentPendingApplication) {
    const revision = d.adjustmentPendingApplication.expected_revision
    return d.adjustmentApplicationChecked
      ? result('retry', '原确认尚未查到成功回执', '已保留第' + revision + '版。可以继续提交同一确认，也可以稍后再查询；无需重新生成。', 'retry', '继续提交原确认', false, 3)
      : result('pending', '上次确认结果待核对', '先查询第' + revision + '版的云端回执，避免把尚未确认的结果当作成功。', 'query', '查询应用结果', false, 3)
  }
  if (!d.adjustmentSuggestionChanged && d.adjustmentApplicationReceipt && (!run || run.id === d.adjustmentApplicationReceipt.run_id)) return result('applied', '第' + d.adjustmentApplicationReceipt.revision + '版已应用', '已更新' + d.adjustmentApplicationReceipt.count + '项未来任务。回执已保存，再次查看不会重复应用。', 'refresh', '刷新已应用结果', false, 3)
  if (d.loading || d.adjustmentLoading) return result('loading', '正在读取未来任务', '读取完成后会显示本轮可以进行的操作。', '', '正在读取…', true)
  if (!w) return result('unavailable', '先读取当前目标的记录', d.adjustmentError || '读取未来任务后再开始调整。', 'refresh', '重新读取记录')
  if (d.adjustmentConflict || d.adjustmentDirty && run && !run.is_current) return result('conflict', '本机修改需要与云稿核对', '先备份本机内容并读取云稿，避免覆盖更新的版本；副本仍可找回。', 'readCloud', '备份本机稿并读取云稿')
  if (d.adjustmentDirty) return result('dirty', '先保存这次改稿', '本机修改尚未保存，旧审核不作为当前结论。保存后再检查，不会直接修改正式任务。', 'save', '保存改稿 · 再做检查')
  if (!w.snapshot.eligible) return result('blocked', '当前目标不能调整', w.snapshot.blocked_reason || '请选择进行中的目标。', 'choose', '切换目标')
  if (!w.snapshot.complete) return result('capped', '本轮任务超过读取范围', '首版最多调整20项已有任务，不会截取部分记录后直接应用。', 'choose', '切换目标')
  if (!w.snapshot.tasks.length) return result('empty', '当前目标没有可调整的未来任务', '只读取明天起7天内的已有未完成任务；可切换目标，或先到目标中安排任务。', 'choose', '切换目标')
  const minutes = d.adjustmentMinutes || ''
  const validInput = !!String(d.adjustmentInstructions || '').trim() && (minutes === '' || /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440)
  if (d.adjustmentSuggestion?.stale) return result('suggestion-stale', '教练建议已变化', '原输入已保留，请重新选择建议或移除引用。', 'requirements', '查看本轮要求')
  if (d.adjustmentSuggestionChanged && !['ready', 'running'].includes(run?.status)) {
    return result('suggestion-changed', '准备下一份调整草案', '本轮参考内容已有变化，请核对要求后生成新草案。', 'start', '按当前要求生成新草案', !validInput)
  }
  if (!run) return result('start', '先写明本轮调整要求', validInput ? '生成草案后可查看差异，再决定是否应用。最多2次模型请求，可能产生费用。' : '填写下方调整要求；每日可用时间填1—1440整数，未知可留空。', 'start', '生成调整草案并审核', !validInput)
  if (!run.is_current) return result('stale', '这份草案的来源已变化', '原任务、反馈或日期已变化。旧稿保留供查看，不能直接应用。', ['ready', 'running'].includes(run.status) ? 'cancel' : 'requirements', ['ready', 'running'].includes(run.status) ? '停止旧协作' : '填写新的调整要求')
  if (run.status === 'cancelled') return result('cancelled', '这次协作已取消', '原建议保留为只读内容。如需另一份方案，请展开要求再开始。', 'requirements', '准备另一轮要求')
  if (run.status === 'running') return run.can_recover
    ? result('resume', '可以从保存的进度继续', '只继续未完成步骤，模型步骤可能产生费用。', 'continue', '继续当前协作')
    : result('running', '当前步骤仍在处理中', '先刷新查看处理结果，不重复生成。', 'refresh', '刷新协作状态')
  if (!run.changes) return result('resume', run.status === 'failed' ? '上一步未完成' : '草案仍在准备中', run.error || '可从已保存进度继续，模型步骤可能产生费用。', run.status === 'failed' ? 'requirements' : 'continue', run.status === 'failed' ? '修改要求再开始' : '继续规划与审核')
  if (!run.changes.length) return result('nochange', '这次没有实际变更', '原安排已保留，不需要确认应用。', 'refresh', '刷新当前记录')
  if (!w.applicationSupported) return result('legacy', '草案已保存', '当前云端仅支持草案，应用功能尚未更新。', 'refresh', '刷新云端状态')
  if (run.application_blocked_reason) return result('limited', '当前不能应用这份草案', run.application_blocked_reason, 'choose', '切换目标')
  if (!run.rules || ['ready', 'failed'].includes(run.status)) return result('check', '先检查当前版本', '保存或检查都不会修改正式任务。规则检查不调用模型，AI意见可选。', 'check', '检查当前版本 · 不调用模型', false, 1)
  if (run.rules.error_count) return result('rules', '还有' + run.rules.error_count + '项规则问题', '查看下方问题，修改对应任务后保存并重新检查。', 'compare', '查看并修改任务对照', false, 1)
  return result('confirm', '第' + run.revision + '版待你确认', '规则检查已完成，正式任务尚未修改。先查看对照，再在弹窗中确认应用。', 'apply', '确认应用到' + run.changes.length + '项未来任务', !run.can_apply || !!d.adjustmentInputChanged, 2)
}
module.exports = { describe }
