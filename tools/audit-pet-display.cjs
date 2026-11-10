// Local diagnostics against current source. No network or real CloudBase writes.
const fs = require('fs');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const clone = x => JSON.parse(JSON.stringify(x));
let tempCalls = 0;
function page(api = {}, resolveFile = fileID => ({ fileID, tempFileURL: 'https://audit.invalid/' + encodeURIComponent(fileID), errMsg: 'ok' })) {
  let definition;
  const filename = path.join(root, 'miniprogram/pages/pets/pets.js');
  const localRequire = createRequire(filename);
  const wx = new Proxy({
    getStorageSync() { return ''; },
    cloud: { async getTempFileURL({ fileList }) {
      tempCalls++;
      return { fileList: fileList.map(resolveFile).filter(Boolean) };
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
  const forest = page();
  const baby = forest.buildDisplayPet(pet({ growth_value: 150, rarity: 'epic' }));
  const perfect = forest.buildDisplayPet(pet({ growth_value: 1858, stage: 'ADULT', rarity: 'rare', talent_grade: 'A' }));
  assert.equal(baby.portrait.form, 'baby');
  assert.equal(baby._stageProgressPercent, 25);
  assert.match(baby.colorLayerStyle, /hue-rotate\(280deg\)/);
  assert.equal(perfect.portrait.form, 'perfect');
  assert.equal(perfect.portrait.theme, 'base');
  const adultS = forest.buildDisplayPet(pet({ growth_value: 600, talent_grade: 'S' }));
  const perfectS = forest.buildDisplayPet(pet({ growth_value: 1858, talent_grade: 'S' }));
  assert.equal(adultS.portrait.form, 'adult');
  assert.ok(['dew', 'orbit', 'lantern'].includes(adultS.portrait.theme));
  assert.equal(perfectS.portrait.theme, adultS.portrait.theme);
  const forms = [100, 299, 300, 599, 600, 1199, 1200].map(growth_value => {
    const card = forest.buildDisplayPet(pet({ growth_value, talent: 98, talent_grade: 'F' }));
    assert.equal(card.talentGrade, 'S');
    assert.equal(card.portrait.theme, adultS.portrait.theme);
    return card.portrait.form;
  });
  assert.deepEqual(forms, ['baby', 'baby', 'youth', 'youth', 'adult', 'adult', 'perfect']);
  for (const form of new Set(forms)) for (const file of ['body', 'ear-tips', 'blink', 'still']) {
    const image = fs.readFileSync(path.join(root, 'miniprogram/pet-art/portrait/art/lynx', form, file + '.png'));
    assert.equal(image[25], 6, form + '/' + file + ' should have an alpha channel');
  }
  assert.equal(forest.buildDisplayPet(pet({ growth_value: undefined, stage: 'PERFECT' })).portrait.form, 'perfect');
  assert.equal(forest.buildDisplayPet(pet({ growth_value: 0, stage: 'YOUTH' })).app.currentStage.key, 'YOUTH');
  assert.equal(forest.buildDisplayPet(pet({ growth_value: 0, stage: 'EGG' })).portrait.form, 'baby');
  assert.equal(forest.buildDisplayPet(pet({ color_tier: 'shiny' })).isShiny, true);
  assert.equal(forest.buildDisplayPet(pet({ color_tier: 'normal', is_shiny: true })).colorTier, 'shiny');
  assert.equal(forest.buildDisplayPet(pet({ color_tier: 'rare' })).isRare, true);
  assert.equal(forest.buildDisplayPet(pet({ growth_value: 1858, species: 'wolf' })).portrait.species, 'wolf');
  assert.equal(forest.buildDisplayPet(pet({ growth_value: 1858, species: 'unconfigured' })).portrait, null);
  assert.equal(forest.buildDisplayPet(pet({ growth_value: 1858, is_hatched: false })).portrait, null);
  const forestTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.wxml'), 'utf8');
  assert.match(forestTemplate, /<pet-portrait\s+active="{{campVisible && currentSwiperIndex === index}}" species="{{dp\.portrait\.species}}"/);
  findings.portrait = { baby: baby.portrait, allForms: [...new Set(forms)], stableSTheme: true };
  const portraitRoot = path.join(root, 'miniprogram/pet-art/portrait');
  const rigs = require(path.join(portraitRoot, 'rigs'));
  const allPortraits = new Set();
  const checkPng = file => {
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), 'PNG', file);
    assert.ok(png[25] === 6 || (png[25] === 3 && png.includes(Buffer.from('tRNS'))), file + ' must preserve transparency');
  };
  for (const { id } of species.list) {
    const sample = pet({ species: id, talent: 98 });
    let ornament;
    for (const [growth_value, form] of [[150, 'baby'], [300, 'youth'], [600, 'adult'], [1200, 'perfect']]) {
      const card = forest.buildDisplayPet({ ...sample, growth_value });
      assert.equal(card.portrait.species, id);
      assert.equal(card.portrait.form, form);
      assert.notEqual(card.portrait.theme, 'base');
      ornament ??= card.portrait.theme;
      assert.equal(card.portrait.theme, ornament);
      assert.equal(forest.buildDisplayPet({ ...sample, growth_value, talent: 90 }).portrait.theme, 'base');
      for (const name of ['body', 'blink']) checkPng(path.join(portraitRoot, 'art', id, form, name + '.png'));
      if (id !== 'lynx') {
        const rig = rigs[id][form];
        assert.ok(rig.body && rig.blink && rig.ornament);
        if (id === 'hamster' || id === 'capybara') assert.equal(rig.tail, '');
        else {
          assert.ok(rig.tail);
          checkPng(path.join(portraitRoot, 'art', id, 'tail.png'));
        }
      }
      allPortraits.add(id + '/' + form);
    }
  }
  assert.equal(allPortraits.size, 60);
  const forestConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.json')));
  assert.equal(forestConfig.usingComponents['pet-portrait'], '/pet-art/portrait/index');
  assert.equal(forestConfig.componentPlaceholder['pet-portrait'], 'portrait-placeholder');
  findings.portrait.count = allPortraits.size;
  findings.filters = ['common','rare','epic','legendary'].map(rarity => {
    const result = page().buildDisplayPet(pet({ rarity }));
    return { rarity, colorTier: result.colorTier, style: result.colorLayerStyle };
  });
  const rareDp = page().buildDisplayPet(pet({ color_tier: 'rare' }));
  const awakenedDp = page().buildDisplayPet(pet({ awakened: true }));
  findings.missingBindings = { rareAppFlag: rareDp.app.isRare, rareCardFlag: rareDp.isRare ?? null,
    awakenedInput: true, awakenedAppFlag: awakenedDp.app.awakened ?? null,
    templateUsesAppearanceContainerClass: fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.wxml'), 'utf8').includes('app.containerClass') };

  const pets = [
    pet({ id: 'first', _id: 'first', name: '第一只', species: 'wolf' }),
    pet({ id: 'second', _id: 'second', name: '第二只', growth_value: 1858 }),
    pet({ id: 'third', _id: 'third', name: '第三只', growth_value: 299 }),
  ];
  let finishInteraction;
  const p = page({
    async getBackpack() { return []; },
    async petOverview() { return pets; },
    async syncEverOwnedSpecies() { return null; },
    petInteract(id) {
      assert.equal(id, 'third');
      return new Promise(resolve => { finishInteraction = resolve; });
    },
  });
  const callsBeforeLoad = tempCalls;
  await p.loadData();
  assert.equal(tempCalls, callsBeforeLoad);
  assert.equal(p.data.displayPets[0].portrait.species, 'wolf');
  p.switchToPetByIndex(2);
  await p.loadData();
  assert.equal(p.data.currentSwiperIndex, 2);
  assert.equal(p.data.activePet.id, 'third');
  assert.equal(p.data.profileData.name, '第三只');
  const pending = p.petInteract({ currentTarget: { dataset: { type: 'feed' } } });
  p.switchToPetByIndex(1);
  finishInteraction({ success: true, xp_earned: 10, new_bond: 52, new_level: 2, new_stage: 'ADULT', mood: 'normal' });
  await pending;
  assert.equal(p.data.activePet.id, 'second');
  assert.equal(p.data.canAwaken, true);
  p._showFloatingFeedback('+5 XP');
  assert.equal(p.data.showFloatingFeedback, true);
  assert.equal(p.data.displayPets[2].portrait.form, 'baby');
  assert.equal(p.data.petList[2].bond, 52);
  assert.equal(p._refreshPetUI('third', { growth_value: 300 }), false);
  assert.equal(p.data.activePet.id, 'second');
  p.switchToPetByIndex(2);
  assert.equal(p.data.activePet.growth_value, 300);
  assert.equal(p.data.displayPets[2].portrait.form, 'youth');
  assert.equal(p.data.profileData.stageName, '少年');
  assert.equal(p.data.profileData.bond, 52);
  p._refreshPetUI('first', { growth_value: 300 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.data.displayPets[0].portrait.form, 'youth');
  assert.equal(p.data.activePet.id, 'third');
  const missingImage = page({}, () => null);
  const missingCard = { isEgg: false, app: { baseSprite: 'cloud://audit/missing.png' } };
  await missingImage.resolvePetImageUrls([missingCard]);
  assert.equal(missingCard.app.baseSprite, '');
  findings.multiPetRefresh = { keptSelection: true, lateInteractionUpdatedById: true, growthAfterSwitch: 300, profile: '少年', cloudImageFallback: true };

  const { offlineCloudbase } = require('../tests/helpers/offline-cloudbase.cjs');
  const adminEnv = offlineCloudbase({
    users: [{ _id: 'admin', _openid: 'owner', role: 'admin' }],
    pets: [{ _id: 'p', _openid: 'owner', is_hatched: true, growth_value: 100, experience: 0, stage: 'BABY', mood: 'normal' }],
  }, { serialTransactions: true });
  try {
    const cloudContext = vm.createContext({ require(name) {
      if (name === 'wx-server-sdk') return adminEnv.cloud;
      if (name === 'https') return { request() { throw new Error('Network prohibited'); } };
      return createRequire(path.join(root, 'cloudfunctions/app/index.js'))(name);
    }, exports: {}, console: quiet, Date, Buffer, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/app/index.js'), 'utf8'), cloudContext);
    const receipt = await vm.runInContext("adminEditPet('owner', {petId:'p',stage:'PERFECT',level:20,experience:2000,mood:'happy'})", cloudContext);
    assert.equal(receipt.success, true);
    const adminPet = adminEnv.rows.pets[0];
    const adminAppearance = appearances.getPetAppearance(pet(adminPet));
    assert.equal(adminPet.growth_value, 1200);
    assert.equal(adminPet.mood, 'happy');
    assert.equal(adminAppearance.stage, 'PERFECT');
    findings.adminEdit = { savedStage: adminPet.stage, savedGrowth: adminPet.growth_value,
      savedExperience: adminPet.experience, savedMood: adminPet.mood, displayedStage: adminAppearance.stage };
  } finally {
    adminEnv.close();
  }
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/pets/pets.js'), 'utf8');
  findings.sourceBoundaries = { tempResolverReferences: (source.match(/resolvePetImageUrls\(/g) || []).length,
    expectedStageImages: species.list.length * 4, cloudFilesDownloaded: 0 };
  console.log = oldLog;
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(findings, null, 2) + '\n');
  oldLog(JSON.stringify(findings, null, 2));
})().catch(error => { console.log = oldLog; console.error(error); process.exitCode = 1; });
