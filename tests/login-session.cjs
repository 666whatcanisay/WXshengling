// Production Login Page + App/session helper, isolated API results and local storage.
// No real credentials, cloud login, registration or database writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
let assertions = 0, scenarios = 0;
const clone = value => structuredClone(value);
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const eq = (a, b) => { assert.deepEqual(plain(a), plain(b)); assertions++; };
const user = (extra = {}) => ({ id: 'u', openid: 'owner', username: 'lzk', nickname: '真实昵称',
  role: 'user', level: 0, total_xp: 0, streak_days: 0, created_at: 0, is_new: false, ...extra });
const methods = [
  ['handleAccountLogin', 'accountLogin', 'loading'],
  ['handleAccountRegister', 'accountRegister', 'regLoading'],
  ['handleWechatLoginQuick', 'authLogin', 'wxLoginLoading'],
];
function load(options = {}) {
  const store = new Map(Object.entries(options.cached ? { cloud_userInfo: options.cached, cached_tasks: ['old'] } : {}));
  store.set('unrelated_setting', 'keep');
  const toasts = [], navigation = [], requests = [];
  const api = Object.fromEntries(methods.map(([, name]) => [name, async data => {
    requests.push({ name, data: clone(data) });
    if ('error' in options) throw options.error;
    return typeof options.reply === 'function' ? options.reply() : clone(options.reply);
  }]));
  const wx = {
    cloud: { init() {} }, getStorageSync: key => clone(store.get(key)),
    setStorageSync(key, value) { if (options.storageFail) throw new Error('STORAGE_FULL'); store.set(key, clone(value)); },
    removeStorageSync: key => store.delete(key),
    showToast: value => toasts.push(clone(value)), switchTab: value => navigation.push(clone(value)),
    login({ success, fail }) { if (options.wxFail) fail({ errMsg: 'wx.login failed' }); else success({ code: options.noCode ? '' : 'test-code' }); },
  };
  let app, page;
  const appFile = path.join(root, 'miniprogram/app.js'), appRequire = createRequire(appFile);
  vm.runInNewContext(fs.readFileSync(appFile, 'utf8'), {
    App(value) { app = value; }, wx, console: quiet,
    require: name => name.endsWith('/cloudApi') ? api : appRequire(name),
  });
  app.onLaunch();
  const pageFile = path.join(root, 'miniprogram/pages/login/login.js'), pageRequire = createRequire(pageFile);
  vm.runInNewContext(fs.readFileSync(pageFile, 'utf8'), {
    Page(value) { page = value; }, wx, getApp: () => app, console: quiet,
    require: name => name.endsWith('/cloudApi') ? api : pageRequire(name),
    setTimeout(fn) { fn(); },
  });
  page.data = clone(page.data);
  page.setData = patch => Object.assign(page.data, clone(patch));
  Object.assign(page.data, { agreed: true, username: 'lzk', password: 'test-only',
    regUsername: 'lzk', regPassword: 'test-only', regPassword2: 'test-only', regNickname: '注册昵称' });
  return { app, page, store, toasts, navigation, requests };
}
function failed(fixture, flag) {
  eq(fixture.navigation.length, 0); eq(fixture.page.data[flag], false);
  eq(fixture.toasts.some(t => t.icon === 'success'), false);
  eq(fixture.store.get('unrelated_setting'), 'keep');
}
(async () => {
  for (const [method, apiName, flag] of methods) {
    const response = user(), f = load({ reply: response });
    await f.page[method]();
    eq(f.requests[0].name, apiName); eq(f.app.globalData.userInfo, response);
    eq(f.store.get('cloud_userInfo'), response); eq(f.app.globalData.currentOpenid, 'owner');
    eq(f.app.isOfflineMode, false); eq(f.page.data[flag], false); eq(f.navigation.length, 1);
    eq(f.toasts.some(t => /管理员/.test(t.title)), false);
    eq(f.app.globalData.userInfo.total_xp, 0); eq(f.app.globalData.userInfo.level, 0);
    eq(f.app.globalData.userInfo.streak_days, 0); eq(f.app.globalData.userInfo.created_at, 0);
    scenarios++;
    const admin = load({ reply: user({ username: 'another-name', role: 'admin', total_xp: 17, level: 3, streak_days: 2 }) });
    await admin.page[method]();
    eq(admin.app.globalData.userInfo.total_xp, 17); eq(admin.app.globalData.userInfo.role, 'admin');
    eq(admin.toasts.some(t => /管理员/.test(t.title)), true); scenarios++;
    for (const error of ['network timeout', new Error('密码错误'), { errMsg: '网络不可用' }, null]) {
      const previous = user({ id: 'previous', openid: 'previous-owner' });
      const fail = load({ error, cached: previous });
      await fail.page[method](); failed(fail, flag);
      eq(fail.app.globalData.userInfo, previous); eq(fail.store.get('cloud_userInfo'), previous);
      if (apiName === 'accountRegister' && error === 'network timeout') eq(/结果未确认/.test(fail.toasts.at(-1).title), true);
      scenarios++;
    }
    for (const reply of [undefined, null, { code: -2, needAuth: true }, user({ id: '' }), user({ openid: '' }),
      user({ role: undefined }), user({ total_xp: '0' }), user({ level: NaN }), user({ streak_days: -1 }),
      user({ _offlineMode: true }), user({ _isLocalAdmin: true })]) {
      const invalid = load({ reply }); await invalid.page[method](); failed(invalid, flag);
      eq(invalid.app.globalData.userInfo, null); eq(invalid.store.has('cloud_userInfo'), false); scenarios++;
    }
    const full = load({ reply: user(), storageFail: true }); await full.page[method](); failed(full, flag);
    eq(full.app.globalData.userInfo, null); eq(full.app.globalData.currentOpenid, ''); scenarios++;
  }
  for (const cached of [user({ _offlineMode: true }), user({ _isLocalAdmin: true, role: 'admin', total_xp: 2680 }),
    user({ id: 'admin_fake', openid: '' })]) {
    const f = load({ cached }); eq(f.app.globalData.userInfo, null); eq(f.app.globalData.currentOpenid, '');
    eq(f.app.isLoggedIn, false); eq(f.store.has('cloud_userInfo'), false); eq(f.store.has('cached_tasks'), false);
    eq(f.store.get('unrelated_setting'), 'keep'); scenarios++;
  }
  const cached = user({ role: 'admin', total_xp: 0 });
  const restored = load({ cached }); eq(restored.app.globalData.userInfo, cached); eq(restored.app.isLoggedIn, true);
  eq(restored.app.globalData.currentOpenid, 'owner'); eq(restored.requests.length, 0); scenarios++;
  for (const options of [{ wxFail: true }, { noCode: true }]) {
    const f = load({ ...options, reply: user() }); await f.page.handleWechatLoginQuick();
    failed(f, 'wxLoginLoading'); eq(f.requests.length, 0); scenarios++;
  }
  let resolve;
  const delayed = load({ reply: () => new Promise(r => { resolve = r; }) });
  const pending = delayed.page.handleAccountLogin();
  await delayed.page.handleAccountLogin(); await delayed.page.handleWechatLoginQuick();
  eq(delayed.requests.length, 1); resolve(user()); await pending; eq(delayed.navigation.length, 1); scenarios++;
  console.log(JSON.stringify({ passed: assertions, scenarios, cloudWrites: false,
    scope: 'Production Login Page, App and session helper with isolated API/storage; not real WeChat login verification' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
