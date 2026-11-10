const TIMER_SECONDS = { focus25: 1500, focus15: 900, focus5: 300, break5: 300 }

function remainingSeconds(deadline, now) {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

function todayTasks(tasks, goals, date) {
  const activeGoals = new Map(goals
    .filter(goal => !goal.status || ['todo', 'doing', 'active'].includes(goal.status))
    .map(goal => [String(goal._id || goal.id || ''), goal.title]))
  return tasks.filter(task => (task.id || task._id) && task.title && !task.completed &&
    task.date === date && task.goal_id && activeGoals.has(String(task.goal_id)))
    .map(task => ({
      id: String(task.id || task._id),
      goalId: String(task.goal_id),
      goalTitle: activeGoals.get(String(task.goal_id)) || '我的目标',
      text: task.title,
      date,
      time: Number(task.estimated_minutes) > 0 ? '预计 ' + task.estimated_minutes + ' 分钟' : '',
    }))
}

function owner(getApp) {
  const data = getApp().globalData || {}
  const user = data.userInfo || {}
  return data.currentOpenid || user.openid || user._openid || ''
}

module.exports = { TIMER_SECONDS, remainingSeconds, todayTasks, owner }
