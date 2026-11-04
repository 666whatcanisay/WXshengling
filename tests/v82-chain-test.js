/**
 * V8.2 真实业务链路测试脚本 v2
 * 修复: createEgg 不允许同时存在多个未孵化蛋，必须逐个孵化
 */
var db = {
  _collections: {},
  _init: function() {
    ['users','pets','user_growth_pool','growth_logs','checkins','goals','tasks'].forEach(function(n){db._collections[n]=[];});
  },
  collection: function(name) {
    if (!db._collections[name]) db._collections[name] = [];
    return {
      where: function(q) { return { get: async function(){var a=(db._collections[name]||[]).filter(function(d){for(var k in q)if(d[k]!==q[k])return false;return true});return{data:a};}, update: function(u){(db._collections[name]||[]).forEach(function(d){var m=true;for(var k in q)if(d[k]!==q[k]){m=false;break;}if(m)for(var k in u.data){var v=u.data[k];if(v&&typeof v==='object'&&v.$inc!==undefined)d[k]=(d[k]||0)+v.$inc;else if(v&&typeof v==='object'&&v.$push!==undefined){if(!d[k])d[k]=[];d[k].push(v.$push);}else d[k]=v;}});return Promise.resolve({updated:1});} }; },
      add: function(a){var d=Object.assign({_id:'id_'+Date.now()+'_'+Math.random().toString(36).substr(2,6)},a.data);d.created_at=d.created_at||Date.now();(db._collections[name]||[]).push(d);return Promise.resolve({_id:d._id});},
    };
  },
};
var _={inc:function(n){return{$inc:n};},push:function(v){return{$push:v};}};
var cloud={DYNAMIC_CURRENT_ENV:'test-env',init:function(){},getWXContext:function(){return{OPENID:'test_A'};},database:function(){return db;}};

function todayStr(){return new Date().toISOString().slice(0,10);}
async function safeQuery(c,q){try{return(await db.collection(c).where(q).get()).data||[];}catch(e){console.warn('[query]',c,e.message);return[];}}
async function safeAdd(c,d){try{return await db.collection(c).add({data:d});}catch(e){throw e;}}
async function safeUpdate(c,q,d){try{return await db.collection(c).where(q).update({data:d});}catch(e){throw e;}}
async function ensureCollection(n){if(!db._collections[n])db._collections[n]=[];return true;}

// ===== 常量（原样提取） =====
const SPECIES_NAMES={calico_cat:'三花猫',orange_cat:'橘猫',black_cat:'黑猫',snow_leopard:'雪豹',lynx:'猞猁',shiba:'柴犬',corgi:'柯基',golden_retriever:'金毛',husky:'哈士奇',wolf:'狼',hamster:'仓鼠',chinchilla:'龙猫',capybara:'水豚',fox:'狐狸',raccoon:'小浣熊'};
const EGG_TYPES={forest_egg:{name:'森林蛋'},home_egg:{name:'家园蛋'},wild_egg:{name:'荒野蛋'}};
const TALENT_GRADES=[{key:'F',name:'普通',range:[1,20]},{key:'D',name:'良好',range:[21,40]},{key:'C',name:'优秀',range:[41,60]},{key:'B',name:'卓越',range:[61,80]},{key:'A',name:'天才',range:[81,95]},{key:'S',name:'传奇',range:[96,100]}];
const COLOR_TIERS={normal:{key:'normal',label:'普通',prob:0.92},rare:{key:'rare',label:'稀有',prob:0.06},shiny:{key:'shiny',label:'异色',prob:0.02}};
const RARITY_ROLL=[{k:'common',t:70},{k:'rare',t:90},{k:'epic',t:98},{k:'legendary',t:100}];
const PERSONALITY_TYPES=['lively','cool','tsundere'];
const GROWTH_STAGE_THRESHOLDS=[{key:'EGG',minGrowth:0,name:'蛋'},{key:'BABY',minGrowth:100,name:'幼年'},{key:'YOUTH',minGrowth:300,name:'少年'},{key:'ADULT',minGrowth:600,name:'成年'},{key:'PERFECT',minGrowth:1200,name:'完美形态'}];
const SPP={forest_egg:{vitality:[{s:'orange_cat',w:60},{s:'lynx',w:25},{s:'snow_leopard',w:15}],wisdom:[{s:'snow_leopard',w:60},{s:'black_cat',w:25},{s:'lynx',w:15}],luck:[{s:'calico_cat',w:60},{s:'orange_cat',w:25},{s:'snow_leopard',w:15}],resonance:[{s:'black_cat',w:60},{s:'calico_cat',w:25},{s:'lynx',w:15}],balanced:[{s:'lynx',w:50},{s:'snow_leopard',w:25},{s:'black_cat',w:25}]},home_egg:{vitality:[{s:'husky',w:60},{s:'shiba',w:25},{s:'wolf',w:15}],wisdom:[{s:'wolf',w:60},{s:'golden_retriever',w:25},{s:'shiba',w:15}],luck:[{s:'corgi',w:60},{s:'husky',w:25},{s:'golden_retriever',w:15}],resonance:[{s:'golden_retriever',w:60},{s:'corgi',w:25},{s:'shiba',w:15}],balanced:[{s:'shiba',w:50},{s:'wolf',w:25},{s:'golden_retriever',w:25}]},wild_egg:{vitality:[{s:'fox',w:60},{s:'hamster',w:25},{s:'chinchilla',w:15}],wisdom:[{s:'chinchilla',w:60},{s:'capybara',w:25},{s:'hamster',w:15}],luck:[{s:'raccoon',w:60},{s:'fox',w:25},{s:'capybara',w:15}],resonance:[{s:'capybara',w:60},{s:'raccoon',w:25},{s:'hamster',w:15}],balanced:[{s:'hamster',w:50},{s:'capybara',w:25},{s:'fox',w:25}]}};

