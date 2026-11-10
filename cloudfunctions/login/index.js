// 登录云函数：支持 账号密码登录 / 注册 / 微信授权登录
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');
const db = cloud.database();
const users = db.collection('users');
const _ = db.command;
const accountDb = cloud.database({ throwOnNotFound: false });
const claimKey = (kind, value) => kind + '-' + crypto.createHash('sha256').update(value).digest('hex');
// Allow all login endpoints sharing a user store to gain read compatibility first.
const scryptWrites = typeof process === 'undefined' || process.env.FOREST_SCRYPT_WRITE !== '0';

function bannedAccount() {
  return { code: -1, reason: 'ACCOUNT_BANNED', message: '账号已封禁，请联系管理员' };
}

// SHA256 密码哈希（加固定盐值，生产环境应使用随机盐）
function legacyHash(password) {
  return crypto.createHash('sha256').update('forest_camp_salt_' + password).digest('hex');
}

// The app cloud function uses the same format when resetting a password.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return 'scrypt-v1:' + salt + ':' + digest.toString('hex');
}

function matchesPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  if (stored.startsWith('scrypt-v1:')) {
    const parts = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(stored);
    return !!parts && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hashPassword(password, parts[1])));
  }
  return /^[a-f0-9]{64}$/.test(stored) ? stored === legacyHash(password) : stored === password;
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

async function readClaim(tx, id) {
  const { data: claim } = await tx.collection('account_claims').doc(id).get();
  const account = claim ? (await tx.collection('users').doc(claim.user_id).get()).data : null;
  return { id, claim, account };
}

async function saveClaim(tx, entry, userId) {
  const collection = tx.collection('account_claims');
  if (!entry.claim) {
    await collection.add({ data: { _id: entry.id, user_id: userId } });
  } else if (entry.claim.user_id !== userId) {
    const result = await collection.doc(entry.id).update({ data: { user_id: userId } });
    if (result.stats?.updated !== 1) throw new Error('账号登记未保存');
  }
}

async function bindLegacy(user, openid) {
  return accountDb.runTransaction(async tx => {
    const binding = await readClaim(tx, claimKey('wechat', openid));
    const { data: current } = await tx.collection('users').doc(user._id).get();
    if (!current || current.password !== user.password || current.username !== user.username) {
      return { error: { code: -1, message: '账号资料已变化，请重新登录' } };
    }
    if (current.status === 'banned' || binding.account?.status === 'banned') return { error: bannedAccount() };
    if (current._openid && current._openid !== openid) {
      return { error: { code: -1, message: '该账号已绑定其他微信号，请使用已绑定的微信号登录' } };
    }
    if (binding.account && binding.account._id !== current._id) {
      return { error: { code: -1, message: '该微信号已绑定其他账号，请直接登录' } };
    }
    const sessionBinding = binding.claim && !binding.account ? { requires_session_id: true } : {};
    if (!current._openid) {
      const updated = await tx.collection('users').doc(current._id).update({ data: {
        _openid: openid, ...sessionBinding, updated_at: Date.now(),
      } });
      if (updated.stats?.updated !== 1) throw new Error('微信绑定未保存，请重试');
    }
    await saveClaim(tx, binding, current._id);
    return { user: { ...current, _openid: openid, ...sessionBinding } };
  });
}

async function createAccount(openid, profile, firstCandidate) {
  const username = profile.username;
  return accountDb.runTransaction(async tx => {
    const binding = await readClaim(tx, claimKey('wechat', openid));
    if (binding.account) {
      if (binding.account.status === 'banned') return { error: bannedAccount() };
      if (!username && binding.account._openid === openid) return { user: binding.account, isNew: false };
      return { error: { code: -1, message: '该微信号已注册过账号，请直接登录' } };
    }
    const name = username && await readClaim(tx, claimKey('username', username));
    if (name?.account) return { error: { code: -1, message: '该用户名已被注册' } };
    const bootstrap = firstCandidate && await readClaim(tx, 'first-admin');
    const role = bootstrap && !bootstrap.claim ? 'admin' : 'user';
    const now = Date.now();
    const id = crypto.randomBytes(16).toString('hex');
    const user = { ...profile, _id: id, _openid: openid, level: 1, total_xp: 0, streak_days: 0,
      ...(binding.claim ? { requires_session_id: true } : {}),
      last_checkin_date: '', role, status: 'active', created_at: now, updated_at: now, last_login_at: now };
    await tx.collection('users').add({ data: user });
    await saveClaim(tx, binding, id);
    if (name) await saveClaim(tx, name, id);
    if (role === 'admin') await saveClaim(tx, bootstrap, id);
    return { user, isNew: true };
  });
}

