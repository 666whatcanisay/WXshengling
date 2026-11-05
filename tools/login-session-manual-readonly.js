// After recompiling and logging in normally. Only reads an existing profile and local cache.
(async () => {
  const { result } = await wx.cloud.callFunction({ name: 'login-node24',
    config: { env: 'cloud1-d5gz9j6zh654f4b36' }, data: {} });
  const server = result.data, cached = wx.getStorageSync('cloud_userInfo');
  const nativeIdentityOk = result.code === 0 && !!server?.id && !!server?.openid;
  const cachedIdentityMatches = !!(nativeIdentityOk && cached && cached.id === server.id &&
    cached.openid === server.openid && cached.role === server.role && cached.username === server.username);
  const cachedNumbersMatch = !!(nativeIdentityOk && cached &&
    ['level', 'total_xp', 'streak_days'].every(key => cached[key] === server[key]));
  console.log('登录会话检查', JSON.stringify({ nativeIdentityOk, cachedIdentityMatches, cachedNumbersMatch,
    legacyFlagsAbsent: !!cached && !('_offlineMode' in cached) && !('_isLocalAdmin' in cached),
    username: server?.username || '', role: server?.role || '',
    cachedOffline: getApp().isOfflineMode }));
})().catch(error => console.log('登录会话检查失败', error.errMsg || error.message || String(error)));