function rollTalent(){return Math.floor(Math.random()*100)+1;}
function getTalentGrade(v){var tv=Math.max(1,Math.min(100,v||1));for(var i=0;i<TALENT_GRADES.length;i++)if(tv>=TALENT_GRADES[i].range[0]&&tv<=TALENT_GRADES[i].range[1])return TALENT_GRADES[i];return TALENT_GRADES[0];}
function rollFromPool(p){if(!p||!p.length)return'lynx';var tw=p.reduce(function(s,i){return s+i.w},0),r=Math.random()*tw,c=0;for(var i=0;i<p.length;i++){c+=p[i].w;if(r<=c)return p[i].s;}return p[p.length-1].s;}
function resolveSpeciesByAttributes(attrs,et){var pools=SPP[et]||SPP.forest_egg,v=attrs.vitality||0,w=attrs.wisdom||0,l=attrs.luck||0,r=attrs.resonance||0,mx=Math.max(v,w,l,r),mn=Math.min(v,w,l,r);if(mx-mn<=5)return rollFromPool(pools.balanced);var keys=['vitality','wisdom','luck','resonance'],mxA=keys.filter(function(k){return k==='vitality'?attrs.vitality===mx:k==='wisdom'?attrs.wisdom===mx:k==='luck'?attrs.luck===mx:attrs.resonance===mx});if(mxA.length>1)mxA.sort(function(){return Math.random()-0.5});var pool=pools[mxA[0]];if(!pool||mx<20)return rollFromPool(pools.balanced);return rollFromPool(pool);}
function rollColorTier(){var r=Math.random();if(r<COLOR_TIERS.shiny.prob)return COLOR_TIERS.shiny;if(r<COLOR_TIERS.shiny.prob+COLOR_TIERS.rare.prob)return COLOR_TIERS.rare;return COLOR_TIERS.normal;}
function rollRarity(){var r=Math.random()*100;for(var x of RARITY_ROLL)if(r<x.t)return x.k;return 'common';}
function genInitAttrs(){var a=['vitality','wisdom','luck','resonance'],o={};a.forEach(function(k){o[k]=1+Math.floor(Math.random()*5);});return o;}
function getEggStage(gv){var v=gv||0;if(v>=100)return'hatched';if(v>=50)return'cracking_egg';if(v>=25)return'glowing_egg';return'pattern_egg';}
function getGrowthStage(gv){var v=gv||0;for(var i=GROWTH_STAGE_THRESHOLDS.length-1;i>=0;i--)if(v>=GROWTH_STAGE_THRESHOLDS[i].minGrowth)return GROWTH_STAGE_THRESHOLDS[i];return GROWTH_STAGE_THRESHOLDS[0];}
function checkStageUp(o,n){var os=getGrowthStage(o),ns=getGrowthStage(n);return os.key!==ns.key?ns:null;}
function genStageBonus(){var a=['vitality','wisdom','luck','resonance'],n=1+Math.floor(Math.random()*2),sh=a.slice().sort(function(){return Math.random()-0.5}).slice(0,n),r={vitality:0,wisdom:0,luck:0,resonance:0};sh.forEach(function(k){r[k]=1+Math.floor(Math.random()*3);});return r;}

