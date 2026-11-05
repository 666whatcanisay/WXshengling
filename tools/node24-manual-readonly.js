// Paste into WeChat DevTools Console. Read-only: no registration or business writes.
// It reports account names/roles and success flags, never openid or balances.
(async () => {
  const call = async (name, data) => (await wx.cloud.callFunction({ name, data })).result;
  const oldLogin = await call('login', {});
  if (oldLogin.code !== 0 || oldLogin.data?.username !== 'lzk') {
    console.log('NODE24只读检查', JSON.stringify({ identityOk: false, code: oldLogin.code,
      username: oldLogin.data?.username || '', message: oldLogin.message || '' }));
    return;
  }
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const results = [];
  for (const [name, data] of [['login-node24', {}],
    ['app', { action: 'listTasks', data: { date: today } }],
    ['app-node24', { action: 'listTasks', data: { date: today } }]]) {
    try {
      const result = await call(name, data);
      results.push({ name, code: result.code ?? 0, ok: name === 'login-node24'
        ? result.code === 0 && result.data?.username === 'lzk' : result.success === true,
        message: result.message || '' });
    } catch (error) { results.push({ name, ok: false, message: error.errMsg || error.message || String(error) }); }
  }
  let directClientReadDenied;
  try { await wx.cloud.database().collection('users').doc(oldLogin.data.id).get(); directClientReadDenied = false; }
  catch (error) { directClientReadDenied = /permission|权限|denied|authorit/i.test(error.errMsg || error.message || String(error)); }
  console.log('NODE24只读检查', JSON.stringify({ identityOk: true, username: 'lzk', role: oldLogin.data.role,
    checks: results, directClientReadDenied }));
})().catch(error => console.log('NODE24只读检查失败', error.errMsg || error.message || String(error)));
