// 登录云函数：支持 账号密码登录 / 注册 / 微信授权登录
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');
const db = cloud.database();
const users = db.collection('users');
const _ = db.command;

// SHA256 密码哈希（加固定盐值，生产环境应使用随机盐）
function hashPassword(password) {
  return crypto.createHash('sha256').update('forest_camp_salt_' + password).digest('hex');
}

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

      // 验证密码（兼容旧明文密码和新的哈希密码）
      var hashedInput = hashPassword(password);
      if (user.password !== password && user.password !== hashedInput) {
        return { code: -1, message: '密码错误' };
      }

      // 【V12 一微信一账号】如果账号已绑定其他微信，拒绝当前微信登录
      if (user._openid && user._openid !== OPENID) {
        return { code: -1, message: '该账号已绑定其他微信号，请使用已绑定的微信号登录' };
      }

      // 绑定当前 openid（仅首次登录时绑定）
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

      // 同一微信用户(同一openid)限注册1个账号
      const existByOpenid = await users.where({ _openid: _.eq(OPENID) }).count();
      if (existByOpenid.total >= 1) {
        const existing = (await users.where({ _openid: _.eq(OPENID) }).get()).data;
        const names = existing.map(u => u.username || '').join('、');
        return { code: -1, message: '该微信号已注册过' + existByOpenid.total + '个账号（' + names + '），请直接登录' };
      }

      const totalUsers = await users.count();
      const isFirstUser = totalUsers.total === 0;
      const now = Date.now();

      const newUser = {
        _openid: OPENID,
        username: username,
        password: hashPassword(password),
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

    // ====== 3. 微信授权登录（V12：一微信一账号，保护管理员角色）=====
    if (action === 'authLogin') {
      // 按 openid 查找已有账号（一个微信只能对应一个账号）
      let userRecord = await users.where({ _openid: OPENID }).get();
      let isNew = false;
      let user;

      if (!userRecord.data || userRecord.data.length === 0) {
        // 新用户：创建账号（第一个用户是 admin，其余都是普通用户）
        const totalUsers = await users.count();
        const isFirstUser = totalUsers.total === 0;
        const now = Date.now();
        const newUser = {
          _openid: OPENID,
          nickname: nickname || '森林伙伴',
          avatar: avatar || '',
          level: 1, total_xp: 0, streak_days: 0, last_checkin_date: '',
          role: isFirstUser ? 'admin' : 'user',
          status: 'active',
          created_at: now, updated_at: now, last_login_at: now,
        };
        const res = await users.add({ data: newUser });
        newUser._id = res._id;
        user = newUser;
        isNew = true;
        console.log('[login] authLogin 新用户创建 role=' + newUser.role);
      } else {
        // 已有账号：更新登录信息和昵称头像
        user = userRecord.data[0];
        const updateData = { last_login_at: Date.now(), updated_at: Date.now() };
        if (nickname && nickname !== '森林伙伴') updateData.nickname = nickname;
        if (avatar) updateData.avatar = avatar;
        await users.doc(user._id).update({ data: updateData });
        Object.assign(user, updateData);

        // 【V12】保护已有管理员角色，绝不降级
        // 只在 role 为空时才补充默认值
        if (!user.role || user.role === '') {
          // 检查是否已存在管理员
          const adminCount = await users.where({ role: 'admin' }).count();
          user.role = (adminCount.total === 0) ? 'admin' : 'user';
          await users.doc(user._id).update({ data: { role: user.role } });
        }
        console.log('[login] authLogin 已有用户 role=' + user.role);
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
