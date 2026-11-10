const cloudApi = require("../../utils/cloudApi");

Page({
  data: {
    weeklyReport: null,
    loading: true,
    loadError: false,
  },

  onLoad() {
    this.loadReport();
  },

  async loadReport() {
    const request = this._reportRequest = (this._reportRequest || 0) + 1;
    this.setData({ loading: true, loadError: false });
    try {
      const report = await cloudApi.growthReport();
      if (!report || !Array.isArray(report.moods)) throw new Error('报告数据不可用');
      if (request === this._reportRequest) this.setData({ weeklyReport: report });
    } catch (err) {
      if (request === this._reportRequest) this.setData({ loadError: true });
    } finally {
      if (request === this._reportRequest) this.setData({ loading: false });
    }
  },

  onRefresh() { return this.loadReport(); },

  onPullDownRefresh() {
    this.loadReport().then(() => wx.stopPullDownRefresh());
  },
});
