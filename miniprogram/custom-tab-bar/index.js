Component({
  data: {
    selected: 0,
    color: "#7A8A8A",
    selectedColor: "#7ED6A7",
    list: [
      { pagePath: "/pages/home/home", text: "首页", icon: "home", selectedIcon: "home-fill" },
      { pagePath: "/pages/goals/goals", text: "目标", icon: "target", selectedIcon: "target-fill" },
      { pagePath: "/pages/pets/pets", text: "宠物", icon: "pet-center", selectedIcon: "pet-center", isCenter: true },
      { pagePath: "/pages/ai/ai", text: "AI", icon: "robot", selectedIcon: "robot-fill" },
      { pagePath: "/pages/mine/mine", text: "我的", icon: "user", selectedIcon: "user-fill" },
    ],
  },

  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = data.path
      if (data.isCenter) return
      wx.switchTab({ url })
    },

    goCenter() {
      wx.switchTab({ url: "/pages/pets/pets" })
    },
  },
})
