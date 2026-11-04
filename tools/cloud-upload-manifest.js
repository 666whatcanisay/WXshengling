/**
 * 云存储批量上传工具 — V8.3 图片迁移专用
 *
 * 用法:
 *   1. 在 app.json 的 pages 数组中临时添加 "tools/cloudUpload/main"
 *   2. 编译运行，进入此页面
 *   3. 点击"开始上传"按钮
 *   4. 全部完成后，从 app.json 移除此页面
 *
 * 上传目标: cloud://cloud1-d5gz9j6zh654f4b36.xxx/pets/{物种}/{阶段}_thumb.png
 */

const fs = require('fs');
const pathMod = require('path');

// ===== 配置 =====
var PETS_ROOT = pathMod.join(__dirname, '..', 'assets', 'pets', 'species', 'assets', 'pets');
var CLOUD_DIR = 'pets/';  // 云存储目录前缀

// 15个物种 x 4阶段 = 60张
var SPECIES_LIST = [
  'black_cat','calico_cat','orange_cat',
  'shiba','corgi','golden_retriever','husky','wolf',
  'hamster','chinchilla','capybara',
  'snow_leopard','lynx',
  'fox','raccoon'
];
var STAGES = ['baby','youth','adult','perfect'];

module.exports = {
  
  /**
   * 获取待上传文件清单
   * @returns {Array<{localPath:string, cloudPath:string, size:number}>}
   */
  getUploadList: function() {
    var list = [];
    SPECIES_LIST.forEach(function(sp) {
      STAGES.forEach(function(stage) {
        var fileName = stage + '_thumb.png';
        var localPath = pathMod.join(PETS_ROOT, sp, fileName);
        if (fs.existsSync(localPath)) {
          var stat = fs.statSync(localPath);
          list.push({
            species: sp,
            stage: stage,
            fileName: fileName,
            localPath: localPath,
            cloudPath: CLOUD_DIR + sp + '/' + fileName,
            size: stat.size,
            sizeKB: (stat.size / 1024).toFixed(1) + 'KB'
          });
        } else {
          list.push({
            species: sp,
            stage: stage,
            fileName: fileName,
            localPath: localPath,
            cloudPath: CLOUD_DIR + sp + '/' + fileName,
            size: 0,
            sizeKB: 'MISSING',
            error: '本地文件不存在'
          });
        }
      });
    });
    return list;
  },

  /** 获取统计 */
  getStats: function() {
    var list = this.getUploadList();
    var totalSize = 0;
    var missing = 0;
    var found = 0;
    list.forEach(function(item) {
      if (item.error) missing++;
      else { totalSize += item.size; found++; }
    });
    return {
      total: list.length,
      found: found,
      missing: missing,
      totalSize: totalSize,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2) + 'MB'
    };
  },

  /** 打印上传清单（供控制台使用）*/
  printManifest: function() {
    var list = this.getUploadList();
    var stats = this.getStats();
    console.log('═══ 云存储上传清单 ═══');
    console.log('总数: ' + stats.total + ' | 存在: ' + stats.found + ' | 缺失: ' + stats.missing);
    console.log('总大小: ' + stats.totalSizeMB);
    console.log('');
    console.log('目标路径格式: cloud://env-id.bucket-id/' + CLOUD_DIR + '{物种}/{阶段}_thumb.png');
    console.log('');
    list.forEach(function(item) {
      if (item.error) {
        console.log('❌ ' + item.cloudPath + '  --  ' + item.error);
      } else {
        console.log('✅ ' + item.cloudPath + '  (' + item.sizeKB + ')');
      }
    });
    return list;
  }
};

// CLI 模式：直接运行此文件打印清单
if (require.main === module) {
  module.exports.printManifest();
}