function hatchPetV7(et){var ia=genInitAttrs(),sp=resolveSpeciesByAttributes(et),ct=rollColorTier(),tv=rollTalent(),tg=getTalentGrade(tv),rr=rollRarity(),pe=PERSONALITY_TYPES[Math.floor(Math.random()*PERSONALITY_TYPES.length)];return{species:sp,name:SPECIES_NAMES[sp]||'神秘生物',stage:'BABY',is_hatched:true,rarity:rr,attributes:ia,is_shiny:ct.key==='shiny',color_tier:ct.key,color_label:ct.label,talent:tv,talent_grade:tg.key,talent_name:tg.name,bond:50,mood:'excited',mood_message:'主人今天超棒！',awakened:false,personality:pe,titles:[],hatch_time:Date.now(),egg_type:et,chat_context:{species:sp,species_name:SPECIES_NAMES[sp]||'神秘生物',stage:'BABY',attributes:ia,talent:tv,talent_grade:tg.key,personality_prompt:'',growth_records:[],created_at:Date.now()}};}

function performPetHatch(et){var r=hatchPetV7(et),ha=r.attributes||{};if(!ha||typeof ha!=='object')ha={vitality:0,wisdom:0,luck:0,resonance:0};var now=Date.now(),rm={common:'普通',rare:'稀有',epic:'史诗',legendary:'传说'},uf={growth_value:100,egg_stage:"hatched",is_hatched:true,stage:"BABY",species:r.species,name:r.name,rarity:r.rarity,attributes:ha,is_shiny:r.is_shiny,color_tier:r.color_tier,color_label:r.color_label,talent:r.talent,talent_grade:r.talent_grade,talent_name:r.talent_name,bond:r.bond,mood:r.mood,mood_message:r.mood_message,awakened:false,personality:r.personality,titles:[],hatch_time:now,chat_context:{species:r.species,species_name:SPECIES_NAMES[r.species]||'神秘生物',stage:'BABY',attributes:ha,talent:r.talent,talent_grade:r.talent_grade,personality_prompt:'',growth_records:[],created_at:now},growth_records:[{time:now,stage:'BABY',message:'\u{1F389} 成功孵化！'}],updated_at:now};return{updateFields:uf,result:r,rarityText:rm,buildDisplayTags:function(){var ct=r.color_tier==='shiny'?' \u2728异色\u2728':r.color_tier==='rare'?' \u{1F48E}稀有':'',tt=r.talent_name?'【'+r.talent_name+'】':'';return{colorTag:ct,talentTag:tt};}};}

async function listPets(oid){
  var d = await safeQuery("pets", {_openid: oid});
  d.sort(function(a, b) { return (a.created_at || 0) - (b.created_at || 0); });
  return {
    success: true,
    data: d.map(function(p) {
      return {
        id: p._id,
        name: p.name,
        stage: p.stage,
        egg_stage: p.egg_stage || 'egg',
        species: p.species || '',
        is_hatched: p.is_hatched === true,
        rarity: p.rarity || 'common',
        attributes: p.attributes || null,
        bond: p.bond || 0,
        mood: p.mood || 'normal',
        mood_message: p.mood_message || '',
        awakened: p.awakened || false,
        hatch_time: p.hatch_time || 0,
        egg_type: p.egg_type || '',
        growth_value: p.growth_value || 0,
        growth_records: p.growth_records || [],
        pet_events: p.pet_events || [],
        chat_context: p.chat_context || null,
        is_shiny: p.is_shiny === true,
        color_tier: p.color_tier || 'normal',
        color_label: p.color_label || '普通',
        talent: p.talent || 1,
        talent_grade: p.talent_grade || 'F',
        talent_name: p.talent_name || '普通'
      };
    })
  };
}

