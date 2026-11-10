const DAY_MS = 86400000;
const MAX_TASK_XP = 1000;

function businessDate(timestamp) {
  return new Date((timestamp === undefined ? Date.now() : timestamp) + 8 * 3600000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  if (!validDate(value) || !Number.isInteger(days)) throw new Error('日期或天数不正确');
  return new Date(new Date(value + 'T00:00:00Z').getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function taskExperience(value) {
  const amount = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_TASK_XP ? amount : null;
}

module.exports = { businessDate, validDate, addDays, positiveInteger, MAX_TASK_XP, taskExperience };
