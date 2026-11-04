/**
 * 新用户异常排查脚本 — 全链路诊断
 *
 * 模拟真实微信小程序启动流程，逐步打印数据库状态。
 *
 * 真实调用链 (从源码追踪):
 *
 *   1. splash.js (1.5s) → login/login 页面
 *   2. 用户注册 → cloudApi.accountRegister()
 *      → 【login云函数】action=accountRegister
 *      → 写入 users 集合 (_openid, username, password, ...)
 *   3. 注册成功 → wx.switchTab('/pages/home/home')
 *   4. home.js onShow → loadDashboard()
 *      → cloudApi.dashboard() → 【app云函数】action=getDashboard
 *      → 查 users + pets(按_openid) + goals + tasks + checkins
 *      → 返回 activePet = pets[0]
 *   5. 用户切到宠物Tab → pets.js onShow
 *      → loadData() → cloudApi.petOverview() → 【app】action=listPets
 *      → loadGrowthPool() → cloudApi.getGrowthPool() → 【app】action=getGrowthPool
 *   6. pets.js 检查 res.starter_claimed → 决定是否显示"领取新手礼包"
 *   7. 用户点击领取 → cloudApi.claimStarterXp() → 【app】action=claimStarterXp
 *
 * 用法: node tests/bug-diag-newuser.js
 */

var fs = require('fs');
var path = require('path');

// ===== 内存模拟云环境 =====
var db = {
  _collections: {},
  _init: function(){
    ['users','pets','user_growth_pool','growth_logs','checkins','goals','tasks','achievements'].forEach(function(n){
      db._collections[n]=[];
    });
  },
  collection: function(name) {
    if (!db._collections[name]) db._collections[name] = [];
    var selfArr = db._collections[name];
    return {
      // 直接在集合上调用 .count() (login云函数需要)
      count: async function(){ return {total: selfArr.length}; },
      where: function(q) {
        return {
          get: async function(){
            var arr = (db._collections[name]||[]).filter(function(d){
              for(var k in q) {
                var v = q[k];
                if(v && typeof v === 'object' && v.$ne !== undefined){
                  if(d[k] === v.$ne) return false;
                } else {
                  if(d[k] !== v) return false;
                }
              }
              return true;
            });
            return { data: arr };
          },
          count: async function(){
            var c = (db._collections[name]||[]).filter(function(d){
              for(var k in q) {
                var v = q[k];
                if(v && typeof v === 'object' && v.$ne !== undefined){
                  if(d[k] === v.$ne) return false;
                } else {
                  if(d[k] !== v) return false;
                }
              }
              return true;
            });
            return { total: c.length };
          },
          update: function(u){
            (db._collections[name]||[]).forEach(function(d){
              var match = true;
              for(var k in q) if(d[k] !== q[k]) { match = false; break; }
              if(match) for(var k in u.data) {
                var v = u.data[k];
                if(v && typeof v==='object' && v.$inc!==undefined) d[k]=(d[k]||0)+v.$inc;
                else if(v && typeof v==='object' && v.$push!==undefined) { if(!d[k]) d[k]=[]; d[k].push(v.$push); }
                else d[k]=v;
              }
            });
            return Promise.resolve({updated:1});
          }
        };
      },
      add: function(a){
        var d = Object.assign({_id:'id_'+Date.now()+'_'+Math.random().toString(36).substr(2,6)}, a.data);
        d.created_at = d.created_at || Date.now();
        (db._collections[name]||[]).push(d);
        return Promise.resolve({_id:d._id});
      },
      doc: function(id){
        return {
          update: function(u){
            var arr = db._collections[name]||[];
            for(var i=0;i<arr.length;i++){
              if(arr[i]._id === id || arr[i].id === id){
                for(var k in u.data) arr[i][k] = u.data[k];
              }
            }
            return Promise.resolve({updated:1});
          }
        };
      },
      createCollection: async function(){
        if(!db._collections[name]) db._collections[name]=[];
        throw new Error('already exists');
      }
    };
  },
};
var _ = {
  inc: function(n){ return {$inc:n}; },
  push: function(v){ return{$push:v}; },
  eq: function(v){ return v; },
  neq: function(v){ return {$ne:v}; },
  ne: function(v){ return {$ne:v}; }
};
var cloud = {
  DYNAMIC_CURRENT_ENV:'test-env',
  init:function(){},
  getWXContext:function(){ return {OPENID: currentOpenid}; },
  database:function(){ return db; }
};