async function createEgg(oid,data){var ex=await safeQuery("pets",{_openid:oid}),ac=ex.filter(function(p){return!p.deleted_at;}).length;if(ac>=3)return{code:-1,message:"最多拥有3只宠物"};var he=ex.find(function(p){return p.is_hatched===false&&!p.deleted_at;});if(he)return{code:-1,message:"已有正在孵化的蛋"};var ek=Object.keys(EGG_TYPES),et=(data&&data.egg_type&&EGG_TYPES[data.egg_type])?data.egg_type:ek[Math.floor(Math.random()*ek.length)],ei=EGG_TYPES[et],res=await safeAdd("pets",{_openid:oid,name:ei.name||'神秘成长蛋',stage:"egg",egg_stage:"egg",level:1,experience:0,species:"",egg_type:et,growth_value:0,is_hatched:false,rarity:'unknown',attributes:null,bond:0,mood:'sleepy',mood_message:'正在沉睡中...',awakened:false,personality:'',titles:[],created_at:Date.now(),updated_at:Date.now()});return{success:true,id:res._id,egg_type:et,egg_name:ei.name};}

async function claimStarterPack(oid){await ensureCollection("users");var u=await safeQuery("users",{_openid:oid});if(u.length>0)return{code:-1,message:"已经领取过新手礼包"};await safeAdd("users",{_openid:oid,nickname:'新伙伴',avatar:'',total_xp:800,streak_days:0,last_checkin:null,role:'user',created_at:Date.now(),updated_at:Date.now()});await ensureCollection("user_growth_pool");await safeAdd("user_growth_pool",{_openid:oid,growth_pool:800,total_earned:800,created_at:Date.now(),updated_at:Date.now()});return{success:true,xp_granted:800,pool_granted:800};}

async function allocatePool(oid,data){
  await ensureCollection("user_growth_pool");
  var amt=parseInt(data.amount)||0;if(isNaN(amt)||amt<=0)amt=0;
  var pool=await safeQuery("user_growth_pool",{_openid:oid}),pr=pool[0];
  if(!pr)return{code:-1,message:"经验池不存在"};
  var pv=pr.growth_pool||0;if(amt<=0)amt=pv;if(amt>pv)amt=pv;
  if(amt<=0)return{success:true,allocated:0,message:"池子为空"};
  var pets=await safeQuery("pets",{_openid:oid}),pet=pets.find(function(p){return p._id===data.pet_id});
  if(!pet)return{code:-1,message:"宠物不存在"};
  var og=pet.growth_value||0,ng=og+amt,rp=pv-amt;
  await safeUpdate("user_growth_pool",{_openid:oid},{growth_pool:rp,updated_at:Date.now()});
  // 孵化优先
  if(pet.is_hatched===false&&ng>=100){ng=100;var hd=performPetHatch(pet.egg_type||'forest_egg');
    await safeUpdate("pets",{_id:data.pet_id},hd.updateFields);
    await safeAdd("growth_logs",{_openid:oid,xp_change:0,reason:'\u{1F4A7} 泉水灌注使蛋孵化！获得了【'+(hd.rarityText[hd.result.rarity]||'')+hd.result.name+'】',source:"hatch_pool",created_at:Date.now()});
    var t2=hd.buildDisplayTags();return{success:true,allocated:amt,hatched:true,pet_id:data.pet_id,species:hd.result.species,name:hd.result.name,rarity:hd.result.rarity,talent:hd.result.talent,talent_name:hd.result.talent_name,color_tier:hd.result.color_tier,color_tag:t2.colorTag,talent_tag:t2.talentTag,pool_remaining:rp,message:'\u{1F4A7} 孵化成功！'+hd.result.name+t2.colorTag+t2.talentTag};}
  // 跨阶段
  var osi=getGrowthStage(og),nsi=getGrowthStage(ng);
  if(osi.key!==nsi.key){var ab=genStageBonus(),uf={growth_value:ng,stage:nsi.key,egg_stage:getEggStage(ng),updated_at:Date.now()},ca=pet.attributes||{vitality:0,wisdom:0,luck:0,resonance:0},na={};['vitality','wisdom','luck','resonance'].forEach(function(k){na[k]=(ca[k]||0)+(ab[k]||0);});uf.attributes=na;var recs=(pet.growth_records||[]).slice();recs.push({time:Date.now(),stage:nsi.key,message:'\u{2191}\u{2191} 升级到【'+nsi.name+'】！属性奖励:'+JSON.stringify(ab)});uf.growth_records=recs;
    await safeUpdate("pets",{_id:data.pet_id},uf);
    await safeAdd("growth_logs",{_openid:oid,xp_change:0,reason:'\u{1F3C6} 【'+(pet.name||'宠物')+'】升级到 '+nsi.name,source:"stage_up",created_at:Date.now()});
    return{success:true,allocated:amt,stage_up:true,from_stage:osi.key,to_stage:nsi.key,stage_name:nsi.name,attr_bonus:ab,new_attributes:na,pool_remaining:rp,growth_value:ng,message:'\u{1F3C6} 升级到【'+nsi.name+'】'};}
  // 正常增长
  await safeUpdate("pets",{_id:data.pet_id},{growth_value:ng,egg_stage:getEggStage(ng),updated_at:Date.now()});
  return{success:true,allocated:amt,growth_value:ng,pool_remaining:rp,stage_name:nsi.name,message:'成长值 +'+amt+'，当前:'+ng};
}

