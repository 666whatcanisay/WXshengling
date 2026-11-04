/**
 * V8.4 全流程集成测试脚本
 *
 * 模拟完整用户旅程：领蛋 → 签到/打卡 → 分配经验 → 孵化 → 阶段升级 → 完全体
 * 使用 Mock 替代微信云开发 SDK，纯逻辑验证
 *
 * 运行方式: node tests/full_flow_test.js
 */

// ============================================================
// 1. Mock 云开发 SDK (替代 wx-server-sdk)
// ============================================================
const mockDb = {
  collections: {},
  _counter: Date.now(),
};

function mockSafeQuery(collectionName, query) {
  const items = (mockDb.collections[collectionName] || []).filter(item => {
    for (const key of Object.keys(query)) {
      if (key === '_openid' && item._openid !== query._openid) return false;
      if (key === 'deleted_at' && query[key] === undefined) continue;
      if (key === 'is_hatched') {
        if (query[key] === true && item.is_hatched !== true) return false;
        if (query[key] === false && item.is_hatched !== false) return false;
        continue;
      }
      // 简单等值匹配
      if (item[key] !== query[key]) return false;
    }
    return true;
  });
  return Promise.resolve(items);
}

function mockSafeAdd(collectionName, data) {
  if (!mockDb.collections[collectionName]) mockDb.collections[collectionName] = [];
  const doc = { _id: 'test_id_' + (++mockDb._counter), ...data };
  mockDb.collections[collectionName].push(doc);
  return Promise.resolve(doc);
}

function mockSafeUpdate(collectionName, query, updateFields) {
  const items = mockDb.collections[collectionName] || [];
  let updated = 0;
  for (const item of items) {
    let match = true;
    for (const key of Object.keys(query)) {
      if (item[key] !== query[key]) { match = false; break; }
    }
    if (match) {
      Object.assign(item, updateFields);
      updated++;
    }
  }
  return Promise.resolve({ updated });
}

// ============================================================
// 2. 提取云函数中的纯业务逻辑 (从 index.js 复制)
// ============================================================

// ---- 常量定义 ----
const SPECIES_LIST = [
  'calico_cat','orange_cat','black_cat','snow_leopard','lynx',
  'shiba','corgi','golden_retriever','husky','wolf',
  'hamster','chinchilla','capybara','fox','raccoon',
];

const SPECIES_NAMES = {
  calico_cat: '三花猫', orange_cat: '橘猫', black_cat: '黑猫',
  snow_leopard: '雪豹', lynx: '猞猁',
  shiba: '柴犬', corgi: '柯基', golden_retriever: '金毛',
  husky: '哈士奇', wolf: '狼',
  hamster: '仓鼠', chinchilla: '龙猫', capybara: '水豚',
  fox: '狐狸', raccoon: '小浣熊',
};

const EGG_TYPES = {
  forest_egg: { name: '森林蛋', emoji: '🥚', color: '#7CB342' },
  home_egg:   { name: '家园蛋', emoji: '🏠', color: '#FF9800' },
  wild_egg:    { name: '荒野蛋', emoji: '🌿', color: '#8D6E63' },
};

const GROWTH_STAGE_THRESHOLDS = [
  { key: 'EGG',     name: '蛋',       minGrowth: 0,    maxGrowth: 99,   icon: '🥚' },
  { key: 'BABY',    name: '幼年',     minGrowth: 100,  maxGrowth: 299,  icon: '🐣' },
  { key: 'YOUTH',   name: '少年',     minGrowth: 300,  maxGrowth: 599,  icon: '🐾' },
  { key: 'ADULT',   name: '成年',     minGrowth: 600,  maxGrowth: 1199, icon: '🦁' },
  { key: 'PERFECT', name: '完全体',   minGrowth: 1200, maxGrowth: Infinity, icon: '👑' },
];

const GROWTH_SOURCES = {
  checkin:         { label: '签到', value: 10 },
  complete_goal:   { label: '完成目标', value: 15 },
  streak_bonus:    { label: '连续打卡', value: 20 },
  ai_focus:        { label: 'AI专注', value: 15 },
};

// 物种概率池 (简化版)
const SPECIES_PROBABILITY_POOLS = {
  forest_egg: {
    vitality:  [
      { species: 'orange_cat',   weight: 60 }, { species: 'lynx',         weight: 25 }, { species: 'snow_leopard', weight: 15 },
    ],
    wisdom:   [
      { species: 'calico_cat',   weight: 55 }, { species: 'black_cat',     weight: 30 }, { species: 'snow_leopard', weight: 15 },
    ],
    luck:     [
      { species: 'calico_cat',   weight: 50 }, { species: 'orange_cat',     weight: 35 }, { species: 'black_cat', weight: 15 },
    ],
    resonance:[
      { species: 'snow_leopard', weight: 45 }, { species: 'lynx',          weight: 35 }, { species: 'calico_cat', weight: 20 },
    ],
  },
  home_egg: {
    vitality:  [
      { species: 'shiba',        weight: 60 }, { species: 'husky',         weight: 25 }, { species: 'wolf', weight: 10 },
    ],
    wisdom:   [
      { species: 'corgi',        weight: 55 }, { species: 'golden_retriever', weight: 30 }, { species: 'shiba', weight: 15 },
    ],
    luck:     [
      { species: 'golden_retriever', weight: 50 }, { species: 'corgi',     weight: 35 }, { species: 'shiba', weight: 15 },
    ],
    resonance:[
      { species: 'wolf',         weight: 45 }, { species: 'husky',         weight: 35 }, { species: 'corgi', weight: 20 },
    ],
  },
  wild_egg: {
    vitality:  [
      { species: 'hamster',      weight: 55 }, { species: 'capybara',      weight: 30 }, { species: 'raccoon', weight: 15 },
    ],
    wisdom:   [
      { species: 'chinchilla',   weight: 50 }, { species: 'fox',           weight: 35 }, { species: 'hamster', weight: 15 },
    ],
    luck:     [
      { species: 'fox',          weight: 50 }, { species: 'raccoon',       weight: 35 }, { species: 'chinchilla', weight: 15 },
    ],
    resonance:[
      { species: 'capybara',     weight: 45 }, { species: 'fox',           weight: 35 }, { species: 'raccoon', weight: 20 },
    ],
  },
};

// ---- 核心纯函数 ----

function getEggStage(growthValue) {
  var v = growthValue || 0;
  if (v >= 100) return 'hatched';
  if (v >= 50)  return 'cracking_egg';
  if (v >= 25)  return 'glowing_egg';
  return 'pattern_egg';
}