var currentOpenid = '';

function todayStr(){ return new Date().toISOString().slice(0,10); }
async function safeQuery(c,q){ try{ return(await db.collection(c).where(q).get()).data||[]; }catch(e){return [];} }
async function safeAdd(c,d){ try{ return await db.collection(c).add({data:d}); }catch(e){throw e;} }
async function safeUpdate(c,q,d){ try{ return await db.collection(c).where(q).update({data:d}); }catch(e){throw e;} }
async function ensureCollection(n){ if(!db._collections[n]) db._collections[n]=[]; return true; }

// ===== 日志系统 =====
var LOG = [];
function logStep(phase, action, detail){
  var entry = {
    ts: new Date().toISOString().slice(11,23),
    phase: phase,
    action: action,
    detail: detail,
    // 快照
    dbSnapshot: {
      users: (db._collections['users']||[]).length,
      pets: (db._collections['pets']||[]).length,
      pool: (db._collections['user_growth_pool']||[]).length,
      logs: (db._collections['growth_logs']||[]).length,
    }
  };
  LOG.push(entry);
  console.log('  ['+entry.ts+'] '+phase+' | '+action+(detail ? ' — '+detail : ''));
}

function dumpDB(label){
  var u = db._collections['users']||[];
  var p = db._collections['pets']||[];
  var gp = db._collections['user_growth_pool']||[];
  console.log('  ┌─ DB快照('+label+') ──────────────────────');
  console.log('  │ users: '+u.length+' | pets: '+p.length+' | pool: '+gp.length);
  if(u.length>0){
    var user=u[0]; console.log('  │ user: _openid='+(user._openid||'?').slice(0,12)+'... nickname='+(user.nickname||'?')+' role='+(user.role||'?'));
  }
  if(p.length>0){
    p.forEach(function(pet,i){
      console.log('  │ pet['+i+']: name='+(pet.name||'?')+' stage='+(pet.stage||'?')+' is_hatched='+pet.is_hatched+' species='+(pet.species||'')+' egg_type='+(pet.egg_type||''));
    });
  }
  if(gp.length>0){
    var pool=gp[0]; console.log('  │ pool: growth_pool='+(pool.growth_pool||0)+' total_earned='+(pool.total_earned||0)+' starter_claimed='+(pool.starter_claimed)+' claimed_at='+(pool.starter_claimed_at||''));
  }else{
    console.log('  │ pool: (空 — 无记录)');
  }
  console.log('  └──────────────────────────────────────────');
}


// ================================================================
//  【login云函数】accountRegister — 从 login/index.js 原样提取
// ================================================================

/**
 * 登录云函数的 accountRegister 动作
 * 这是真实注册流程的入口！
 */
