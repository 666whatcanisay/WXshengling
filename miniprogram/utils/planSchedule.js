const DAY_MS = 86400000

function today(timestamp) {
  return new Date((timestamp === undefined ? Date.now() : timestamp) + 8 * 3600000).toISOString().slice(0, 10)
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function addDays(value, days) {
  if (!validDate(value) || !Number.isInteger(days)) throw new Error('日期或天数不正确')
  return new Date(new Date(value + 'T00:00:00Z').getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

function durationDays(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  const match = String(value || '').trim().match(/^(\d+)\s*(天|日|周|星期|个月|月)?$/)
  if (!match) return null
  const factors = { '周': 7, '星期': 7, '个月': 30, '月': 30 }
  const days = Number(match[1]) * (factors[match[2]] || 1)
  return Number.isSafeInteger(days) && days > 0 ? days : null
}

function endDate(start, days) {
  try {
    const end = addDays(start, days - 1)
    return validDate(end) ? end : ''
  } catch (e) { return '' }
}

// Missing dates get visible, editable sequential dates; this does not create recurrence.
function draftTasks(tasks, start, days) {
  return tasks.map((task, index) => {
    const day = task.day_index === undefined ? Math.min(index + 1, days) : Number(task.day_index)
    return Object.assign({}, task, {
      date: task.date || (Number.isInteger(day) && day > 0 && day <= days ? endDate(start, day) : ''),
      estimated_minutes: task.estimated_minutes === undefined ? 20 : task.estimated_minutes,
    })
  })
}

module.exports = { today, validDate, addDays, durationDays, endDate, draftTasks }