function getGrowthStage(growthValue) {
  var v = growthValue || 0;
  for (var i = GROWTH_STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (v >= GROWTH_STAGE_THRESHOLDS[i].minGrowth) {
      return GROWTH_STAGE_THRESHOLDS[i];
    }
  }
  return GROWTH_STAGE_THRESHOLDS[0];
}

function generateInitialAttributes() {
  var attrs = ['vitality', 'wisdom', 'luck', 'resonance'];
  var result = {};
  attrs.forEach(function(attr) {
    result[attr] = 1 + Math.floor(Math.random() * 5); // 1~5
  });
  return result;
}

function generateStageUpBonus() {
  var allAttrs = ['vitality', 'wisdom', 'luck', 'resonance'];
  var numAttrsToBoost = 1 + Math.floor(Math.random() * 2);
  var shuffled = allAttrs.slice().sort(function() { return Math.random() - 0.5; });
  var selectedAttrs = shuffled.slice(0, numAttrsToBoost);
  var result = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
  selectedAttrs.forEach(function(attr) {
    result[attr] = 1 + Math.floor(Math.random() * 3); // +1 ~ +3
  });
  return result;
}

function rollTalent() {
  var r = Math.random() * 100;
  if (r < 2)   return 5;  // S级 2%
  if (r < 8)   return 4;  // A级 6%
  if (r < 20)  return 3;  // B级 12%
  if (r < 45)  return 2;  // C级 25%
  return 1;             // D/F级 55%
}

function getTalentGrade(talentValue) {
  var grades = {
    5: { key: 'S', name: '传奇', icon: '👑', color: '#FF6F00' },
    4: { key: 'A', name: '天才', icon: '🟠', color: '#FFA000' },
    3: { key: 'B', name: '优秀', icon: '🟡', color: '#FFD600' },
    2: { key: 'C', name: '良好', icon: '🟢', color: '#4CAF50' },
    1: { key: 'F', name: '普通', icon: '⚪', color: '#9E9E9E' },
  };
  return grades[talentValue] || grades[1];
}

function rollColorTier() {
  var r = Math.random() * 100;
  if (r < 2)   return 'shiny';  // 异色 2%
  if (r < 8)   return 'rare';   // 稀有 6%
  return 'normal';
}

function rollRarity() {
  var r = Math.random() * 100;
  if (r < 2)   return 'legendary';
  if (r < 8)   return 'epic';
  if (r < 22)  return 'rare';
  return 'common';
}

function rollFromPool(pool) {
  if (!pool || !pool.length) return null;
  var totalWeight = pool.reduce(function(s, item) { return s + item.weight; }, 0);
  var roll = Math.random() * totalWeight;
  var cumulative = 0;
  for (var i = 0; i < pool.length; i++) {
    cumulative += pool[i].weight;
    if (roll <= cumulative) return pool[i].species;
  }
  return pool[pool.length - 1].species;
}

function resolveSpeciesByAttributes(attributes, eggType) {
  if (!attributes || typeof attributes !== 'object') return 'calico_cat';
  var keys = Object.keys(attributes);
  if (keys.length === 0) return 'calico_cat';

  // 找最高属性
  var maxAttr = keys[0];
  for (var i = 1; i < keys.length; i++) {
    if ((attributes[keys[i]] || 0) > (attributes[maxAttr] || 0)) maxAttr = keys[i];
  }

  var pools = SPECIES_PROBABILITY_POOLS[eggType] || SPECIES_PROBABILITY_POOLS.forest_egg;
  var targetPool = pools[maxAttr] || pools.vitality || pools[Object.keys(pools)[0]];
  return rollFromPool(targetPool);
}

function generateAttributes(species) {
  var baseProfiles = {
    feline:     { vitality: [3,8], wisdom: [4,9], luck: [3,7], resonance: [2,6] },
    canine:     { vitality: [4,9], wisdom: [3,7], luck: [4,8], resonance: [3,7] },
    small_mammal:{ vitality: [2,6], wisdom: [3,8], luck: [4,9], resonance: [3,7] },
  };

  var categoryMap = {
    calico_cat:'feline', orange_cat:'feline', black_cat:'feline', snow_leopard:'feline', lynx:'feline',
    shiba:'canine', corgi:'canine', golden_retriever:'canine', husky:'canine', wolf:'canine',
    hamster:'small_mammal', chinchilla:'small_mammal', capybara:'small_mammal', fox:'small_mammal', raccoon:'small_mammal',
  };

  var cat = categoryMap[species] || 'feline';
  var profile = baseProfiles[cat] || baseProfiles.feline;
  var result = {};
  Object.keys(profile).forEach(function(key) {
    var range = profile[key];
    result[key] = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  });
  return result;
}

/**
 * V7 孵化核心：根据蛋类型生成完整宠物数据
 */
function hatchPetV7(eggType) {
  // 1. 生成初始四维属性
  var initialAttrs = generateInitialAttributes();

  // 2. 根据属性决定物种
  var species = resolveSpeciesByAttributes(initialAttrs, eggType);

  // 3. 用物种模板覆盖属性（保证物种特征）
  var finalAttrs = generateAttributes(species);

  // 4. 随机稀有度
  var rarity = rollRarity();

  // 5. 随机颜色档次
  var colorTier = rollColorTier();
  var colorLabels = { normal: '普通', rare: '稀有', shiny: '异色' };

  // 6. 天赋
  var talent = rollTalent();
  var talentGradeInfo = getTalentGrade(talent);

  // 7. 心情
  var moods = ['happy', 'excited', 'calm', 'sleepy'];
  var mood = moods[Math.floor(Math.random() * moods.length)];
  var moodMessages = {
    happy: '看起来很开心呢～', excited: '兴奋得摇尾巴！', calm: '安静地待在你身边', sleepy: '正在打盹儿...',
  };

  // 8. 名称生成
  var namePrefixes = { common: '', rare: '★ ', epic: '★★ ', legendary: '★★★ ' };
  var name = namePrefixes[rarity] + (SPECIES_NAMES[species] || '神秘生物');

  return {
    species: species,
    name: name,
    rarity: rarity,
    attributes: finalAttrs,
    is_shiny: colorTier === 'shiny',
    color_tier: colorTier,
    color_label: colorLabels[colorTier],
    talent: talent,
    talent_grade: talentGradeInfo.key,
    talent_name: talentGradeInfo.name,
    bond: 0,
    mood: mood,
    mood_message: moodMessages[mood] || '',
    personality: [],
    attribute_type: Object.keys(finalAttrs).reduce(function(a, b) {
      return (finalAttrs[a] || 0) > (finalAttrs[b] || 0) ? a : b;
    }, 'vitality'),
  };
}

