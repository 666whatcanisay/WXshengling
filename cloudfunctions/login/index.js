// 登录云函数：支持 账号密码登录 / 注册 / 微信授权登录
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const users = db.collection('users');
const _ = db.command;

function buildUserData(user, openid) {
  return {
    id: user._id,
    openid: openid || '',
    username: user.username || '',
    nickname: user.nickname || '森林伙伴',
    avatar: user.avatar || '',
    level: user.level || 1,
    total_xp: user.total_xp || 0,
    streak_days: user.streak_days || 0,
    role: user.role || 'user',
    is_new: false,
    created_at: user.created_at,
  };
}

exports.main = async (event, context) => {
  // ===== 全局 try-catch：防止任何未捕获异常导致超时 =====
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { code: -1, message: '获取用户身份失败' };

    // 兼容 callCloud 的 { action, data: {...} } 格式和直接传参格式
    const raw = event || {};
    const action = (raw.action || '').toString().trim();
    const params = raw.data || raw;
    const { username, password, nickname, avatar, secret } = params;

    console.log('[login] action:', action, 'openid:', OPENID.substring(0, 8) + '...');

    // ====== 1. 账号密码登录 ======
    if (action === 'accountLogin') {
      console.log('[login] accountLogin:', username);

      if (!username || !password) return { code: -1, message: '请输入用户名和密码' };

      // 按用户名查找（不用 status 条件，避免索引问题）
      let userRecord;
      try {
        userRecord = await users.where({ username: _.eq(username) }).get();
      } catch (dbErr) {
        console.error('[login] 查询失败:', dbErr);
        return { code: -1, message: '数据库查询失败: ' + dbErr.message };
      }

      if (!userRecord.data || userRecord.data.length === 0) {
        return { code: -1, message: '用户名不存在' };
      }

      const user = userRecord.data[0];

      // 验证密码
      if (user.password !== password) {
        return { code: -1, message: '密码错误' };
      }

      // 绑定当前 openid
      if (!user._openid) {
        try {
          await users.doc(user._id).update({ data: { _openid: OPENID, updated_at: Date.now() } });
        } catch (e) { /* 绑定失败不影响登录 */ }
        user._openid = OPENID;
      }

      // 更新最后登录时间
      try {
        await users.doc(user._id).update({ data: { last_login_at: Date.now() } });
      } catch (e) { /* 更新失败不影响登录 */ }

      const result = buildUserData(user, OPENID);
      result.is_new = false;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 2. 账号注册 ======
    if (action === 'accountRegister') {
      if (!username || !password) return { code: -1, message: '请填写用户名和密码' };
      if (username.length < 2) return { code: -1, message: '用户名至少2个字符' };

      const existUser = await users.where({ username: _.eq(username) }).count();
      if (existUser.total > 0) {
        return { code: -1, message: '该用户名已被注册' };
      }

      const totalUsers = await users.count();
      const isFirstUser = totalUsers.total === 0;
      const now = Date.now();

      const newUser = {
        _openid: OPENID,
        username: username,
        password: password,
        nickname: nickname || username,
        avatar: avatar || '',
        level: 1, total_xp: 0, streak_days: 0,
        last_checkin_date: '',
        role: isFirstUser ? 'admin' : 'user',
        status: 'active',
        created_at: now, updated_at: now, last_login_at: now,
      };

      const res = await users.add({ data: newUser });
      newUser._id = res._id;

      const result = buildUserData(newUser, OPENID);
      result.is_new = true;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 3. 微信授权登录 ======
    if (action === 'authLogin') {
      let userRecord = await users.where({ _openid: OPENID }).get();
      let isNew = false;
      let user;

      if (!userRecord.data || userRecord.data.length === 0) {
        const totalUsers = await users.count();
        const isFirstUser = totalUsers.total === 0;
        const now = Date.now();
        const newUser = {
          _openid: OPENID, nickname: nickname || '森林伙伴', avatar: avatar || '',
          level: 1, total_xp: 0, streak_days: 0, last_checkin_date: '',
          role: isFirstUser ? 'admin' : 'user', status: 'active',
          created_at: now, updated_at: now, last_login_at: now,
        };
        const res = await users.add({ data: newUser });
        newUser._id = res._id;
        user = newUser;
        isNew = true;
      } else {
        user = userRecord.data[0];
        const updateData = { updated_at: Date.now(), last_login_at: Date.now() };
        if (nickname) updateData.nickname = nickname;
        if (avatar) updateData.avatar = avatar;
        if (Object.keys(updateData).length > 2) {
          await users.doc(user._id).update({ data: updateData });
          Object.assign(user, updateData);
        }
        if (!user.role) {
          await users.doc(user._id).update({ data: { role: 'user' } });
          user.role = 'user';
        }
      }

      const result = buildUserData(user, OPENID);
      result.is_new = isNew;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 4. 静默登录（默认） ======
    let userRecord = await users.where({ _openid: OPENID }).get();

    if (!userRecord.data || userRecord.data.length === 0) {
      return { code: -2, message: '用户未注册，请先登录', needAuth: true };
    }

    const user = userRecord.data[0];
    const result = buildUserData(user, OPENID);
    return { code: 0, data: result, message: 'ok' };

  } catch (err) {
    // 捕获所有异常，返回错误信息而不是让函数超时挂起
    console.error('[login] 未捕获异常:', err);
    return {
      code: -1,
      message: '服务器内部错误: ' + (err.message || JSON.stringify(err)),
    };
  }
};
