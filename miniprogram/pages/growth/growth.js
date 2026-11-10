const cloudApi = require("../../utils/cloudApi");
const { today } = require("../../utils/planSchedule");

const PET_LOG_TYPES = new Set(['pet_stage', 'stage_up', 'hatch', 'hatch_pool', 'awaken', 'release', 'item_use', 'fountain_allocate']);

function displayLog(item) {
  const source = [item.source, item.log_type].find(value => typeof value === 'string' && value) || 'xp';
  const type = PET_LOG_TYPES.has(source) || source.startsWith('interact_') ? 'pet_stage'
    : source === 'task' ? 'xp' : source;
  const amount = Number(item.xp_change ?? item.xp_amount ?? 0);
  const xp = Number.isFinite(amount) ? amount : 0;
  const createdAt = typeof item.created_at === 'string' && /^\d+$/.test(item.created_at)
    ? Number(item.created_at) : item.created_at;
  const timestamp = new Date(createdAt ?? NaN).getTime();
  return {
    ...item,
    id: item.id || item._id,
    log_type: type,
    content: item.reason || item.content || '',
    xp_amount: xp,
    xpText: xp > 0 ? '+' + xp : String(xp),
    createdDate: Number.isFinite(timestamp) ? today(timestamp) : '',
  };
}

Page({
  data: {
    logs: [], filteredLogs: [], loading: true, loadError: '',
    filter: "all",
    stats: { totalXp: 0, levelUps: 0, achievements: 0 },
  },

  onShow() {
    return this.loadLogs();
  },

  async loadLogs() {
    const { currentOpenid: owner, userInfo: session } = getApp().globalData;
    const request = this._logRequest = {};
    const isCurrent = () => {
      const { currentOpenid, userInfo } = getApp().globalData;
      return this._logRequest === request && currentOpenid === owner && userInfo === session;
    };
    this.setData({ loading: true, loadError: '', logs: [], filteredLogs: [] });
    try {
      const res = await cloudApi.growthLogs();
      if (!isCurrent()) return;
      const rows = Array.isArray(res) ? res : res?.data;
      if (!Array.isArray(rows)) throw new Error('未收到有效的成长记录');
      const logs = rows.map(displayLog);

      // 计算统计数据
      const stats = {
        totalXp: logs.reduce((sum, l) => sum + (l.xp_amount || 0), 0),
        levelUps: logs.filter(l => l.log_type === 'level_up').length,
        achievements: logs.filter(l => l.log_type === 'achievement').length,
      };

      this.setData({ logs, stats, loading: false });
      this.applyFilter();
    } catch (err) {
      if (!isCurrent()) return;
      const message = typeof err === 'string' ? err : err?.message;
      this.setData({ loading: false, loadError: message || '成长记录暂时加载失败' });
    }
  },

  applyFilter() {
    let filtered = [...this.data.logs];
    if (this.data.filter !== 'all') {
      filtered = filtered.filter(l => l.log_type === this.data.filter || (this.data.filter === 'xp' && l.xp_amount !== 0));
    }
    this.setData({ filteredLogs: filtered });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, () => this.applyFilter());
  },

  onPullDownRefresh() {
    this.loadLogs().then(() => wx.stopPullDownRefresh());
  },
});
