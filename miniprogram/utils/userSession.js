// 登录回执/缓存的形状检查，不替代云函数按真实微信身份授权。
function parseUserSession(value) {
  if (!value || typeof value !== 'object' ||
      typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.openid !== 'string' || !value.openid.trim() ||
      !['admin', 'user'].includes(value.role) ||
      value._offlineMode || value._isLocalAdmin ||
      !['level', 'total_xp', 'streak_days'].every(key => Number.isFinite(value[key]) && value[key] >= 0)) {
    throw new Error('登录信息不完整，请重新登录');
  }
  const user = { ...value };
  delete user._offlineMode;
  delete user._isLocalAdmin;
  return user;
}
function accountScope(data) {
  const info = data?.userInfo;
  const openid = data?.currentOpenid || info?.openid || info?._openid || '';
  if (!openid || typeof info?.id !== 'string' || !info.id.trim() || (info.openid && info.openid !== openid)) return '';
  return JSON.stringify([openid, info.id]);
}

module.exports = { parseUserSession, accountScope };