async function login_accountRegister(openid, params){
  logStep('LOGIN', 'accountRegister', 'openid='+openid.slice(0,12)+'... username='+params.username);

  var users_coll = db.collection('users');

  // 1. 检查用户名是否已存在
  var existUser = await users_coll.where({username: _.eq(params.username)}).count();
  logStep('LOGIN', '检查用户名重复', 'total='+existUser.total);
  if(existUser.total > 0){
    logStep('LOGIN', '结果', '❌ 用户名已存在: '+params.username);
    return { code:-1, message:'该用户名已被注册' };
  }

  // 2. 检查是否第一个用户(自动admin)
  var allUsers = await users_coll.count();
  var isFirstUser = allUsers.total === 0;
  logStep('LOGIN', '用户计数', '总用户数='+allUsers.total+' isFirstUser='+isFirstUser);

  // 3. 创建用户记录
  var now = Date.now();
  var newUser = {
    _openid: openid,
    username: params.username,
    password: params.password,
    nickname: params.nickname || params.username,
    avatar: params.avatar || '',
    level: 1, total_xp: 0, streak_days: 0,
    last_checkin_date: '',
    role: isFirstUser ? 'admin' : 'user',
    status: 'active',
    created_at: now, updated_at: now, last_login_at: now,
  };

  var res = await users_coll.add({ data:newUser });
  newUser._id = res._id;

  logStep('LOGIN', '创建用户成功', '_id='+newUser._id+' role='+newUser.role+' nickname='+newUser.nickname);
  dumpDB('注册后');

  return {
    code: 0,
    data: {
      id: newUser._id,
      openid: openid,
      username: newUser.username,
      nickname: newUser.nickname,
      avatar: '',
      level: 1,
      total_xp: 0,
      streak_days: 0,
      role: newUser.role,
      is_new: true,
      created_at: now,
    },
    message: 'ok'
  };
}


// ================================================================
//  【app云函数】getDashboard — 从 index.js 原样提取
// ================================================================

async function app_getDashboard(openid){
  logStep('APP', 'getDashboard', '查询仪表盘数据');

  var users = await safeQuery("users", {_openid: openid});
  var user = users[0] || null;

  logStep('APP', 'getDashboard→users', user ? '找到: nickname='+user.nickname : '❌ 未找到用户记录!');
  if(!user){
    logStep('APP', 'getDashboard→返回', '⚠️ 用户不存在, 返回默认值');
    // 返回默认值（关键！看看前端怎么处理）
    return {
      code:0, data:{
        user:{nickname:"森林伙伴",username:"",level:1,total_xp:0,streak_days:0,avatar:"",role:"user",_id:""},
        todayGrowth:{xp:0,completedTasks:0,totalTasks:0,completionRate:0},
        goals:[], signedIn:false, todayTasks:[], achievements:[],
        activePet:null,  // ← 关键：无宠物时为null
      }
    };
  }

  var petsList = await safeQuery("pets", {_openid: openid});
  var activePet = petsList[0] || null;

  logStep('APP', 'getDashboard→pets', '数量='+petsList.length+(activePet ? ' activePet.name='+activePet.name+' is_hatched='+activePet.is_hatched : ' 无宠物'));

  var today = todayStr();
  var todayTasks = await safeQuery("tasks", {_openid:openid,date:today});
  var checkins = await safeQuery("checkins", {_openid:openid,date:today});
  var achievements = await safeQuery("achievements", {_openid:openid});
  var goals = await safeQuery("goals", {_openid:openid,status:_.neq("deleted")});

  var result = {
    code:0, data:{
      user:{
        nickname:user.nickname||"森林伙伴",
        username:user.username||"",
        level:user.level||1,
        total_xp:user.total_xp||0,
        streak_days:user.streak_days||0,
        avatar:user.avatar||"",
        role:user.role||"user",
        _id:user._id||"",
      },
      todayGrowth:{xp:0, completedTasks:0, totalTasks:todayTasks.length, completionRate:0},
      goals:goals.map(function(g){return{id:g._id,title:g.title};}),
      signedIn:checkins.length>0,
      todayTasks:todayTasks.map(function(t){return{id:t._id,title:t.title,completed:t.completed};}),
      achievements:achievements,
      activePet: activePet ? {
        id:activePet._id, name:activePet.name, stage:activePet.stage,
        egg_stage:activePet.egg_stage||'egg', species:activePet.species|| '',
        is_hatched:activePet.is_hatched===true,
        rarity:activePet.rarity||'common',
        attributes:activePet.attributes||null,
        bond:activePet.bond||0, mood:activePet.mood||'normal',
        mood_message:activePet.mood_message||'', awakened:activePet.awakened||false,
      } : null,
    }
  };

  logStep('APP', 'getDashboard→返回', 'activePet='+(result.data.activePet ? result.data.activePet.name+'('+result.data.activePet.stage+')' : 'null'));
  return result;
}


