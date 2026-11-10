// Runs the installed wx-server-sdk + @cloudbase/database against a local wire
// transport. Models optimistic commit conflicts; does NOT emulate the cloud server.
const { createRequire } = require('node:module');
const path = require('node:path');
const appRequire = createRequire(path.resolve(__dirname, '../../cloudfunctions/app/index.js'));
const cloud = appRequire('wx-server-sdk');
const { Db } = appRequire('@cloudbase/database');
const { EJSON } = appRequire('bson');
const clone = value => structuredClone(value);
const keyOf = (name, id) => JSON.stringify([name, id]);
function setPath(row, key, value, increment = false) {
  const parts = key.split('.');
  let target = row;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  const last = parts.at(-1);
  target[last] = increment ? (target[last] || 0) + value : value;
}

function offlineCloudbase(seed, hooks = {}) {
  let rows = clone(seed), serial = 0;
  const versions = new Map(), transactions = new Map();
  // Opt-in model for this native TransactionBusy incident, not a statement
  // that every CloudBase transport always rejects overlapping reads.
  const inFlight = new Set();
  const stats = { starts: 0, commits: 0, conflicts: 0, aborts: 0, wireCalls: 0 };
  const conflict = () => ({ code: 'DATABASE_TRANSACTION_CONFLICT', message: 'database transaction conflict' });
  const matches = (row, query) => Object.entries(query).every(([k, v]) => {
    if (k === '$and') return v.every(clause => matches(row, clause));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    if (v && typeof v === 'object' && ('$gte' in v || '$lte' in v)) {
      return (!('$gte' in v) || row[k] >= v.$gte) && (!('$lte' in v) || row[k] <= v.$lte);
    }
    if (v && typeof v === 'object' && '$eq' in v) return row[k] === v.$eq;
    if (v && typeof v === 'object' && '$ne' in v) return row[k] !== v.$ne;
    if (v && typeof v === 'object' && '$gt' in v) return row[k] > v.$gt;
    return row[k] === v;
  });
  const bump = (name, id) => {
    const key = keyOf(name, id);
    versions.set(key, (versions.get(key) || 0) + 1);
  };
  const mutate = (name, id, patch) => {
    const row = (rows[name] || []).find(r => r._id === id);
    if (row) Object.assign(row, patch);
    bump(name, id);
  };
  const readKey = (tx, name, id) => {
    const key = keyOf(name, id);
    if (tx && !tx.reads.has(key)) tx.reads.set(key, tx.versions.get(key) || 0);
    return key;
  };
  class OfflineRequest {
    async send(command, args = {}) {
      const lock = hooks.serialTransactions && args.transactionId;
      if (lock && inFlight.has(lock)) return { code: 'DATABASE_TRANSACTION_FAIL', message: '[ResourceUnavailable.TransactionBusy] Transaction is busy' };
      if (lock) inFlight.add(lock);
      try {
        if (lock) await new Promise(resolve => setImmediate(resolve));
        return await this.dispatch(command, args);
      } finally { if (lock) inFlight.delete(lock); }
    }
    async dispatch(command, args = {}) {
      stats.wireCalls++;
      if (hooks.beforeRequest) {
        const override = await hooks.beforeRequest(command, args, { rows, mutate, stats });
        if (override !== undefined) return override;
      }
      if (command === 'database.startTransaction') {
        const id = 'tx-' + (++serial);
        transactions.set(id, { reads: new Map(), writes: new Set() });
        stats.starts++;
        return { transactionId: id };
      }
      const tx = args.transactionId && transactions.get(args.transactionId);
      if (command === 'database.commitTransaction') {
        if (hooks.commitConflict && hooks.commitConflict(stats)) { stats.conflicts++; return conflict(); }
        for (const [key, version] of tx.reads) {
          if (hooks.snapshotIsolation && !tx.writes.has(key)) continue;
          if ((versions.get(key) || 0) !== version) { stats.conflicts++; return conflict(); }
        }
        for (const key of tx.writes) {
          const [name, id] = JSON.parse(key);
          const row = tx.rows[name].find(r => r._id === id);
          rows[name] ||= [];
          const index = rows[name].findIndex(r => r._id === id);
          if (!row) { if (index >= 0) rows[name].splice(index, 1); }
          else if (index >= 0) rows[name][index] = clone(row);
          else rows[name].push(clone(row));
          bump(name, id);
        }
        transactions.delete(args.transactionId);
        stats.commits++;
        return {};
      }
      if (command === 'database.abortTransaction') {
        transactions.delete(args.transactionId); stats.aborts++; return {};
      }
      if (tx && !tx.rows) { tx.rows = clone(rows); tx.versions = new Map(versions); }
      const store = tx ? tx.rows : rows;
      const name = args.collectionName;
      const query = args.query ? EJSON.parse(args.query) : {};
      if (command === 'database.calculateDocument') {
        return { data: { total: (store[name] || []).filter(row => matches(row, query)).length } };
      }
      if (command === 'database.getDocument') {
        if (tx) {
          if (args.queryType !== 'DOC') throw new Error('Transaction queries must address a document');
          readKey(tx, name, query._id);
        }
        const list = (store[name] || []).filter(row => matches(row, query));
        if (args.order) {
          const order = EJSON.parse(args.order);
          list.sort((a, b) => { for (const [field, direction] of Object.entries(order)) { if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * direction; } return 0; });
        }
        return { data: { list: list.slice(args.offset || 0, (args.offset || 0) + (args.limit || 100)).map(r => EJSON.stringify(r)) } };
      }
      if (command === 'database.modifyDocument') {
        const selected = (store[name] || []).filter(row => matches(row, query));
        const patch = EJSON.parse(args.data);
        if (args.merge !== true) throw new Error('Only update is supported by this test transport');
        for (const row of selected) {
          if (tx) tx.writes.add(readKey(tx, name, row._id));
          for (const [key, value] of Object.entries(patch.$set || {})) setPath(row, key, value);
          for (const [key, value] of Object.entries(patch.$inc || {})) setPath(row, key, value, true);
          if (Object.keys(patch).some(k => !['$set', '$inc'].includes(k))) throw new Error('Unsupported update operator');
          if (!tx) bump(name, row._id);
        }
        return { data: { updated: selected.length } };
      }
      if (command === 'database.insertDocument') {
        const ids = [];
        for (const item of args.data) {
          const row = EJSON.parse(item);
          row._id ||= 'random-' + (++serial);
          store[name] ||= [];
          if (store[name].some(r => r._id === row._id)) return { code: 'DUPLICATE_KEY', message: 'duplicate _id' };
          if (tx) tx.writes.add(readKey(tx, name, row._id));
          store[name].push(row); ids.push(row._id);
          if (!tx) bump(name, row._id);
        }
        return { data: { insertedIds: ids } };
      }
      if (command === 'database.removeDocument') {
        const selected = (store[name] || []).filter(row => matches(row, query));
        for (const row of selected) {
          if (tx) tx.writes.add(readKey(tx, name, row._id));
          store[name].splice(store[name].findIndex(r => r._id === row._id), 1);
          if (!tx) bump(name, row._id);
        }
        return { data: { deleted: selected.length } };
      }
      throw new Error('Network disabled; unsupported request: ' + command);
    }
  }
  const originalRequest = Db.reqClass;
  cloud.init({ env: 'offline-checkin-tests' });
  Db.reqClass = OfflineRequest;
  return {
    cloud: { init() {}, database(options) {
      const db = cloud.database(options); // SDK initializes reqClass here.
      Db.reqClass = OfflineRequest;
      return db;
    }, getWXContext: () => ({ OPENID: 'owner' }) },
    rows, stats, mutate,
    close() { Db.reqClass = originalRequest; },
  };
}
module.exports = { offlineCloudbase };
