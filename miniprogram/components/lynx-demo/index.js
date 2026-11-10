const { themes } = require('../../utils/petPortrait')

Component({
  properties: {
    active: { type: Boolean, value: false },
  },

  data: { themes, selected: themes[0] },

  methods: {
    selectTheme(event) {
      const selected = themes.find(theme => theme.id === event.currentTarget.dataset.id)
      if (selected && selected.id !== this.data.selected.id) this.setData({ selected })
    },
  },
})
