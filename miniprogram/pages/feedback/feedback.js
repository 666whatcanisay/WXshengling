const cloudApi = require("../../utils/cloudApi");

Page({
  data: {
    feedbackTypes: ['功能建议', 'Bug反馈', '内容问题', '其他'],
    selectedType: '功能建议',
    title: '',
    description: '',
    contact: '',
    submitting: false,
  },

  onLoad() {
    this.resetForm();
  },

  resetForm() {
    this.setData({
      selectedType: '功能建议',
      title: '',
      description: '',
      contact: '',
      submitting: false,
    });
  },

  selectType(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ selectedType: type });
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },

  onDescriptionInput(e) {
    this.setData({ description: e.detail.value });
  },

  onContactInput(e) {
    this.setData({ contact: e.detail.value });
  },

  async submitFeedback() {
    if (!this.data.title.trim()) {
      wx.showToast({ title: '请输入标题', icon: 'none' });
      return;
    }
    if (!this.data.description.trim()) {
      wx.showToast({ title: '请输入详细描述', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      await cloudApi.submitFeedback({
        type: this.data.selectedType,
        title: this.data.title.trim(),
        description: this.data.description.trim(),
        contact: this.data.contact.trim(),
      });
      wx.showToast({
        title: '提交成功，感谢你的反馈！',
        icon: 'success',
        duration: 2000,
      });
      this.resetForm();
    } catch (err) {
      console.error('[Feedback] 提交失败:', err);
      wx.showToast({ title: '提交失败，请稍后重试', icon: 'error' });
      this.setData({ submitting: false });
    }
  },
});