// ===== 执行 =====
function sep(t){console.log('\n'+'='.repeat(70));console.log('  '+t);console.log('='.repeat(70));}
function ps(n,t){console.log('\n  \u25B6 Step '+n+': '+t);console.log('  '+'-'.repeat(50));}
function dump(name){var docs=db._collections[name]||[];console.log('    ['+name+'] ('+docs.length+')');if(!docs.length){console.log('      (空)');return;}docs.forEach(function(d,i){var b={};if(name==='users')b={_id:d._id?d._id.substr(-8):null,nickname:d.nickname,total_xp:d.total_xp};else if(name==='pets')b={_id:d._id?d._id.substr(-8):null,name:d.name,stage:d.stage,species:d.species||'',is_hatched:d.is_hatched,growth_value:d.growth_value,egg_type:d.egg_type,talent:d.talent,talent_name:d.talent_name,rarity:d.rarity,color_tier:d.color_tier,attributes:d.attributes};else if(name==='user_growth_pool')b={_id:d._id?d._id.substr(-8):null,growth_pool:d.growth_pool,total_earned:d.total_earned};else if(name==='growth_logs')b={_id:d._id?d._id.substr(-8):null,reason:d.reason,source:d.source};else b=d;console.log('      ['+i+'] '+JSON.stringify(b));});}