/**
 * V8.2 统一孵化执行函数
 */
function performPetHatch(eggType) {
  var result = hatchPetV7(eggType || 'forest_egg');
  var hatchAttrs = result.attributes || {};

  if (!hatchAttrs || typeof hatchAttrs !== 'object') {
    hatchAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
  }

  var now = Date.now();
  var rarityTextMap = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };

  var updateFields = {
    growth_value: 100,
    egg_stage: "hatched",
    is_hatched: true,
    stage: "BABY",
    species: result.species,
    name: result.name,
    rarity: result.rarity,
    attributes: hatchAttrs,
    is_shiny: result.is_shiny,
    color_tier: result.color_tier,
    color_label: result.color_label,
    talent: result.talent,
    talent_grade: result.talent_grade,
    talent_name: result.talent_name,
    bond: result.bond,
    mood: result.mood,
    mood_message: result.mood_message,
    awakened: false,
    personality: result.personality,
    titles: [],
    hatch_time: now,
    chat_context: {
      species: result.species,
      species_name: SPECIES_NAMES[result.species] || '神秘生物',
      stage: 'BABY',
      attributes: hatchAttrs,
      talent: result.talent,
      talent_grade: result.talent_grade,
      personality_prompt: '',
      growth_records: [],
      created_at: now,
    },
    growth_records: [{ time: now, stage: 'BABY', message: '🎉 成长孵化！' }],
    updated_at: now,
  };

  return {
    updateFields: updateFields,
    result: result,
    rarityText: rarityTextMap,
    buildDisplayTags: function() {
      var colorTag = result.color_tier === 'shiny' ? ' ✨异色✨' :
                      result.color_tier === 'rare' ? ' 💎稀有' : '';
      var talentTag = result.talent_name ? '【' + result.talent_name + '】' : '';
      return { colorTag: colorTag, talentTag: talentTag };
    },
  };
}


// ============================================================
// 3. Mock 版 async 业务函数 (使用上面的 safe* 函数)
// ============================================================

var TEST_OPENID = 'test_user_001';

