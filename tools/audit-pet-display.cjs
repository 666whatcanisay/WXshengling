// Local diagnostics against current source. No network or real CloudBase writes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const clone = x => JSON.parse(JSON.stringify(x));
let tempCalls = 0;
function page(api = {}) {
  let definition;
  const filename = path.join(root, 'miniprogram/pages/pets/pets.js');
  const localRequire = createRequire(filename);
  const wx = new Proxy({
    getStorageSync() { return ''; },
    cloud: { async getTempFileURL({ fileList }) {
      tempCalls++;
      return { fileList: fileList.map(fileID => ({ fileID, tempFileURL: 'https://audit.invalid/' + encodeURIComponent(fileID), errMsg: 'ok' })) };
    } },
  }, { get: (object, key) => key in object ? object[key] : () => {} });
  const context = vm.createContext({ Page(x) { definition = x; },
    require(name) { return name.endsWith('/cloudApi') ? api : localRequire(name); },
    wx, getApp: () => ({ globalData: {}, isOfflineMode: false }), console: quiet,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  definition.data = clone(definition.data);
  definition.writes = [];
  definition.setData = function(updates) {
    this.writes.push(...Object.keys(updates));
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let cursor = this.data;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
      cursor[parts.at(-1)] = value;
    }
  };
  definition._displayCache = {};
  definition._profileCache = {};
  return definition;
}
const pet = overrides => ({ id: 'p', _id: 'p', name: '测试宠物', species: 'lynx',
  is_hatched: true, stage: 'BABY', growth_value: 100, experience: 295, level: 1,
  rarity: 'common', color_tier: 'normal', is_shiny: false, personality: 'lively',
  bond: 50, mood: 'normal', attributes: { vitality: 2, wisdom: 2, luck: 2, resonance: 2 }, ...overrides });
const oldLog = console.log;
console.log = () => {};
(async () => {
  const findings = {};
  const assets = require(path.join(root, 'miniprogram/utils/pet_assets_config'));
  const species = require(path.join(root, 'miniprogram/utils/speciesConfig'));
  const appearances = require(path.join(root, 'miniprogram/utils/petConstants'));
  const inventory = assets.getFullInventory();
  findings.imageMappings = { species: inventory.bySpecies.length, combinations: inventory.total,
    uniquePaths: new Set(inventory.missingCheck).size,
    allColorTiersUseSameImage: inventory.bySpecies.every(s => ['BABY','YOUTH','ADULT','PERFECT'].every(stage =>
      new Set(['normal','rare','shiny'].map(color => assets.getPetImage(s.id, stage, color))).size === 1)) };
  findings.sameStageGrowth = [100,150,299,300,599,600,1199,1200].map(growth => {
    const result = appearances.getPetAppearance(pet({ growth_value: growth }));
    return { growth, stage: result.stage, file: result.baseSprite.split('/').at(-1) };
  });
  findings.filters = ['common','rare','epic','legendary'].map(rarity => {
    const result = page().buildDisplayPet(pet({ rarity }));
    return { rarity, colorTier: result.colorTier, style: result.colorLayerStyle };
  });
  const rareDp = page().buildDisplayPet(pet({ color_tier: 'rare' }));
  const awakenedDp = page().buildDisplayPet(pet({ awakened: true }));
  findings.missingBindings = { rareAppFlag: rareDp.app.isRare, rareCardFlag: rareDp.isRare ?? null,
    awakenedInput: true, awakenedAppFlag: awakenedDp.app.awakened ?? null,
    templateUsesAppearanceContainerClass: fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.wxml'), 'utf8').includes('app.containerClass') };

  const p = page({ async petInteract() { return { success: true, xp_earned: 10, bond_added: 2,
    new_bond: 52, new_level: 2, stage_changed: true, new_stage: 'ADULT', mood: 'normal' }; } });
  const original = pet({});
  const dp = p.buildDisplayPet(original);
  p.data.activePet = original; p.data.app = dp.app; p.data.isEgg = false;
  p.data.displayPets = [dp]; p.data.petList = [original]; p._displayCache.p = dp;
  await p.resolvePetImageUrls(p.data.displayPets);
  const initiallyResolved = p.data.displayPets[0].app.baseSprite.startsWith('https://');
  const callsBeforeInteraction = tempCalls;
  p.petInteract({ currentTarget: { dataset: { type: 'feed' } } });
  await Promise.resolve(); await Promise.resolve();
  findings.interactionRefresh = { initiallyResolved, activePetStage: p.data.activePet.stage,
    displayedStage: p.data.displayPets[0].app.stage, displayedGrowth: p.data.displayPets[0]._growthValueDisplay,
    imageAfterInteractionScheme: p.data.displayPets[0].app.baseSprite.split(':')[0],
    imageResolutionCalls: tempCalls - callsBeforeInteraction,
    wroteCarouselAppearance: p.writes.some(key => /^displayPets\[0\]\.app/.test(key)) };
  const callsBeforeFeed = tempCalls;
  p._refreshPetUI(pet({ growth_value: 600, stage: 'ADULT', experience: 305 }));
  findings.itemRefresh = { stage: p.data.displayPets[0].app.stage,
    imageFile: p.data.displayPets[0].app.baseSprite.split('/').at(-1),
    imageScheme: p.data.displayPets[0].app.baseSprite.split(':')[0],
    imageResolutionCalls: tempCalls - callsBeforeFeed };

  let rows = { users: [{ _openid: 'owner', role: 'admin' }], pets: [{ _id: 'p', _openid: 'owner',
    growth_value: 100, experience: 0, stage: 'BABY', mood: 'normal' }] };
  const db = { command: {}, collection(name) { return { where(filter) { return {
    async get() { return { data: clone((rows[name] || []).filter(row => Object.entries(filter).every(([k,v]) => row[k] === v))) }; },
    async update({ data }) { for (const row of rows[name] || []) if (Object.entries(filter).every(([k,v]) => row[k] === v)) Object.assign(row, data); return { updated: 1 }; },
  }; } }; } };
  const cloudContext = vm.createContext({ require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'owner' }) };
    if (name === 'https') return { request() { throw new Error('Network prohibited'); } };
    return createRequire(path.join(root, 'cloudfunctions/app/index.js'))(name);
  }, exports: {}, console: quiet, Date, Buffer, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/app/index.js'), 'utf8'), cloudContext);
  await vm.runInContext("adminEditPet('owner', {petId:'p',stage:'PERFECT',level:20,experience:2000,mood:'happy'})", cloudContext);
  const adminPet = rows.pets[0];
  const adminAppearance = appearances.getPetAppearance(pet(adminPet));
  findings.adminEdit = { savedStage: adminPet.stage, savedGrowth: adminPet.growth_value,
    savedExperience: adminPet.experience, savedMood: adminPet.mood, displayedStage: adminAppearance.stage };
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.js'), 'utf8');
  findings.sourceBoundaries = { tempResolverReferences: (source.match(/resolvePetImageUrls\(/g) || []).length,
    expectedStageImages: species.list.length * 4, cloudFilesDownloaded: 0 };
  console.log = oldLog;
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(findings, null, 2) + '\n');
  oldLog(JSON.stringify(findings, null, 2));
})().catch(error => { console.log = oldLog; console.error(error); process.exitCode = 1; });