async function run(){
  var oid='test_user_A_v82_'+Date.now();
  sep('V8.2 真实业务链路测试 v2');
  console.log('  账号: '+oid);

  ps(1,'注册 + 领取新手礼包');
  var reg=await claimStarterPack(oid);console.log('  返回:',JSON.stringify(reg));
  dump('users');dump('user_growth_pool');

  ps(2,'创建第1枚蛋 (forest_egg)');
  var e1=await createEgg(oid,{egg_type:'forest_egg'});console.log('  返回:',JSON.stringify(e1));

  ps(2,'尝试创建第2枚 (应拒绝 - 有未孵化蛋)');
  var ef=await createEgg(oid,{egg_type:'home_egg'});
  console.log('  返回:',JSON.stringify(ef),' | ',ef.code===-1?'\u2705正确拒绝':'\u274C异常');

  ps(3,'查看营地 (listPets)');
  var pr=await listPets(oid);console.log('  宠物数:',pr.data.length);
  pr.data.forEach(function(p,i){console.log('    ['+i+'] '+p.name+' stage='+p.stage+' is_hatched='+p.is_hatched+' gv='+p.growth_value+' egg_type='+p.egg_type);});

  ps(4,'经验池状态');
  var pc=await safeQuery("user_growth_pool",{_openid:oid});
  console.log('  pool='+(pc[0]?pc[0].growth_pool:'?'),' | ',pc[0]&&pc[0].growth_pool===800?'\u2705':'\u274C');

  ps(5,'分配150到第1枚蛋 -> 孵化');
  var p1=pr.data[0];
  var a1=await allocatePool(oid,{pet_id:p1.id,amount:150});
  console.log('  hatched=',a1.hatched,' species=',a1.species,' name=',a1.name,' talent=',a1.talent,'(',a1.talent_name,') rarity=',a1.rarity,' color=',a1.color_tier);
  console.log('  孵化验证:',a1.hatched?'\u2705成功':'\u274C失败');
  dump('pets');dump('growth_logs');

  ps(6,'创建第2枚蛋 (home_egg) - 第1枚已孵化');
  var e2=await createEgg(oid,{egg_type:'home_egg'});console.log('  返回:',JSON.stringify(e2),'|',e2.success?'\u2705成功':'\u274C'+(e2.message||''));

  if(e2.success){
    ps(7,'分配150到第2枚蛋 -> 孵化');
    var p2l=await listPets(oid);var p2=p2l.data.find(function(p){return!p.is_hatched;});
    if(p2){var a2=await allocatePool(oid,{pet_id:p2.id,amount:150});console.log('  hatched=',a2.hatched,' name=',a2.name,' species=',a2.species,' talent=',a2.talent,'(',a2.talent_name,')');console.log('  ',a2.hatched?'\u2705':'\u274C');}
  }

  ps(8,'创建第3枚蛋 (wild_egg)');
  var e3=await createEgg(oid,{egg_type:'wild_egg'});console.log('  返回:',JSON.stringify(e3),'|',e3.success?'\u2705成功':'\u274C'+(e3.message||''));

  if(e3.success){
    ps(9,'分配150到第3枚蛋 -> 孵化');
    var p3l=await listPets(oid);var p3=p3l.data.find(function(p){return!p.is_hatched;});
    if(p3){var a3=await allocatePool(oid,{pet_id:p3.id,amount:150});console.log('  hatched=',a3.hatched,' name=',a3.name,' species=',a3.species,' talent=',a3.talent,'(',a3.talent_name,')');console.log('  ',a3.hatched?'\u2705':'\u274C');}}
  
  ps(10,'最终查看营地 (3只宠物)');
  var pf=await listPets(oid);console.log('  数量:',pf.data.length);
  pf.data.forEach(function(p,i){console.log('    ['+i+'] '+p.name+' | '+p.stage+' | '+p.species+' | gv='+p.growth_value+' | talent='+p.talent+'('+p.talent_name+') | '+p.rarity+' | '+p.color_tier+' | attrs='+JSON.stringify(p.attributes));});
  dump('pets');dump('growth_logs');

  ps(11,'对第1只宠物分配300 -> 阶段升级');
  var tp=pf.data.find(function(p){return p.is_hatched;});
  if(tp){console.log('  目标:',tp.name,' gv=',tp.growth_value,' stage=',tp.stage);
    var as=await allocatePool(oid,{pet_id:tp.id,amount:300});
    console.log('  stage_up=',as.stage_up,' from->to:',as.from_stage,'->',as.to_stage,' attr_bonus=',JSON.stringify(as.attr_bonus));}
  dump('pets');dump('growth_logs');

  ps(12,'图鉴统计');
  var f2=await listPets(oid),ss={},st2={},rr2={};
  f2.data.forEach(function(p){if(p.species)ss[p.species]=(ss[p.species]||0)+1;if(p.stage)st2[p.stage]=(st2[p.stage]||0)+1;if(p.rarity)rr2[p.rarity]=(rr2[p.rarity]||0)+1;});
  console.log('  物种:',JSON.stringify(ss));console.log('  阶段:',JSON.stringify(st2));console.log('  稀有度:',JSON.stringify(rr2));

  ps(13,'档案详情(第1只宠物)');
  if(f2.data[0]){var pro=f2.data[0];
    console.log('  名称:',pro.name,' 物种:',pro.species,'(',SPECIES_NAMES[pro.species]||'?',') 阶段:',pro.stage,' gv:',pro.growth_value);
    console.log('  天赋:',pro.talent,'/',pro.talent_name,'(',pro.talent_grade,') 稀有度:',pro.rarity,' 颜色:',pro.color_tier,'(',pro.color_label,') 异色:',pro.is_shiny);
    console.log('  属性:',JSON.stringify(pro.attributes),' 亲密度:',pro.bond,' 心情:',pro.mood,'-',pro.mood_message);
    console.log('  蛋类型:',pro.egg_type,' 成长记录数:',(pro.growth_records||[]).length);
    (pro.growth_records||[]).forEach(function(r){console.log('    -',r.message);});}

  ps(14,'刷新一致性检查');
  var ref=await listPets(oid);var cons=true;
  if(ref.data.length!==f2.data.length){cons=false;console.log('  \u274C 数量不一致!');}
  ref.data.forEach(function(p,i){if(p.growth_value!==f2.data[i].growth_value){cons=false;console.log('  \u274C Pet['+i+'] gv不一致');}if(p.stage!==f2.data[i].stage){cons=false;console.log('  \u274C Pet['+i+'] stage不一致');}});
  console.log('  一致性:',cons?'\u2705全部一致':'\u274C存在差异');

  sep('最终汇总');
  console.log('');
  console.log('  步骤                  结果     关键数据');
  console.log('  ' + '-'.repeat(55));
  console.log('  1.注册+礼包          '+(reg.success?'\u2705':'\u274C')+'       xp='+(reg.xp_granted||0));
  console.log('  2.创建蛋1            '+(e1.success?'\u2705':'\u274C')+'       type='+e1.egg_type);
  console.log('  2.拒绝重复创建        '+(ef.code===-1?'\u2705':'\u274C')+'       已有未孵化蛋');
  console.log('  3.查看营地          '+(pr.success?'\u2705':'\u274C')+'       count='+pr.data.length);
  console.log('  4.经验池            '+(pc[0]&&pc[0].growth_pool===800?'\u2705':'\u274C')+'       pool=800');
  console.log('  5.分配150->孵化      '+(a1.hatched?'\u2705':'\u274C')+'       species='+a1.species);
  console.log('  6.创建蛋2           '+(e2?e2.success?'\u2705':'\u274C':'\u274C')+'       type='+(e2?e2.egg_type:'N/A'));
  console.log('  7.分配150->孵化2     '+(a2?a2.hatched?'\u2705':'\u274C':'\u274C')+'       name='+(a2?a2.name:'N/A'));
  console.log('  8.创建蛋3           '+(e3?e3.success?'\u2705':'\u274C':'\u274C')+'       type='+(e3?e3.egg_type:'N/A'));
  console.log('  9.分配150->孵化3     '+(a3?a3.hatched?'\u2705':'\u274C':'\u274C')+'       name='+(a3?a3.name:'N/A'));
  console.log('  10.最终营地         '+((pf.data.length>=3)?'\u2705':'\u274C')+'       pets='+pf.data.length);
  var _11s = as ? (as.from_stage || '?') + '->' + (as.to_stage || '?') : 'N/A';
  console.log('  11.阶段升级          ' + (as ? (as.stage_up ? '\u2705' : '\u274C') : '\u274C') + '       ' + _11s);
  console.log('  12.图鉴统计          \u2705       species='+JSON.stringify(Object.keys(ss)));
  console.log('  13.档案详情          \u2705       如上输出');
  console.log('  14.刷新一致性        '+(cons?'\u2705':'\u274C')+'       '+(cons?'数据一致':'存在差异'));
  console.log('');
  ['users','pets','user_growth_pool','growth_logs'].forEach(function(c){console.log('  '+c.padEnd(20)+': '+(db._collections[c]||[]).length+' 条');});
}
run().catch(function(e){console.error('失败:',e.stack);process.exit(1);});