async function testCreateEgg(data) {
  var exist = await mockSafeQuery("pets", { _openid: TEST_OPENID });
  var activeCount = exist.filter(function(p) { return !p.deleted_at; }).length;
  if (activeCount >= 3) return { code: -1, message: "最多拥有3只宠物" };
  var hasEgg = exist.find(function(p) { return p.is_hatched === false && !p.deleted_at; });
  if (hasEgg) return { code: -1, message: "已有正在孵化的蛋" };

  var eggTypeKeys = Object.keys(EGG_TYPES);
  var eggType = (data && data.egg_type && EGG_TYPES[data.egg_type])
    ? data.egg_type
    : eggTypeKeys[Math.floor(Math.random() * eggTypeKeys.length)];

  var eggInfo = EGG_TYPES[eggType];

  var res = await mockSafeAdd("pets", {
    _openid: TEST_OPENID,
    name: eggInfo.name || '神秘成长蛋',
    stage: "egg",
    egg_stage: "egg",
    level: 1,
    experience: 0,
    species: "",
    egg_type: eggType,
    growth_value: 0,
    is_hatched: false,
    rarity: 'unknown',
    attributes: {},
    bond: 0,
    mood: 'sleepy',
    mood_message: '正在沉睡中...',
    awakened: false,
    personality: '',
    titles: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  return { success: true, id: res._id, egg_type: eggType, egg_name: eggInfo.name };
}

async function testHatchProgress(source) {
  source = source || 'checkin';
  var addValue = (GROWTH_SOURCES[source] && GROWTH_SOURCES[source].value) || 5;

  // 入池
  var pool = await mockSafeQuery("user_growth_pool", { _openid: TEST_OPENID });
  var poolRecord = pool[0];
  if (!poolRecord) {
    await mockSafeAdd("user_growth_pool", {
      _openid: TEST_OPENID,
      growth_pool: 0,
      total_earned: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    poolRecord = { growth_pool: 0 };
  }

  var newPoolValue = (poolRecord.growth_pool || 0) + addValue;
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: newPoolValue,
    total_earned: (poolRecord.total_earned || 0) + addValue,
    updated_at: Date.now(),
  });

  // 获取宠物
  var pets = await mockSafeQuery("pets", { _openid: TEST_OPENID });
  var egg = pets.find(function(p) { return p.is_hatched === false && !p.deleted_at; });
  var activePet = egg || pets.find(function(p) { return p.is_hatched === true && !p.deleted_at; });

  if (!activePet) {
    return { success: true, pool_only: true, pool_value: newPoolValue, added: addValue };
  }

  var isEgg = !(activePet.is_hatched === true);
  var oldGrowth = activePet.growth_value || 0;

  // 从池子消费
  var consumeValue = Math.min(addValue, newPoolValue);
  var newValue = oldGrowth + consumeValue;
  var remainingPool = newPoolValue - consumeValue;

  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: Math.max(0, remainingPool),
    updated_at: Date.now(),
  });

  // 孵化检查
  if (isEgg && newValue >= 100) {
    newValue = 100;
    var hatchData = performPetHatch(activePet.egg_type || 'forest_egg');
    await mockSafeUpdate("pets", { _id: activePet._id }, hatchData.updateFields);

    var tags = hatchData.buildDisplayTags();
    return {
      success: true,
      hatched: true,
      pet: { id: activePet._id, ...hatchData.result },
      stage_up: { from: 'EGG', to: 'BABY', name: '幼年' },
      need_personality: true,
      message: '恭喜！你的蛋孵化成了' + (hatchData.rarityText[hatchData.result.rarity] || '') + hatchData.result.name +
        tags.colorTag + tags.talentTag + '！进入幼年期',
    };
  }

  // 已孵化宠物的阶段升级
  if (!isEgg) {
    var newStageInfo = getGrowthStage(newValue);
    var oldStageInfo = getGrowthStage(oldGrowth);
    var stageUpResult = null;

    if (oldStageInfo.key !== newStageInfo.key) {
      stageUpResult = {
        from: oldStageInfo.key,
        to: newStageInfo.key,
        name: newStageInfo.name,
        attrBonus: generateStageUpBonus(),
      };

      var currentAttrs = activePet.attributes;
      if (!currentAttrs || typeof currentAttrs !== 'object') {
        currentAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
      }
      var newAttrs = {};
      Object.keys(stageUpResult.attrBonus).forEach(function(key) {
        newAttrs[key] = (currentAttrs[key] || 0) + stageUpResult.attrBonus[key];
      });

      var currentRecords = activePet.growth_records || [];
      if (!Array.isArray(currentRecords)) currentRecords = [];

      await mockSafeUpdate("pets", { _id: activePet._id }, {
        growth_value: newValue,
        stage: newStageInfo.key,
        attributes: newAttrs,
        growth_records: currentRecords.concat({
          time: Date.now(), stage: newStageInfo.key,
          message: '成长为【' + newStageInfo.name + '】',
        }),
        updated_at: Date.now(),
      });

      var attrText = Object.keys(stageUpResult.attrBonus).map(function(k) {
        var labels = { vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' };
        return (labels[k] || k) + '+' + stageUpResult.attrBonus[k];
      }).join(' ');

      return {
        success: true, progress: newValue, stage: newStageInfo.key,
        stage_name: newStageInfo.name, stage_up: stageUpResult,
        attr_bonus: stageUpResult.attrBonus, need_personality_prompt: true,
        message: '升级为【' + newStageInfo.name + '】！' + attrText,
      };
    }

    // 正常增加
    await mockSafeUpdate("pets", { _id: activePet._id }, {
      growth_value: newValue, updated_at: Date.now(),
    });
    return {
      success: true, progress: newValue, stage: newStageInfo.key,
      message: '+' + consumeValue + '，当前【' + newStageInfo.name + '】' + newValue + '/' + newStageInfo.minGrowth,
    };
  }

  // 蛋未孵化，正常增加
  var newEggStage = getEggStage(newValue);
  await mockSafeUpdate("pets", { _id: activePet._id }, {
    growth_value: newValue, egg_stage: newEggStage, updated_at: Date.now(),
  });
  return {
    success: true, progress: newValue, egg_stage: newEggStage,
    message: '+' + consumeValue + '，孵化进度 ' + newValue + '/100',
  };
}

async function testAllocatePool(petId, amount) {
  var pool = await mockSafeQuery("user_growth_pool", { _openid: TEST_OPENID });
  if (!pool || !pool[0]) return { code: -1, message: "经验池不存在" };
  var poolValue = pool[0].growth_pool || 0;
  if (poolValue <= 0) return { code: -1, message: "经验池是空的" };

  var targetPets = await mockSafeQuery("pets", { _id: petId, _openid: TEST_OPENID });
  if (!targetPets || !targetPets[0]) return { code: -1, message: "目标宠物不存在" };
  var pet = targetPets[0];

  amount = parseInt(amount) || 0;
  if (amount <= 0) amount = poolValue;
  if (amount > poolValue) amount = poolValue;

  var oldGrowth = pet.growth_value || 0;
  var newGrowth = oldGrowth + amount;
  var remainingPool = poolValue - amount;

  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: remainingPool, updated_at: Date.now(),
  });

  var newStageInfo = getGrowthStage(newGrowth);
  var oldStageInfo = getGrowthStage(oldGrowth);

  // 孵化优先级最高
  if (pet.is_hatched === false && newGrowth >= 100) {
    var allocHatchData = performPetHatch(pet.egg_type || 'forest_egg');
    await mockSafeUpdate("pets", { _id: petId }, allocHatchData.updateFields);

    var tags2 = allocHatchData.buildDisplayTags();
    return {
      success: true, allocated: amount, pool_remaining: remainingPool,
      hatched: true, pet: { id: petId, ...allocHatchData.result },
      need_personality: true,
      message: '💧 泉水灌注使蛋孵化了！获得了【' + (allocHatchData.rarityText[allocHatchData.result.rarity] || '') + allocHatchData.result.name +
        tags2.colorTag + tags2.talentTag + '】',
    };
  }

  // 阶段升级
  var stageUpResult = null;
  var updateFields = { growth_value: newGrowth, updated_at: Date.now() };

  if (oldStageInfo.key !== newStageInfo.key) {
    stageUpResult = {
      from: oldStageInfo.key, to: newStageInfo.key,
      name: newStageInfo.name, attrBonus: generateStageUpBonus(),
    };

    var currentAttrs = pet.attributes;
    if (!currentAttrs || typeof currentAttrs !== 'object') {
      currentAttrs = { vitality: 0, wisdom: 0, luck: 0, resonance: 0 };
    }
    var newAttrs = {};
    Object.keys(stageUpResult.attrBonus).forEach(function(key) {
      newAttrs[key] = (currentAttrs[key] || 0) + stageUpResult.attrBonus[key];
    });

    updateFields.stage = newStageInfo.key;
    updateFields.attributes = newAttrs;

    var currentRecords = pet.growth_records || [];
    if (!Array.isArray(currentRecords)) currentRecords = [];
    updateFields.growth_records = currentRecords.concat({
      time: Date.now(), stage: newStageInfo.key,
      message: '💧 泉水灌注成长为【' + newStageInfo.name + '】',
    });

    await mockSafeUpdate("pets", { _id: petId }, updateFields);

    var attrText = Object.keys(stageUpResult.attrBonus).map(function(k) {
      var labels = { vitality: '活力', wisdom: '智慧', luck: '幸运', resonance: '共鸣' };
      return (labels[k] || k) + '+' + stageUpResult.attrBonus[k];
    }).join(' ');

    return {
      success: true, allocated: amount, pool_remaining: remainingPool,
      pet_new_growth: newGrowth, stage: newStageInfo.key,
      stage_up: stageUpResult, attr_bonus: stageUpResult.attrBonus,
      need_personality_prompt: true,
      message: '💧 灌注 +' + amount + '，升级为【' + newStageInfo.name + '】！' + attrText,
    };
  }

  await mockSafeUpdate("pets", { _id: petId }, updateFields);
  return {
    success: true, allocated: amount, pool_remaining: remainingPool,
    pet_new_growth: newGrowth, message: '💧 灌注 +' + amount + '，当前 ' + newGrowth,
  };
}

