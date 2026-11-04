// Pet Asset Pipeline — Logger
// =============================

const LOG_LEVELS = { DEBUG: 0, INFO: 1, STEP: 2, WARN: 3, ERROR: 4 };

let currentLevel = LOG_LEVELS.DEBUG;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function format(level, msg) {
  return `[${timestamp()}] [${level}] ${msg}`;
}

module.exports = {
  LOG_LEVELS,

  setLevel(level) {
    currentLevel = level;
  },

  debug(msg) {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
      process.stderr.write(format('DEBUG', msg) + '\n');
    }
  },

  info(msg) {
    if (currentLevel <= LOG_LEVELS.INFO) {
      process.stderr.write(format('INFO', msg) + '\n');
    }
  },

  step(stepNum, totalSteps, msg) {
    if (currentLevel <= LOG_LEVELS.STEP) {
      process.stderr.write(format('STEP', `[${stepNum}/${totalSteps}] ${msg}`) + '\n');
    }
  },

  warn(msg) {
    if (currentLevel <= LOG_LEVELS.WARN) {
      process.stderr.write(format('WARN', msg) + '\n');
    }
  },

  error(msg) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
      process.stderr.write(format('ERROR', msg) + '\n');
    }
  },

  success(msg) {
    process.stderr.write(format('OK', msg) + '\n');
  },

  summary(obj) {
    // Print a summary block to stdout for programmatic consumption
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  },
};