async function refreshWechatAccount(account, openid, profile) {
  const canRestoreAdmin = !account.role && (await users.where({ role: 'admin' }).count()).total === 0;
  return accountDb.runTransaction(async tx => {
    const row = tx.collection('users').doc(account._id);
    const { data: current } = await row.get();
    if (!current || current._openid !== openid) {
      return { error: { code: -1, message: '账号资料已变化，请重新登录' } };
    }
    if (current.status === 'banned') return { error: bannedAccount() };
    const bootstrap = !current.role && canRestoreAdmin && await readClaim(tx, 'first-admin');
    const now = Date.now();
    const patch = { ...profile, last_login_at: now, updated_at: now };
    if (!current.role) patch.role = bootstrap && !bootstrap.claim ? 'admin' : 'user';
    const result = await row.update({ data: patch });
    if (result.stats?.updated !== 1) throw new Error('账号登录状态未保存，请重试');
    if (patch.role === 'admin') await saveClaim(tx, bootstrap, current._id);
    return { user: { ...current, ...patch } };
  });
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
    const { username, password, nickname, avatar } = params;

    console.log('[login] action:', action, 'openid:', OPENID.substring(0, 8) + '...');

    // ====== 1. 账号密码登录 ======
    if (action === 'accountLogin') {
      console.log('[login] accountLogin:', username);

      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || password.length > 1024) return { code: -1, message: '请输入有效的用户名和密码' };

      // 按用户名查找（不用 status 条件，避免索引问题）
      let userRecord;
      try {
        userRecord = await users.where({ username: _.eq(username) }).limit(2).get();
      } catch (dbErr) {
        console.error('[login] 查询失败:', dbErr);
        return { code: -1, message: '数据库查询失败: ' + dbErr.message };
      }

      if (!userRecord.data || userRecord.data.length === 0) {
        return { code: -1, message: '用户名不存在' };
      }
      if (userRecord.data.length > 1) return { code: -1, message: '用户名对应多个账号，请联系管理员' };

      let user = userRecord.data[0];

      // 验证密码（兼容旧明文密码和新的哈希密码）
      if (!matchesPassword(password, user.password)) {
        return { code: -1, message: '密码错误' };
      }

      // 【V12 一微信一账号】如果账号已绑定其他微信，拒绝当前微信登录
      if (user._openid && user._openid !== OPENID) {
        return { code: -1, message: '该账号已绑定其他微信号，请使用已绑定的微信号登录' };
      }
      if (user.status === 'banned') return bannedAccount();
      const { data: bound } = await users.where({ _openid: OPENID }).limit(2).get();
      if (bound.some(account => account.status === 'banned')) return bannedAccount();
      if (bound.length > 1) return { code: -1, message: '该微信号对应多个账号，请联系管理员' };

      // 绑定当前 openid（仅首次登录时绑定）
      if (bound.length) {
        if (bound[0]._id !== user._id) return { code: -1, message: '该微信号已绑定其他账号，请直接登录' };
        if (bound[0].password !== user.password) return { code: -1, message: '账号资料已变化，请重新登录' };
        user = bound[0];
      } else if (!user._openid) {
        const binding = await bindLegacy(user, OPENID);
        if (binding.error) return binding.error;
        user = binding.user;
      } else {
        return { code: -1, message: '账号资料已变化，请重新登录' };
      }

      // 更新最后登录时间
      try {
        if (!scryptWrites || user.password.startsWith('scrypt-v1:')) {
          await users.doc(user._id).update({ data: { last_login_at: Date.now() } });
        } else {
          // Compare the old value so a concurrent admin reset cannot be overwritten.
          await users.where({ _id: user._id, password: user.password }).update({
            data: { password: hashPassword(password), last_login_at: Date.now() },
          });
        }
      } catch (e) { /* 更新失败不影响登录 */ }

      const result = buildUserData(user, OPENID);
      result.is_new = false;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 2. 账号注册 ======
    if (action === 'accountRegister') {
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || password.length > 1024) return { code: -1, message: '请填写有效的用户名和密码' };
      if (username.trim().length < 2) return { code: -1, message: '用户名至少2个字符' };

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
      const created = await createAccount(OPENID, {
        username: username,
        password: scryptWrites ? hashPassword(password) : legacyHash(password),
        nickname: nickname || username,
        avatar: avatar || '',
      }, totalUsers.total === 0);
      if (created.error) return created.error;

      const result = buildUserData(created.user, OPENID);
      result.is_new = true;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 3. 微信授权登录（V12：一微信一账号，保护管理员角色）=====
    if (action === 'authLogin') {
      // 按 openid 查找已有账号（一个微信只能对应一个账号）
      const userRecord = await users.where({ _openid: OPENID }).limit(2).get();
      if (userRecord.data?.some(user => user.status === 'banned')) return bannedAccount();
      if (userRecord.data?.length > 1) return { code: -1, message: '该微信号对应多个账号，请联系管理员' };
      let isNew = false;
      let user;

      if (!userRecord.data || userRecord.data.length === 0) {
        // 新用户：创建账号（第一个用户是 admin，其余都是普通用户）
        const totalUsers = await users.count();
        const created = await createAccount(OPENID, {
          nickname: nickname || '森林伙伴',
          avatar: avatar || '',
        }, totalUsers.total === 0);
        if (created.error) return created.error;
        user = created.user;
        isNew = created.isNew;
      } else {
        const profile = {};
        if (nickname && nickname !== '森林伙伴') profile.nickname = nickname;
        if (avatar) profile.avatar = avatar;
        const refreshed = await refreshWechatAccount(userRecord.data[0], OPENID, profile);
        if (refreshed.error) return refreshed.error;
        user = refreshed.user;
      }

      const result = buildUserData(user, OPENID);
      result.is_new = isNew;
      return { code: 0, data: result, message: 'ok' };
    }

    // ====== 4. 静默登录（默认） ======
    const userRecord = await users.where({ _openid: OPENID }).limit(2).get();
    if (userRecord.data?.some(user => user.status === 'banned')) return bannedAccount();
    if (userRecord.data?.length > 1) return { code: -1, message: '该微信号对应多个账号，请联系管理员' };

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