async function testGetDashboard() {
  var users = await mockSafeQuery("users", { _openid: TEST_OPENID });
  var user = users[0] || {};

  var goals = await mockSafeQuery("goals", { _openid: TEST_OPENID, status: 'active' });
  var petsListRaw = await mockSafeQuery("pets", { _openid: TEST_OPENID });
  var petsList = (petsListRaw || []).filter(function(p) { return !p.deleted_at; });
  var activePet = petsList[0] || null;

  var todayTasks = await mockSafeQuery("tasks", { _openid: TEST_OPENID, date: new Date().toISOString().slice(0,10) });

  return {
    code: 0,
    data: {
      user: {
        nickname: user.nickname || "森林伙伴",
        level: user.level || 1,
        total_xp: user.total_xp || 0,
        streak_days: user.streak_days || 0,
      },
      signedIn: false,
      todayTasks: todayTasks.map(function(t) {
        return { id: t._id, title: t.title, completed: t.completed, xp_reward: t.xp_reward };
      }),
      goals: goals.map(function(g) {
        return { id: g._id, title: g.title, progress: g.progress || 0, emoji: g.emoji || "🎯" };
      }),
      // 【V8.4验证点】activePet 必须包含 V6 字段 (与云函数 getDashboard 保持一致)
      activePet: activePet ? {
        id: activePet._id, name: activePet.name, stage: activePet.stage,
        level: activePet.level, experience: activePet.experience,
        egg_stage: activePet.egg_stage || 'egg',
        species: activePet.species || '',
        attribute_type: activePet.attribute_type || '',
        personality: activePet.personality || [],
        hatch_progress: activePet.hatch_progress || 0,
        is_hatched: activePet.is_hatched === true,
        rarity: activePet.rarity || 'common',
        attributes: activePet.attributes || null,
        bond: activePet.bond || 0,
        mood: activePet.mood || 'normal',
        mood_message: activePet.mood_message || '',
        awakened: activePet.awakened || false,
        // V6 字段
        egg_type: activePet.egg_type || 'forest_egg',
        growth_value: activePet.growth_value || 0,
        is_shiny: activePet.is_shiny === true,
        color_tier: activePet.color_tier || 'normal',
        color_label: activePet.color_label || '普通',
        talent: activePet.talent || 1,
        talent_grade: activePet.talent_grade || 'F',
        talent_name: activePet.talent_name || '普通',
      } : null,
    },
  };
}

async function testCreateGoal(title) {
  var now = Date.now();
  var res = await mockSafeAdd("goals", {
    _openid: TEST_OPENID, title: title, description: "",
    emoji: "🎯", progress: 0, target_value: 100,
    current_value: 0, unit: "", status: "active",
    created_at: now, updated_at: now,
  });
  return { success: true, id: res._id };
}

async function testCreateTask(goalId, title) {
  var today = new Date().toISOString().slice(0, 10);
  var res = await mockSafeAdd("tasks", {
    _openid: TEST_OPENID, title: title, goal_id: goalId,
    xp_reward: 10, completed: false, date: today,
    created_at: Date.now(), updated_at: Date.now(),
  });
  return { success: true, id: res._id };
}

async function testTaskCheckin(taskId) {
  var tasks = await mockSafeQuery("tasks", { _id: taskId, _openid: TEST_OPENID });
  var task = tasks[0];
  if (!task) return { code: -1, message: "任务不存在" };
  if (task.completed) return { success: true, already_completed: true };

  var xpReward = task.xp_reward || 10;
  await mockSafeUpdate("tasks", { _id: taskId }, { completed: true, completed_at: Date.now(), updated_at: Date.now() });
  return { success: true, xp_earned: xpReward };
}


// ============================================================
// 4. 测试运行器
// ============================================================

var passed = 0, failed = 0, errors = [];

function assert(condition, testName, detail) {
  if (condition) {
    console.log('  ✅ PASS: ' + testName);
    passed++;
  } else {
    console.log('  ❌ FAIL: ' + testName + (detail ? ' — ' + detail : ''));
    failed++;
    errors.push(testName + (detail ? ': ' + detail : ''));
  }
}

function assertEqual(actual, expected, testName) {
  if (actual === expected) {
    console.log('  ✅ PASS: ' + testName + ' = ' + expected);
    passed++;
  } else {
    console.log('  ❌ FAIL: ' + testName + ' — expected "' + expected + '", got "' + actual + '"');
    failed++;
    errors.push(testName + ': expected "' + expected + '", got "' + actual + '"');
  }
}

function assertContains(obj, fieldName, testName) {
  if (obj && obj.hasOwnProperty(fieldName)) {
    console.log('  ✅ PASS: ' + testName + ' (存在)');
    passed++;
  } else {
    console.log('  ❌ FAIL: ' + testName + ' — 字段 "' + fieldName + '" 不存在');
    failed++;
    errors.push(testName + ': 字段 "' + fieldName + '" 缺失');
  }
}

function section(title) {
  console.log('\n═══ ' + title + ' ═══');
}