// ================================================================
//  【app云函数】listPets — 完整提取
// ================================================================

async function app_listPets(openid){
  logStep('APP', 'listPets', '查询宠物列表');
  var d = await safeQuery("pets", {_openid: openid});
  d.sort(function(a,b){return(a.created_at||0)-(b.created_at||0);});
  logStep('APP', 'listPets→结果', '数量='+d.length);
  d.forEach(function(p,i){
    logStep('APP', '  pet['+i+']', 'name='+p.name+' stage='+p.stage+' is_hatched='+p.is_hatched+' species='+(p.species||''));
  });
  return {success:true,data:d.map(function(p){
    return {
      id:p._id,name:p.name,stage:p.stage,egg_stage:p.egg_stage||'egg',
      species:p.species||'',is_hatched:p.is_hatched===true,rarity:p.rarity||'common',
      attributes:p.attributes||null,bond:p.bond||0,mood:p.mood||'normal',
      mood_message:p.mood_message||'',awakened:p.awakened||false,
      hatch_time:p.hatch_time||0,egg_type:p.egg_type||'',
      growth_value:p.growth_value||0,growth_records:p.growth_records||[],
      pet_events:p.pet_events||[],chat_context:p.chat_context||null,
      is_shiny:p.is_shiny===true,color_tier:p.color_tier||'normal',
      color_label:p.color_label||'普通',talent:p.talent||1,
      talent_grade:p.talent_grade||'F',talent_name:p.talent_name||'普通'
    };
  })};
}


// ================================================================
//  【app云函数】getGrowthPool — 完整提取
// ================================================================

async function app_getGrowthPool(openid){
  logStep('APP', 'getGrowthPool', '查询经验池');
  var pool = await safeQuery("user_growth_pool", {_openid: openid});

  if(pool && pool[0]){
    var p = pool[0];
    var sc = !!(p.starter_claimed);
    logStep('APP', 'getGrowthPool→命中', 'pool='+p.growth_pool+' earned='+p.total_earned+
      ' starter_claimed='+sc+
      ' starter_claimed_at='+(p.starter_claimed_at||'无'));

    // ⚠️ 关键发现：这里没有返回 starter_claimed 字段给前端！
    var ret = {
      success:true,
      growth_pool:p.growth_pool||0,
      total_earned:p.total_earned||0,
      // starter_claimed 在原始代码中没有被返回！
    };
    logStep('APP', 'getGrowthPool→返回字段', Object.keys(ret).join(','));
    return ret;
  }

  logStep('APP', 'getGrowthPool→未命中', '无pool记录, 返回默认值 {success:true,growth_pool:0,total_earned:0}');
  // 注意: 不返回 starter_claimed 字段!
  return {success:true, growth_pool:0, total_earned:0};
}


// ================================================================
//  【app云函数】claimStarterXp — 完整提取
// ================================================================

