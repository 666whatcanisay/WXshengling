// Keep page VM and imported schedule helpers on the same fixture clock.
// Never patch global.Date or the developer machine's clock.
const schedule = require('../../miniprogram/utils/planSchedule')
function createClock(source) {
  const now = () => typeof source === 'function' ? source() : Number(source)
  if (!Number.isFinite(now())) throw Error('Invalid fixture clock')
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])) }
    static now() { return now() }
  }
  return { now, Date: FixtureDate, schedule: { ...schedule, today: timestamp => schedule.today(timestamp === undefined ? now() : timestamp) } }
}
module.exports = { createClock }