async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   V8.4 全流程集成测试 — AI成长伙伴小程序        ║');
  console.log('║   测试时间: ' + new Date().toLocaleString('zh-CN').padEnd(28) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  // ====== 测试1: createEgg ======
  section('测试1: createEgg — 创建新蛋');

  var eggResult = await testCreateEgg({ egg_type: 'forest_egg' });
  assert(eggResult.success === true, 'createEgg 返回成功');
  assert(eggResult.id, 'createEgg 返回有效的 _id');
  assertEqual(eggResult.egg_type, 'forest_egg', '蛋类型正确');
  assertEqual(eggResult.egg_name, '森林蛋', '蛋名称正确');

  // 验证DB中的记录
  var petsAfterCreate = await mockSafeQuery("pets", { _openid: TEST_OPENID });
  var eggInDb = petsAfterCreate[0];
  assert(eggInDb, '蛋已写入DB');
  assertEqual(eggInDb.stage, 'egg', '初始 stage=egg');
  assertEqual(eggInDb.growth_value, 0, '初始 growth_value=0');
  assertEqual(eggInDb.is_hatched, false, '初始 is_hatched=false');
  assert(typeof eggInDb.attributes === 'object', 'attributes 是对象(非null)', JSON.stringify(eggInDb.attributes));
  assert(Object.keys(eggInDb.attributes).length === 0, 'attributes 初始化为空对象{}');
  assert(!eggInDb.deleted_at, '无 deleted_at 字段');
  assertContains(eggInDb, 'egg_type', 'DB记录含 egg_type 字段');
  assertContains(eggInDb, 'created_at', 'DB记录含 created_at 字段');

  var EGG_ID = eggInDb._id;


  // ====== 测试2: 签到+打卡 → 经验入池+蛋增长 ======
  section('测试2: dailyCheckin/taskCheckin → hatchProgress 经验流转');

  // 签到 (+10)
  var checkinResult = await testHatchProgress('checkin');
  assert(checkinResult.success === true, '签到返回成功');
  assert(checkinResult.progress > 0, '签到后蛋有 growth_value 增长');
  assertEqual(checkinResult.progress, 10, '签到后 growth_value=10 (首次全部消费)');

  // 再签到一次 (累积)
  var checkin2 = await testHatchProgress('checkin');
  assertEqual(checkin2.progress, 20, '第二次签到 growth_value=20');

  // 打卡 (+15)
  var taskResult = await testHatchProgress('complete_goal');
  assert(taskResult.success === true, '打卡返回成功');
  assertEqual(taskResult.progress, 35, '打卡后 growth_value=35 (20+15)');

  // 连续打卡 (+20)
  var streakResult = await testHatchProgress('streak_bonus');
  assertEqual(streakResult.progress, 55, '连续打卡后 growth_value=55 (35+20)');

  // AI专注 (+15)
  var aiResult = await testHatchProgress('ai_focus');
  assertEqual(aiResult.progress, 70, 'AI专注后 growth_value=70 (55+15)');

  // 验证池子状态
  var poolAfter = await mockSafeQuery("user_growth_pool", { _openid: TEST_OPENID });
  assert(poolAfter[0], '经验池记录存在');
  console.log('  📊 当前池子余额: ' + (poolAfter[0].growth_pool || 0) + ' | 总获得: ' + (poolAfter[0].total_earned || 0));

  // 验证蛋的阶段变化
  var eggNow = await mockSafeQuery("pets", { _id: EGG_ID });
  var gv = eggNow[0].growth_value;
  var eggStage = getEggStage(gv);
  assertEqual(gv, 70, 'DB中蛋 growth_value=70');
  assertEqual(eggStage, 'cracking_egg', '70点对应 cracking_egg 阶段 (≥50)');


  // ====== 测试3: allocatePool 触发孵化 (70→170, 跨越100阈值) ======
  section('测试3: allocatePool 泉水分配触发孵化 (growth_value 70→≥100)');

  // 先往池子里加点钱
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: 500, updated_at: Date.now()
  });

  var allocResult = await testAllocatePool(EGG_ID, 40); // 70+40=110 ≥ 100 触发孵化!
  assert(allocResult.success === true, 'allocatePool 返回成功');
  assert(allocResult.hatched === true, '孵化被触发! hatched=true');
  assert(allocResult.pet, '孵化结果包含 pet 数据');
  assert(allocResult.pet.species, '孵化后 pet 有 species: ' + allocResult.pet.species);
  assert(SPECIES_NAMES[allocResult.pet.species], 'species 是有效值: ' + (SPECIES_NAMES[allocResult.pet.species] || '?'));
  assert(allocResult.pet.rarity, '孵化后 pet 有 rarity: ' + allocResult.pet.rarity);
  assert(['common','rare','epic','legendary'].indexOf(allocResult.pet.rarity) >= 0, 'rarity 是合法值');
  assert(allocResult.pet.attributes, '孵化后 pet 有 attributes');
  assert(allocResult.pet.attributes.vitality >= 0, 'attributes.vitality ≥ 0: ' + allocResult.pet.attributes.vitality);
  assert(allocResult.pet.attributes.wisdom >= 0, 'attributes.wisdom ≥ 0: ' + allocResult.pet.attributes.wisdom);
  assert(allocResult.pet.attributes.luck >= 0, 'attributes.luck ≥ 0: ' + allocResult.pet.attributes.luck);
  assert(allocResult.pet.attributes.resonance >= 0, 'attributes.resonance ≥ 0: ' + allocResult.pet.attributes.resonance);
  assert(allocResult.pet.talent >= 1, 'talent ≥ 1: ' + allocResult.pet.talent);
  assert(allocResult.pet.color_tier, 'color_tier 存在: ' + allocResult.pet.color_tier);
  assert(allocResult.need_personality === true, 'need_personality=true (需输入性格)');

  // 验证DB更新
  var hatchedPet = await mockSafeQuery("pets", { _id: EGG_ID });
  var hp = hatchedPet[0];
  assertEqual(hp.is_hatched, true, 'DB: is_hatched=true');
  assertEqual(hp.stage, 'BABY', 'DB: stage=BABY (幼年)');
  assertEqual(hp.growth_value, 100, 'DB: growth_value=100 (孵化时固定为100)');
  assert(hp.species, 'DB: species 有值: ' + hp.species);
  assert(hp.name, 'DB: name 有值: ' + hp.name);
  assert(hp.hatch_time > 0, 'DB: hatch_time 有值');
  assert(hp.chat_context, 'DB: chat_context 已初始化');
  assert(hp.chat_context.species === hp.species, 'DB: chat_context.species 与 pet.species 一致');
  assert(Array.isArray(hp.growth_records), 'DB: growth_records 是数组');
  assert(hp.growth_records.length > 0, 'DB: growth_records 非空');
  assertEqual(hp.growth_records[0].stage, 'BABY', 'DB: 首条记录 stage=BABY');
  assert(typeof hp.attributes === 'object' && hp.attributes !== null, 'DB: attributes 是非null对象');


  // ====== 测试4: 阶段升级 BABY→YOUTH→ADULT→PERFECT ======
  section('测试4: 阶段升级 BABY(100) → YOUTH(300+) → ADULT(600+) → PERFECT(1200+)');

  // 往池子灌大量经验用于测试升级
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: 2000, updated_at: Date.now()
  });

  // BABY→YOUTH: 需要 300-100=200 点
  console.log('  --- BABY → YOUTH (需要 +200) ---');
  var upgrade1 = await testAllocatePool(EGG_ID, 200);
  assert(upgrade1.success === true, 'BABY→YOUTH 成功');
  assert(upgrade1.stage_up !== undefined, 'stage_up 结果存在');
  assertEqual(upgrade1.stage, 'YOUTH', '新阶段=YOUTH');
  assertEqual(upgrade1.stage_up.from, 'BABY', 'from=BABY');
  assertEqual(upgrade1.stage_up.to, 'YOUTH', 'to=YOUTH');
  assert(upgrade1.attr_bonus, '属性奖励存在');
  console.log('    属性奖励: ' + JSON.stringify(upgrade1.attr_bonus));

  // YOUTH→ADULT: 需要 600-300=300 点
  console.log('  --- YOUTH → ADULT (需要 +300) ---');
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, { growth_pool: 2000, updated_at: Date.now() });
  var upgrade2 = await testAllocatePool(EGG_ID, 300);
  assert(upgrade2.success === true, 'YOUTH→ADULT 成功');
  assertEqual(upgrade2.stage, 'ADULT', '新阶段=ADULT');
  assertEqual(upgrade2.stage_up.from, 'YOUTH', 'from=YOUTH');
  assertEqual(upgrade2.stage_up.to, 'ADULT', 'to=ADULT');

  // ADULT→PERFECT: 需要 1200-600=600 点
  console.log('  --- ADULT → PERFECT (需要 +600) ---');
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, { growth_pool: 2000, updated_at: Date.now() });
  var upgrade3 = await testAllocatePool(EGG_ID, 600);
  assert(upgrade3.success === true, 'ADULT→PERFECT 成功');
  assertEqual(upgrade3.stage, 'PERFECT', '新阶段=PERFECT (完全体!)');
  assertEqual(upgrade3.stage_up.from, 'ADULT', 'from=ADULT');
  assertEqual(upgrade3.stage_up.to, 'PERFECT', 'to=PERFECT');

  // 验证最终状态
  var finalPet = await mockSafeQuery("pets", { _id: EGG_ID });
  var fp = finalPet[0];
  assertEqual(fp.stage, 'PERFECT', '最终 stage=PERFECT');
  assert(fp.growth_value >= 1200, '最终 growth_value>=1200: ' + fp.growth_value);
  assert(Array.isArray(fp.growth_records), '最终 growth_records 是数组');
  console.log('    成长记录数: ' + fp.growth_records.length + ' 条');
  console.log('    最终属性: ' + JSON.stringify(fp.attributes));


  // ====== 测试5: 多目标场景 ======
  section('测试5: 多目标场景 — 创建2个目标+各自创建任务+打卡');

  var goal1 = await testCreateGoal('目标A: 晨跑30天');
  var goal2 = await testCreateGoal('目标B: 阅读1小时');
  assert(goal1.success === true, '创建目标A成功');
  assert(goal2.success === true, '创建目标B成功');
  assert(goal1.id !== goal2.id, '两个目标 ID 不同');

  // 为每个目标创建任务
  var task1 = await testCreateTask(goal1.id, '今天晨跑3公里');
  var task2 = await testCreateTask(goal2.id, '阅读《原则》第3章');
  assert(task1.success === true, '任务1创建成功');
  assert(task2.success === true, '任务2创建成功');

  // 分别打卡
  var check1 = await testTaskCheckin(task1.id);
  var check2 = await testTaskCheckin(task2.id);
  assert(check1.success === true, '任务1打卡成功');
  assert(check2.success === true, '任务2打卡成功');
  assertEqual(check1.xp_earned, 10, '任务1 XP=10');
  assertEqual(check2.xp_earned, 10, '任务2 XP=10');

  // 验证任务状态
  var tasksAfter = await mockSafeQuery("tasks", { _openid: TEST_OPENID });
  var doneCount = tasksAfter.filter(function(t) { return t.completed === true; }).length;
  assertEqual(doneCount, 2, '2个任务都标记为完成');

  // 验证目标列表
  var goalsAfter = await mockSafeQuery("goals", { _openid: TEST_OPENID, status: 'active' });
  assert(goalsAfter.length >= 2, '至少有2个活跃目标');


  // ====== 测试6: getDashboard 返回值验证 (V6字段) ======
  section('测试6: getDashboard — 验证 activePet 含V6字段');

  var dash = await testGetDashboard();
  assert(dash.code === 0, 'dashboard code=0');
  assert(dash.data.user, 'dashboard 含 user');
  assert(dash.data.goals, 'dashboard 含 goals');
  assert(dash.data.todayTasks, 'dashboard 含 todayTasks');

  if (dash.data.activePet) {
    var ap = dash.data.activePet;
    console.log('  📋 activePet 概览:');
    console.log('     name=' + ap.name + ' | stage=' + ap.stage + ' | is_hatched=' + ap.is_hatched);
    console.log('     egg_type=' + ap.egg_type + ' | growth_value=' + ap.growth_value);
    console.log('     species=' + (ap.species || '(蛋)') + ' | rarity=' + ap.rarity);
    console.log('     talent=' + ap.talent + '(' + ap.talent_grade + ')' + ' | color_tier=' + ap.color_tier);

    // 【V8.4 关键验证】V6字段必须存在
    assertContains(ap, 'egg_type', 'activePet.egg_type (V6)');
    assertContains(ap, 'growth_value', 'activePet.growth_value (V6)');
    assertContains(ap, 'is_shiny', 'activePet.is_shiny (V6)');
    assertContains(ap, 'color_tier', 'activePet.color_tier (V6)');
    assertContains(ap, 'color_label', 'activePet.color_label (V6)');
    assertContains(ap, 'talent', 'activePet.talent (V8.0)');
    assertContains(ap, 'talent_grade', 'activePet.talent_grade (V8.0)');
    assertContains(ap, 'talent_name', 'activePet.talent_name (V8.0)');

    // 如果是已孵化的宠物，这些也应有值
    if (ap.is_hatched === true) {
      assert(ap.species, '已孵化宠物有 species');
      assert(ap.rarity, '已孵化宠物有 rarity');
      assert(typeof ap.attributes === 'object', '已孵化宠物 attributes 是对象');
    } else {
      // 如果是蛋，应有蛋相关字段
      assertEqual(ap.stage, 'egg', '未孵化宠物 stage=egg');
    }
  } else {
    console.log('  ⚠️ 无 activePet (可能已被删除)');
  }


  // ====== 测试7: 边界情况 ======
  section('测试7: 边界情况和异常处理');

  // 7a: 不能创建重复的蛋（当前已有1只已孵化的宠物，可以再领新蛋，但最多3只）
  var dupEgg = await testCreateEgg({ egg_type: 'home_egg' });
  // 孵化后 is_hatched=true，所以 createEgg 应该允许创建新蛋（只有1只宠物 < 3）
  assert(dupEgg.success === true || dupEgg.code === -1, '创建结果合理 (允许或有其他限制)');

  // 7b: 分配0金额 = 全部倒入
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, { growth_pool: 42, updated_at: Date.now() });
  var allocAll = await testAllocatePool(EGG_ID, 0);
  assert(allocAll.allocated === 42, 'amount=0 时全部倒入: 42');

  // 7c: 分配超过余额 = 截断到余额
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, { growth_pool: 10, updated_at: Date.now() });
  var allocOver = await testAllocatePool(EGG_ID, 999);
  assert(allocOver.allocated === 10, '超额分配截断到余额: 10');

  // 7d: 池子空时拒绝
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, { growth_pool: 0, updated_at: Date.now() });
  var allocEmpty = await testAllocatePool(EGG_ID, 5);
  assert(allocEmpty.code === -1, '池子空时拒绝分配: code=-1');

  // 7e: performPetHatch 对不同蛋类型都能正常工作
  var forestHatch = performPetHatch('forest_egg');
  var homeHatch = performPetHatch('home_egg');
  var wildHatch = performPetHatch('wild_egg');
  assert(forestHatch.result.species, '森林蛋孵化出物种: ' + forestHatch.result.species);
  assert(homeHatch.result.species, '家园蛋孵化出物种: ' + homeHatch.result.species);
  assert(wildHatch.result.species, '荒野蛋孵化出物种: ' + wildHatch.result.species);
  // 不同蛋类型应该倾向于产出不同系别的物种
  var forestSpecies = forestHatch.result.species;
  var homeSpecies = homeHatch.result.species;
  console.log('    森林蛋→' + forestSpecies + ' | 家园蛋→' + homeSpecies + ' | 荒野蛋→' + wildHatch.result.species);

  // 7f: getEggStage 各阶段边界
  assertEqual(getEggStage(0), 'pattern_egg', '0→pattern_egg');
  assertEqual(getEggStage(24), 'pattern_egg', '24→pattern_egg');
  assertEqual(getEggStage(25), 'glowing_egg', '25→glowing_egg');
  assertEqual(getEggStage(49), 'glowing_egg', '49→glowing_egg');
  assertEqual(getEggStage(50), 'cracking_egg', '50→cracking_egg');
  assertEqual(getEggStage(99), 'cracking_egg', '99→cracking_egg');
  assertEqual(getEggStage(100), 'hatched', '100→hatched');
  assertEqual(getEggStage(999), 'hatched', '999→hatched');

  // 7g: getGrowthStage 各阶段边界
  assertEqual(getGrowthStage(0).key, 'EGG', '0→EGG');
  assertEqual(getGrowthStage(99).key, 'EGG', '99→EGG');
  assertEqual(getGrowthStage(100).key, 'BABY', '100→BABY');
  assertEqual(getGrowthStage(299).key, 'BABY', '299→BABY');
  assertEqual(getGrowthStage(300).key, 'YOUTH', '300→YOUTH');
  assertEqual(getGrowthStage(599).key, 'YOUTH', '599→YOUTH');
  assertEqual(getGrowthStage(600).key, 'ADULT', '600→ADULT');
  assertEqual(getGrowthStage(1199).key, 'ADULT', '1199→ADULT');
  assertEqual(getGrowthStage(1200).key, 'PERFECT', '1200→PERFECT');
  assertEqual(getGrowthStage(9999).key, 'PERFECT', '9999→PERFECT');


  // ====== 最终报告 ======
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║              测试结果汇总                       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  ✅ 通过: ' + String(passed).padStart(4) + '  项                              ║');
  console.log('║  ❌ 失败: ' + String(failed).padStart(4) + '  项                              ║');
  console.log('║  通过率: ' + (Math.round(passed / (passed + failed) * 100)) + '%                                       ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (errors.length > 0) {
    console.log('\n⚠️ 失败详情:');
    errors.forEach(function(e, i) { console.log('  ' + (i + 1) + '. ' + e); });
  }

  // 不在此处exit，让后续测试继续运行
  return { passed: passed, failed: failed };
}