async function app_claimStarterXp(openid){
  logStep('APP', 'claimStarterXp', '尝试领取新手礼包');

  await ensureCollection("user_growth_pool");

  // 检查是否已领取
  var pool = await safeQuery("user_growth_pool", {_openid: openid});
  var poolRecord = pool && pool[0];
  var hasClaimed = false;

  if(poolRecord){
    hasClaimed = !!(poolRecord.starter_claimed || poolRecord.starter_claimed_at);
    logStep('APP', 'claimStarterXp→检查已有记录', 'pool存在! starter_claimed='+poolRecord.starter_claimed+
      ' starter_claimed_at='+(poolRecord.starter_claimed_at||'无')+' → hasClaimed='+hasClaimed);
  }else{
    logStep('APP', 'claimStarterXp→检查已有记录', '无pool记录 → hasClaimed=false');
  }

  if(hasClaimed){
    logStep('APP', 'claimStarterXp→结果', '❌ 已领取过! code=-1');
    return {code:-1, message:"已经领取过新手经验了哦～", already_claimed:true};
  }

  // 发放800点
  var bonusAmount = 800;
  logStep('APP', 'claimStarterXp→发放', 'bonusAmount='+bonusAmount);

  if(poolRecord){
    var newValue = (poolRecord.growth_pool||0) + bonusAmount;
    await safeUpdate("user_growth_pool", {_openid: openid},{
      growth_pool:newValue,
      total_earned:(poolRecord.total_earned||0)+bonusAmount,
      starter_claimed:true,
      starter_claimed_at:Date.now(),
      updated_at:Date.now(),
    });
    logStep('APP', 'claimStarterXp→更新现有池子', 'newValue='+newValue);
  }else{
    await safeAdd("user_growth_pool",{
      _openid:openid,
      growth_pool:bonusAmount,
      total_earned:bonusAmount,
      starter_claimed:true,
      starter_claimed_at:Date.now(),
      created_at:Date.now(),
      updated_at:Date.now(),
    });
    logStep('APP', 'claimStarterXp→新建池子', 'growth_pool='+bonusAmount);
  }

  dumpDB('领礼包后');
  return {success:true, xp_granted:bonusAmount, pool_granted:bonusAmount};
}


// ================================================================
//  前端模拟: pets.js 的 loadGrowthPool 逻辑
// ================================================================

/**
 * 模拟 pets.js line 1119-1125 的判断逻辑
 * 这是决定"是否显示新手礼包按钮"的关键!
 */
function frontend_checkStarterGift(growthPoolRes){
  logStep('FE', '前端判断showStarterGift', '');

  // pets.js line 1120:
  var starterClaimed = !!(growthPoolRes.starter_claimed);

  // pets.js line 1121:
  var showGift = false;
  if(!starterClaimed && (growthPoolRes.growth_pool||0) < 100){
    showGift = true;
  }

  logStep('FE', '  res.starter_claimed', growthPoolRes.starter_claimed);
  logStep('FE', '  !!res.starter_claimed = starterClaimed', starterClaimed);
  logStep('FE', '  growth_pool < 100 ?', (growthPoolRes.growth_pool||0) < 100);
  logStep('FE', '  → showStarterGift', showGift ? '✅ 显示礼包按钮' : '❌ 不显示');

  return {starterClaimed: starterClaimed, showGift: showGift};
}


// ================================================================
//  主流程: 完整模拟新用户启动
// ================================================================

