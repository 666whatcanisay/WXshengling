// Pet Asset Pipeline — Quota Manager Dry-Run Test
// ===================================================
// Tests quota exhaustion and model failover WITHOUT making
// any real API calls. Simulates:
//   1. Normal: first model available
//   2. Failover: first model exhausted → second model used
//   3. Exhaustion: all models exhausted → FREE_QUOTA_EXHAUSTED
//
// Usage: node pipeline/scripts/test-quota.js

const quota = require('../lib/quota-manager');
const config = require('../config');

function header(msg) {
  console.log('\n' + '='.repeat(55));
  console.log('  ' + msg);
  console.log('='.repeat(55));
}

function pass(msg) {
  console.log('  ✅ PASS: ' + msg);
}

function fail(msg) {
  console.log('  ❌ FAIL: ' + msg);
  process.exitCode = 1;
}

// ---- Test 1: Initial State ----
header('Test 1: Initial State — All Models Available');

quota.resetAll();

const priority = config.MODEL_PRIORITY;
console.log('  Model priority:');
priority.forEach((m, i) => console.log(`    ${i + 1}. ${m}`));
console.log(`  ALLOW_PAID_MODEL: ${config.ALLOW_PAID_MODEL}`);
console.log(`  MODEL_CALL_LIMIT: ${config.MODEL_CALL_LIMIT || 'unlimited'}`);

try {
  const model = quota.getAvailableModel();
  if (model === priority[0]) {
    pass(`First model selected: ${model}`);
  } else {
    fail(`Expected ${priority[0]}, got ${model}`);
  }
} catch (err) {
  fail(`Should not throw: ${err.message}`);
}

// ---- Test 2: Check Individual Model ----
header('Test 2: Check Individual Model Quota');

const status = quota.checkModelQuota(priority[0]);
console.log(`  Model:  ${status.model}`);
console.log(`  Free:   ${status.freeRemaining}`);
console.log(`  Used:   ${status.callsUsed}`);
console.log(`  Status: ${status.status}`);

if (status.available && status.model === priority[0]) {
  pass('checkModelQuota returns correct available status');
} else {
  fail('checkModelQuota: expected available=true');
}

// ---- Test 3: Record Calls — Simulate Usage ----
header('Test 3: Record API Calls');

for (let i = 0; i < 5; i++) {
  quota.recordCall(priority[0]);
}
const afterCalls = quota.checkModelQuota(priority[0]);
console.log(`  After 5 calls: used=${afterCalls.callsUsed}, available=${afterCalls.available}`);
if (afterCalls.callsUsed === 5) {
  pass('Recorded 5 API calls correctly');
} else {
  fail(`Expected callsUsed=5, got ${afterCalls.callsUsed}`);
}

// ---- Test 4: Mark Model Exhausted + Failover ----
header('Test 4: Mark Model Exhausted → Failover');

quota.markExhausted(priority[0], 'Simulated Arrearage');

try {
  const nextModel = quota.getAvailableModel();
  console.log(`  ${priority[0]} exhausted → switched to ${nextModel}`);

  if (nextModel === priority[1]) {
    pass(`Failover to second model: ${nextModel}`);
  } else if (nextModel === priority[0]) {
    fail(`Still returning exhausted model ${nextModel}`);
  } else {
    fail(`Unexpected model: ${nextModel}`);
  }
} catch (err) {
  fail(`Failover should not throw: ${err.message}`);
}

// ---- Test 5: Exhaust All Models ----
header('Test 5: Exhaust All Models → FREE_QUOTA_EXHAUSTED');

// Mark remaining models as exhausted
for (let i = 1; i < priority.length; i++) {
  quota.markExhausted(priority[i], 'Simulated Arrearage');
}

try {
  quota.getAvailableModel();
  fail('Should have thrown FREE_QUOTA_EXHAUSTED');
} catch (err) {
  if (err.name === 'FREE_QUOTA_EXHAUSTED') {
    pass('FREE_QUOTA_EXHAUSTED thrown correctly');
    console.log('  Error name: ' + err.name);
  } else {
    fail(`Wrong error type: ${err.name} — ${err.message}`);
  }
}

// ---- Test 6: Full Report ----
header('Test 6: Full Quota Report');

const report = quota.getReport();
for (const [model, info] of Object.entries(report)) {
  const icon = info.available ? '🟢' : '🔴';
  console.log(`  ${icon} ${model}`);
  console.log(`     callsUsed=${info.callsUsed} remaining=${info.freeRemaining} status=${info.status}`);
}

pass('Full report generated');

// ---- Test 7: Reset ----
header('Test 7: Reset All State');

quota.resetAll();

const afterReset = quota.getReport();
const allAvailable = Object.values(afterReset).every(r => r.available);
if (allAvailable) {
  pass('Reset restores all models to available');
} else {
  fail('Reset did not restore all models');
}

// ---- Summary ----
header('Test Summary');

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('  🎉 ALL TESTS PASSED');
  console.log('');
  console.log('  Quota Manager is ready for production.');
  console.log('  No real API calls were made during this test.');
} else {
  console.log('  ⚠️  SOME TESTS FAILED — check output above.');
}

console.log('');
process.exit(process.exitCode || 0);
