// 初始化云函数：创建数据库集合
// 首次部署后在开发者工具中调用一次即可
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 预置成就定义（首次运行时写入）
const SEED_ACHIEVEMENTS = [
  { name: "初次打卡", description: "完成第一次任务打卡", icon: "📝", category: "成长", rarity: "common", xp_reward: 50 },
  { name: "连续7天", description: "连续打卡7天", icon: "🔥", category: "坚持", rarity: "rare", xp_reward: 100 },
  { name: "目标达人", description: "完成第一个目标", icon: "🎯", category: "成长", rarity: "epic", xp_reward: 200 },
  { name: "AI先驱", description: "与AI助手完成100次对话", icon: "🤖", category: "AI", rarity: "legendary", xp_reward: 500 },
  { name: "宠物伙伴", description: "拥有第一只宠物", icon: "🐱", category: "宠物", rarity: "common", xp_reward: 50 },
  { name: "坚持不懈", description: "连续打卡30天", icon: "💪", category: "坚持", rarity: "epic", xp_reward: 300 },
];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    console.log(`[OK] 创建集合: ${name}`);
    return { name, created: true };
  } catch (e) {
    // 集合已存在是正常的
    console.log(`[OK] 集合已存在: ${name}`);
    return { name, created: false };
  }
}

exports.main = async (event, context) => {
  const collections = ["users", "goals", "tasks", "pets", "checkins", "achievements", "emotions", "growth_logs", "api_keys", "feedbacks", "ai_plans", "user_growth_pool", "capsules", "announcements"];

  const results = [];
  for (const name of collections) {
    const r = await ensureCollection(name);
    results.push(r);
  }

  // 写入预置成就定义（作为参考数据）
  // 注意：成就实际解锁由业务逻辑写入用户维度
  try {
    const existing = await db.collection("achievements").count();
    if (existing.total === 0) {
      const achievementsCollection = db.collection("achievements");
      for (const ach of SEED_ACHIEVEMENTS) {
        await achievementsCollection.add({
          data: { ...ach, system: true, created_at: Date.now() },
        });
      }
      console.log("[OK] 预置成就已写入");
    }
  } catch (e) {
    console.log("[INFO] 预置成就写入跳过:", e.message);
  }

  return {
    code: 0,
    message: "初始化完成",
    data: {
      collections: results,
      collections_count: results.length,
      note: "请检查控制台确认所有集合已创建",
    },
  };
};
