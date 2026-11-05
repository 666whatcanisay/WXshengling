// Run after the approved legacy app update. Read-only; never prints openid/data rows.
(async () => {
  const call = async (name, data) => (await wx.cloud.callFunction({ name,
    config: { env: 'cloud1-d5gz9j6zh654f4b36' }, data })).result;
  const login = await call('login', {});
  if (login.code !== 0 || login.data?.username !== 'lzk' || login.data?.role !== 'admin') {
    console.log('旧版补丁只读检查', JSON.stringify({ identityOk: false, message: login.message || '账号不符' })); return;
  }
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), checks = [];
  for (const [name, action, data] of [
    ['app', 'listTasks', { date: today }], ['app', 'adminDashboard', {}],
    ['app-node24', 'listTasks', { date: today }],
  ]) {
    try {
      const r = await call(name, { action, data });
      checks.push({ name, action, ok: r.code !== -1 && (r.success === true || r.code === 0), message: r.message || '' });
    } catch (error) { checks.push({ name, action, ok: false, message: error.errMsg || error.message || String(error) }); }
  }
  console.log('旧版补丁只读检查', JSON.stringify({ identityOk: true, username: 'lzk', role: 'admin', checks }));
})().catch(error => console.log('旧版补丁只读检查失败', error.errMsg || error.message || String(error)));
