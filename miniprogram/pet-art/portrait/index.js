const artRoot = '/pet-art/portrait/art/'
const rigs = require('./rigs')
const emptyRig = { body: '', blink: '', tail: '', ornament: '' }

Component({
  properties: {
    active: {
      type: Boolean,
      value: false,
      observer(active) {
        if (!active) this.stopReaction()
      },
    },
    species: { type: String, value: 'lynx' },
    still: { type: Boolean, value: false },
    form: { type: String, value: 'adult' },
    label: { type: String, value: '猞猁' },
    theme: {
      type: String,
      value: 'base',
      observer() {
        this.stopReaction()
      },
    },
    colorStyle: String,
    fallbackEmoji: { type: String, value: '🦊' },
  },

  observers: {
    'species, form'(species, form) {
      this.stopReaction()
      const layout = rigs[species] && rigs[species][form]
      this.setData({ layout: layout || emptyRig, motionError: false, stillError: false })
    },
  },

  data: {
    artRoot,
    layout: emptyRig,
    reacting: false,
    motionError: false,
    stillError: false,
    ornamentErrors: {},
  },

  lifetimes: {
    detached() {
      clearTimeout(this.reactionTimer)
    },
  },

  methods: {
    react() {
      if (this.data.still || !this.data.active || this.data.reacting || this.data.motionError) return
      this.setData({ reacting: true })
      this.reactionTimer = setTimeout(() => this.stopReaction(), 1050)
    },

    stopReaction() {
      clearTimeout(this.reactionTimer)
      if (this.data.reacting) this.setData({ reacting: false })
    },

    onMotionError(event) {
      if (event.currentTarget.dataset.key !== this.data.species + '/' + this.data.form) return
      this.stopReaction()
      this.setData({ motionError: true })
    },

    onStillError(event) {
      if (event.currentTarget.dataset.key === this.data.species + '/' + this.data.form) {
        this.setData({ stillError: true })
      }
    },

    onOrnamentError(event) {
      const id = event.currentTarget.dataset.id
      this.setData({ ['ornamentErrors.' + id]: true })
    },
  },
})