async function runFullDiagnosis(testOpenid, testUsername){
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     新用户异常排查 — 全链路诊断                              ║');
  console.log('║     测试openid: ' + testOpenid.slice(0,20) + '...               ║');
  console.log('║     测试用户名: ' + testUsername + '                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // 初始化
  db._init();
  currentOpenid = testOpenid;
  LOG = [];

  dumpDB('初始状态(空库)');


  // ========== STEP 1: 注册 ==========
  console.log('\n  ═══ STEP 1: 用户注册 (login云函数 accountRegister) ═══');
  console.log('');

  var regResult = await login_accountRegister(testOpenid, {
    username: testUsername,
    password: 'test123456',
    nickname: '测试用户'+Math.floor(Math.random()*10000),
    avatar: ''
  });

  logStep('RESULT', '注册结果', 'code='+regResult.code+' is_new='+(regResult.data&&regResult.data.is_new));
  console.log('  注册结果:', regResult.code === 0 ? '✅ 成功' : '❌ 失败', regResult.message);


  // ========== STEP 2: 进入首页 home.js onShow → loadDashboard ==========
  console.log('\n  ═══ STEP 2: 首页加载 (app云函数 getDashboard) ═══');
  console.log('');

  var dashResult = await app_getDashboard(testOpenid);

  var hasActivePet = !!(dashResult.data && dashResult.data.activePet);
  logStep('RESULT', '首页activePet', hasActivePet ? '有宠物! name='+dashResult.data.activePet.name : '无(null)');
  console.log('  前端看到宠物:', hasActivePet ? '⚠️ 有宠物 → 显示宠物卡片' : '✅ 无宠物 → 显示空状态/引导创建蛋');


  // ========== STEP 3: 进入宠物营地 pets.js onShow ==========
  console.log('\n  ═══ STEP 3: 宠物营地加载 (listPets + getGrowthPool) ═══');
  console.log('');

  // 3a: 加载宠物列表
  var petsResult = await app_listPets(testOpenid);
  var petCount = (petsResult.data || []).length;

  // 3b: 加载经验池
  var poolResult = await app_getGrowthPool(testOpenid);

  // 3c: 前端判断是否显示新手礼包
  var giftCheck = frontend_checkStarterGift(poolResult);


  // ========== STEP 4: 尝试领取新手礼包 ==========
  console.log('\n  ═══ STEP 4: 尝试领取新手礼包 (claimStarterXp) ═══');
  console.log('');

  var claimResult = await app_claimStarterXp(testOpenid);

  logStep('RESULT', '领取结果', 'code='+(claimResult.code||claimResult.success===true?0:claimResult.code||
    (claimResult.success?'0':'?'))+' msg='+(claimResult.message||(claimResult.success?'OK':'?')));
  var claimMsg = claimResult.success ? '✅ 成功 +' + (claimResult.xp_granted||0) :
    (claimResult.already_claimed ? '❌ 已领取过' : '❌ 失败: ' + (claimResult.message || '未知'));
  console.log('  领取结果:', claimMsg);


  // ========== STEP 5: 再次查看状态 (刷新一致性) ==========
  console.log('\n  ═══ STEP 5: 刷新后重新检查 ═══');
  console.log('');

  var pets2 = await app_listPets(testOpenid);
  var pool2 = await app_getGrowthPool(testOpenid);
  var giftCheck2 = frontend_checkStarterGift(pool2);

  var consistent_pets = petCount === (pets2.data||[]).length;
  var consistent_pool = poolResult.growth_pool === pool2.growth_pool; // 领取后应该变了

  logStep('CONSISTENCY', 'pets一致', consistent_pets ? '✅' : '❌ 数量变化!');
  logStep('CONSISTENCY', 'pool变化', poolResult.growth_pool !== pool2.growth_pool ? '✅ 正常(领取后应增加)' : '⚠️ 未变化');

  dumpDB('最终状态');


  // ========== 汇总分析 ==========
  console.log('\n  ══════════════════════════════════════════');
  console.log('  根因分析');
  console.log('  ══════════════════════════════════════════');
  console.log('');

  var issues = [];

  // Bug 1 分析: "新注册用户进入后已有宠物蛋"
  if(petCount > 0){
    issues.push({
      bug: 'Bug1: 新用户已有宠物蛋',
      severity: 'HIGH',
      cause: 'pets集合中已存在该_openid的宠物记录',
      detail: '注册时(login云函数)不创建宠物, 但DB中残留了旧数据。可能原因:\n' +
              '  A) 同一openid之前测试过, DB未清理\n' +
              '  B) 其他代码路径写入了宠物数据\n' +
              '  C) 真机环境使用了开发期openid, 与测试脚本共享DB',
      pets: (petsResult.data||[]).map(function(p){return p.name+'('+p.stage+')';})
    });
    console.log('  ❌ Bug1确认: 注册前DB中已有 '+petCount+' 只宠物');
    console.log('     宠物列表:');
    (petsResult.data||[]).forEach(function(p){
      console.log('       - '+p.name+' | '+p.stage+' | is_hatched='+p.is_hatched+' | species='+(p.species||'(空)')+' | egg_type='+(p.egg_type||'(空)'));
    });
  }else{
    console.log('  ✅ Bug1不成立: 新用户确实没有宠物 (正确行为)');
  }

  // Bug 2 分析: "无法领取新手礼包"
  console.log('');
  if(claimResult.already_claimed || claimResult.code === -1){
    issues.push({
      bug: 'Bug2: 无法领取新手礼包',
      severity: 'HIGH',
      cause: 'claimStarterXp 返回 already_claimed=true 或 code=-1',
      detail: '可能原因:\n' +
              '  A) pool记录已存在且 starter_claimed=true (之前领过)\n' +
              '  B) pool记录被其他操作预创建了(但没设starter_claimed)\n' +
              '  C) getGrowthPool 不返回 starter_claimed 字段导致前端误判',
      poolBefore: poolResult,
      claimResult: claimResult
    });
    console.log('  ❌ Bug2确认: 领取失败 — ' + (claimResult.message || '未知原因'));
  }else if(claimResult.success){
    console.log('  ✅ Bug2不成立: 礼包领取成功 (正确行为)');
  }

  // 额外检查: getGrowthPool 是否返回了 starter_claimed
  console.log('');
  console.log('  🔍 关键发现: getGrowthPool 返回值字段检查');
  console.log('     返回的字段: [' + Object.keys(poolResult).join(', ') + ']');
  if(typeof poolResult.starter_claimed === 'undefined'){
    console.log('     ⚠️  starter_claimed 字段 MISSING (未定义)');
    console.log('     → 前端 !!undefined = false → 会显示礼包按钮 (这是正确的)');
    console.log('     → 但如果之前有pool记录且 starter_claimed=true, 则 !!true = true → 不显示');
    issues.push({
      bug: '潜在问题: getGrowthPool 不返回 starter_claimed',
      severity: 'MEDIUM',
      cause: 'getGrowthPool 函数只返回 growth_pool 和 total_earned, 不返回 starter_claimed',
      detail: '前端通过 !!res.starter_claimed 判断, 当无pool记录时为undefined→false(正确显示)\n' +
              '但有旧pool记录时取决于该字段的实际值'
    });
  }else{
    console.log('     ✅ starter_claimed = ' + poolResult.starter_claimed);
  }


  return {
    testOpenid: testOpenid,
    regResult: regResult,
    dashboardHasPet: hasActivePet,
    petCount: petCount,
    pets: petsResult.data || [],
    poolBeforeClaim: poolResult,
    giftCheckBefore: giftCheck,
    claimResult: claimResult,
    poolAfterClaim: pool2,
    giftCheckAfter: giftCheck2,
    issues: issues,
    logs: LOG
  };
}


// ================================================================
//  入口
// ================================================================

async function main(){
  var t0 = Date.now();

  // 使用全新的随机openid模拟"真正的新用户"
  var freshOpenid = 'REAL_NEW_USER_' + Date.now() + '_' + Math.floor(Math.random()*100000);
  var freshUsername = 'newbie_' + Math.floor(Math.random()*10000);

  var result = await runFullDiagnosis(freshOpenid, freshUsername);

  // 输出JSON
  console.log('\n  // DIAG_JSON_START');
  console.log(JSON.stringify({
    version: 'bug-diag-v1',
    timestamp: new Date().toISOString(),
    testOpenid: result.testOpenid,
    summary: {
      regOk: result.regResult.code === 0,
      hasPetAfterReg: result.dashboardHasPet,
      petCount: result.petCount,
      canClaimGift: result.giftCheckBefore.showGift,
      claimOk: result.claimResult.success || result.claimResult.xp_granted > 0,
      issuesFound: result.issues.length
    },
    bugs: result.issues.map(function(i){ return i.bug + ': ' + i.cause; }),
    details: result
  }, null, 2));
  console.log('// DIAG_JSON_END');

  console.log('\n  总耗时: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
}

main().catch(function(e){
  console.error('致命错误:', e.stack);
  process.exit(1);
});
