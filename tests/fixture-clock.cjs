const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process')
const { createClock } = require('./helpers/clock.cjs')
const { page } = require('./adjustment-client.cjs')
const { fixture, envelope } = require('./adjustment-application.cjs')
const schedule = require('../miniprogram/utils/planSchedule'), rules = require('../cloudfunctions/app/lib/taskRules')
let checks = 0
const eq = (a, b) => { assert.deepEqual(a, b); checks++ }
const probes = ['2026-11-06T15:59:59Z', '2026-11-06T16:00:00Z', '2026-12-31T16:00:00Z']
if (process.argv.includes('--probe')) {
  console.log(JSON.stringify(probes.map(t => [schedule.today(Date.parse(t)), rules.businessDate(Date.parse(t))])))
} else {
  main().catch(e => { console.error(e); process.exitCode = 1 })
}
async function main() {
  let now = Date.parse(probes[0]); const clock = createClock(() => now)
  eq(clock.schedule.today(), '2026-11-06'); eq(new clock.Date().getTime(), now); eq(clock.Date.now(), now)
  now += 1000
  eq(clock.schedule.today(), '2026-11-07'); eq(new clock.Date().getTime(), now)
  eq(clock.schedule.today(Date.parse('2020-01-01T00:00:00Z')), '2020-01-01')
  const expected = [['2026-11-06', '2026-11-06'], ['2026-11-07', '2026-11-07'], ['2027-01-01', '2027-01-01']]
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, [__filename, '--probe'], { env: { ...process.env, TZ: tz }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    eq(r.status, 0); eq(JSON.parse(r.stdout), expected)
  }
  for (const date of ['2026-11-06', '2026-11-07', '2026-11-30', '2026-12-31', '2028-02-28', '2028-02-29']) {
    const f = await fixture({}, 2, 0, Date.parse(date + 'T23:59:59+08:00'))
    try {
      const c = page({ goals: async () => f.env.rows.goals, tasks: async () => [],
        getCoachWorkspace: d => f.coach.get('owner', d), getAdjustmentWorkspace: d => f.service.get('owner', d) }, new Map(), 'forest-steward/forest-steward', f.clock)
      await c.p.onShow(); await c.p.selectGoal({ currentTarget: { dataset: { id: 'g1' } } })
      await c.p.setResultTab({ currentTarget: { dataset: { tab: 'summary' } } })
      eq(c.p.data.today, date); eq(c.p.data.adjustmentFlow.action, 'apply')
      eq(c.p.data.adjustmentWorkspace.snapshot.start, schedule.addDays(date, 1))
      const original = JSON.stringify(f.env.rows.tasks)
      f.state.time += 1000 // Cross the actual Beijing midnight, including month/year/leap day.
      await assert.rejects(() => f.service.apply('owner', envelope(f.run)), /变化/); checks++
      eq(JSON.stringify(f.env.rows.tasks), original)
      await c.p.onShow()
      eq(c.p.data.today, schedule.addDays(date, 1)); eq(c.p.data.adjustmentRun.is_current, false)
      eq(c.p.data.adjustmentFlow.action, 'requirements'); eq(f.state.calls, 2)
    } finally { f.close() }
  }
  console.log('fixture-clock: ' + checks + ' assertions passed (page/service dates, midnight and three process timezones; offline)')
}