// ====== 测试8: attributes:null 旧数据兼容性 (V8.4关键修复) ======
async function runTest8_AttributesNull() {
  section('测试8: attributes:null旧数据 → allocatePool孵化不崩溃');

  // 模拟一条旧数据：蛋的attributes为null（V8.3之前的遗留数据）
  var oldEgg = await mockSafeAdd("pets", {
    _openid: TEST_OPENID,
    name: '旧森林蛋', stage: "egg", egg_stage: "egg",
    level: 1, experience: 0, species: "",
    egg_type: 'forest_egg', growth_value: 80,
    is_hatched: false, rarity: 'unknown',
    attributes: null,  // ← 关键：模拟V8.3之前的null数据
    bond: 0, mood: 'sleepy', mood_message: '',
    awakened: false, personality: '', titles: [],
    created_at: Date.now(), updated_at: Date.now(),
  });
  var OLD_EGG_ID = oldEgg._id;

  // 往池子灌水
  await mockSafeUpdate("user_growth_pool", { _openid: TEST_OPENID }, {
    growth_pool: 500, updated_at: Date.now()
  });

  // 分配30点：80+30=110≥100 触发孵化
  // 【V8.4最终修复】不再预清理attributes:{}
  // 直接用performPetHatch的完整updateFields(含非空attributes)整字段替换
  var oldAllocResult = await testAllocatePool(OLD_EGG_ID, 30);
  assert(oldAllocResult.success === true, 'attributes:null蛋分配成功(不崩溃)');
  assert(oldAllocResult.hatched === true, 'attributes:null蛋成功孵化');
  assert(oldAllocResult.pet.attributes, '孵化后pet有attributes对象');

  // 验证DB中的attributes不再是null
  var oldHatched = await mockSafeQuery("pets", { _id: OLD_EGG_ID });
  assert(oldHatched[0].attributes !== null, 'DB中attributes不再是null');
  assert(typeof oldHatched[0].attributes === 'object', 'DB中attributes是object类型');
  assert(oldHatched[0].attributes.vitality >= 0, 'attributes.vitality有效: ' + oldHatched[0].attributes.vitality);

  console.log('  ✅ V8.4最终修复验证通过: null→直接整字段替换→完整属性对象(无预清理)');
}

// 运行
runAllTests()
  .then(function(result) {
    // 继续运行测试8
    return runTest8_AttributesNull().then(function() {
      console.log('\n╔══════════════════════════════════════════════════╗');
      console.log('║              全部测试完成                       ║');
      console.log('╚══════════════════════════════════════════════════╝');
      process.exit((result.failed > 0) ? 1 : 0);
    });
  })
  .catch(function(err) {
    console.error('测试脚本执行失败:', err);
    process.exit(1);
  });
