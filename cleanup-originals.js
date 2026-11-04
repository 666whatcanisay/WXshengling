/**
 * 批量清理宠物原图 — 只保留 _thumb.png 压缩版
 *
 * 用法: node cleanup-originals.js
 * 
 * 安全机制:
 *   - 第一步只打印待删除列表（dry-run），不执行删除
 *   - 第二步需手动确认才执行实际删除
 *   - 删除前自动备份文件名到 .cleanup-backup.log
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 配置
// ============================================================
const SPECIES_ROOT = path.join(__dirname, 'miniprogram', 'assets', 'pets', 'species', 'assets', 'pets');
const WORK_DIR = path.join(__dirname, 'miniprogram', 'assets', 'pets', 'species', 'work');
const TEST_DIR = path.join(SPECIES_ROOT, 'test');

// 要保留的文件模式（白名单）
const KEEP_PATTERNS = [
  /_thumb\.png$/i,           // 压缩图
  /\.json$/i,                // 报告JSON（可选，可后续删）
];

// 要删除的原图后缀（黑名单）
const DELETE_SUFFIXES = ['baby.png', 'youth.png', 'adult.png', 'perfect.png'];

// 备份日志
const LOG_FILE = path.join(__dirname, '.cleanup-backup.log');

// ============================================================
// 工具函数
// ============================================================
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(2) + 'MB';
}

function formatTable(rows) {
  if (rows.length === 0) return '(无)';
  const cols = Object.keys(rows[0]);
  const widths = {};
  cols.forEach(c => { widths[c] = Math.max(c.length, ...rows.map(r => String(r[c]||'').length)); });
  
  let lines = [];
  // 表头
  lines.push(cols.map(c => c.padEnd(widths[c])).join('  |  ') + '\n' + cols.map(c => '-'.repeat(widths[c])).join('-|--|-'));
  // 数据行
  rows.forEach(r => { lines.push(cols.map(c => String(r[c]||'').padEnd(widths[c])).join('  |  ')); });
  return lines.join('\n');
}

// ============================================================
// 扫描阶段
// ============================================================
function scanSpeciesDir() {
  console.log('\n═══ 阶段1: 扫描物种目录 ═══\n');
  
  const results = [];
  const speciesDirs = fs.readdirSync(SPECIES_ROOT).filter(f => {
    const fp = path.join(SPECIES_ROOT, f);
    return fs.statSync(fp).isDirectory() && f !== 'test';
  });

  speciesDirs.forEach(species => {
    const spDir = path.join(SPECIES_ROOT, species);
    const files = fs.readdirSync(spDir);
    
    files.forEach(file => {
      const fp = path.join(spDir, file);
      if (!fs.statSync(fp).isFile()) return;
      
      const isThumb = KEEP_PATTERNS.some(p => p.test(file));
      const isOriginal = DELETE_SUFFIXES.some(s => file === s);
      const isOther = !isThumb && !isOriginal;
      
      const size = fs.statSync(fp).size;
      
      results.push({
        species,
        file,
        size: fmtSize(size),
        bytes: size,
        action: isThumb ? '✅ 保留(thumb)' : isOriginal ? '🗑️ 待删除(原图)' : '⚠️ 其他'
      });
    });
  });

  console.log(formatTable(results));
  console.log(`\n共扫描 ${results.length} 个文件`);
  
  const toDelete = results.filter(r => r.action.includes('删除'));
  const toKeep = results.filter(r => r.action.includes('保留'));
  const others = results.filter(r => r.action.includes('其他'));
  
  console.log(`  ✅ 保留(thumb): ${toKeep.length} 张, 总计 ${fmtSize(toKeep.reduce((s,r)=>s+r.bytes,0))}`);
  console.log(`  🗑️ 待删除(原图): ${toDelete.length} 张, 总计 ${fmtSize(toDelete.reduce((s,r)=>s+r.bytes,0))}`);
  console.log(`  ⚠️ 其他(json等): ${others.length} 个, 总计 ${fmtSize(others.reduce((s,r)=>s+r.bytes,0))}`);

  return { all: results, toDelete, toKeep, others };
}

function scanWorkAndTest() {
  console.log('\n═══ 阶段2: 扫描 work/ 和 test/ 目录 ═══\n');
  
  const workResults = [];
  const testResults = [];

  // work 目录
  if (fs.existsSync(WORK_DIR)) {
    function walk(dir, rel) {
      try {
        fs.readdirSync(dir).forEach(f => {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          const relPath = rel ? path.join(rel, f) : f;
          if (stat.isDirectory()) walk(fp, relPath);
          else workResults.push({ dir: 'work/', file: relPath, size: fmtSize(stat.size), bytes: stat.size });
        });
      } catch(e) {}
    }
    walk(WORK_DIR, '');
  }

  // test 目录
  if (fs.existsSync(TEST_DIR)) {
    fs.readdirSync(TEST_DIR).forEach(f => {
      const fp = path.join(TEST_DIR, f);
      const stat = fs.statSync(fp);
      testResults.push({ dir: 'test/', file: f, size: fmtSize(stat.size), bytes: stat.size });
    });
  }

  const allWorkTest = [...workResults, ...testResults];
  if (allWorkTest.length > 0) {
    console.log(formatTable(allWorkTest));
  }
  
  console.log(`\n  work/: ${workResults.length} 个文件, ${fmtSize(workResults.reduce((s,r)=>s+r.bytes,0))}`);
  console.log(`  test/: ${testResults.length} 个文件, ${fmtSize(testResults.reduce((s,r)=>s+r.bytes,0))}`);
  console.log(`  合计: ${allWorkTest.length} 个文件, ${fmtSize(allWorkTest.reduce((s,r)=>s+r.bytes,0))}`);

  return { workResults, testResults, all: allWorkTest };
}

// ============================================================
// 执行删除
// ============================================================
function executeDelete(toDelete, workTestAll) {
  console.log('\n═══ 阶段3: 执行清理 ═══\n');
  
  const logEntries = [];
  let deletedCount = 0;
  let freedBytes = 0;

  // 3a: 删除物种目录下的原图
  toDelete.forEach(item => {
    const filePath = path.join(SPECIES_ROOT, item.species, item.file);
    
    try {
      logEntries.push({
        time: new Date().toISOString(),
        action: 'DELETE',
        path: `assets/pets/${item.species}/${item.file}`,
        size: item.size,
        bytes: item.bytes
      });

      fs.unlinkSync(filePath);
      deletedCount++;
      freedBytes += item.bytes;
      console.log(`  🗑️ 已删除: ${item.species}/${item.file} (${item.size})`);
    } catch (e) {
      console.log(`  ❌ 删除失败: ${item.species}/${item.file} — ${e.message}`);
    }
  });

  // 3b: 删除 work/ 目录
  if (workTestAll.workResults.length > 0 && fs.existsSync(WORK_DIR)) {
    console.log(`\n  📁 清理 work/ 目录...`);
    try {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
      const workBytes = workTestAll.workResults.reduce((s, r) => s + r.bytes, 0);
      logEntries.push({
        time: new Date().toISOString(),
        action: 'RMDIR',
        path: 'work/',
        size: fmtSize(workBytes),
        bytes: workBytes
      });
      deletedCount += workTestAll.workResults.length;
      freedBytes += workBytes;
      console.log(`  🗑️ 已删除 work/ (${workTestAll.workResults.length}个文件, ${fmtSize(workBytes)})`);
    } catch (e) {
      console.log(`  ❌ 删除work失败: ${e.message}`);
    }
  }

  // 3c: 删除 test/ 目录
  if (workTestAll.testResults.length > 0 && fs.existsSync(TEST_DIR)) {
    console.log(`  📁 清理 test/ 目录...`);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      const testBytes = workTestAll.testResults.reduce((s, r) => s + r.bytes, 0);
      logEntries.push({
        time: new Date().toISOString(),
        action: 'RMDIR',
        path: 'test/',
        size: fmtSize(testBytes),
        bytes: testBytes
      });
      deletedCount += workTestAll.testResults.length;
      freedBytes += testBytes;
      console.log(`  🗑️ 已删除 test/ (${workTestAll.testResults.length}个文件, ${fmtSize(testBytes)})`);
    } catch (e) {
      console.log(`  ❌ 删除test失败: ${e.message}`);
    }
  }

  // 写入备份日志
  fs.writeFileSync(LOG_FILE, JSON.stringify(logEntries, null, 2));

  console.log(`\n═══ 清理完成 ═══`);
  console.log(`  删除文件数: ${deletedCount}`);
  console.log(`  释放空间: ${fmtSize(freedBytes)} (${(freedBytes/1024/1024).toFixed(2)} MB)`);
  console.log(`  备份日志: ${LOG_FILE}`);
}

// ============================================================
// 主流程
// ============================================================

console.log('╔══════════════════════════════════════════╗');
console.log('║  宠物原图批量清理工具                      ║');
console.log('║  目标: 删除原图+work+test，仅保留thumb     ║');
console.log('╚══════════════════════════════════════════╝');

// Step 1: Dry-run 扫描
const scanResult = scanSpeciesDir();
const wtResult = scanWorkAndTest();

// 汇总
const totalToDelete = scanResult.toDelete.length + wtResult.all.length;
const totalFreed = [...scanResult.toDelete, ...wtResult.all].reduce((s, r) => s + r.bytes, 0);

console.log('\n═══ 汇总 ═══');
console.log(`  待删除总数: ${totalToDelete} 个文件`);
console.log(`  预计释放: ${fmtSize(totalFreed)} (${(totalFreed/1024/1024).toFixed(2)} MB)`);

if (totalToDelete === 0) {
  console.log('\n  ✅ 无需清理，所有原图已不存在。');
  process.exit(0);
}

// Step 2: 确认执行
const args = process.argv.slice(2);
const forceMode = args.includes('--force') || args.includes('-f');

if (!forceMode) {
  console.log(`
═════════════════════════════════════════════════════
  🔒 DRY RUN 模式 — 以上仅为预览，未执行任何删除
  
  如确认要执行删除，请运行:
    node cleanup-originals.js --force
  
  或使用短参数:
    node cleanup-originals.js -f
═════════════════════════════════════════════════════`);
  process.exit(0);
}

// Step 3: 实际执行
console.log('\n  ⚠️  FORCE 模式 — 开始执行删除...\n');
executeDelete(scanResult.toDelete, wtResult);

// 最终验证
console.log('\n═══ 验证: 清理后剩余文件 ═══');
let finalTotal = 0;
let finalCount = 0;
fs.readdirSync(SPECIES_ROOT).filter(f => {
  const fp = path.join(SPECIES_ROOT, f);
  return fs.statSync(fp).isDirectory() && f !== 'test';
}).forEach(species => {
  const spDir = path.join(SPECIES_ROOT, species);
  if (!fs.existsSync(spDir)) return;
  fs.readdirSync(spDir).forEach(file => {
    const fp = path.join(spDir, file);
    if (fs.statSync(fp).isFile()) {
      finalTotal += fs.statSync(fp).size;
      finalCount++;
    }
  });
});
console.log(`  剩余文件: ${finalCount} 张`);
console.log(`  剩余大小: ${fmtSize(finalTotal)} (${(finalTotal/1024/1024).toFixed(2)} MB)`);
console.log(`  是否 ≤ 1.5MB: ${finalTotal <= 1.5*1024*1024 ? '✅ 通过' : '❌ 超限 (' + (finalTotal/1024/1024).toFixed(2) + 'MB)'}`);

console.log('\n✅ 全部完成。请在微信开发者工具中重新编译验证。');
