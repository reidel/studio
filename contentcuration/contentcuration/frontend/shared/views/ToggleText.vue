<template>

  <div class="toggle-text">
    <div>{{ trimmedText.substring(0, splitIndex) }}</div>
    <div class="overflow" :class="{expanded: expanded}">
      {{ overflowText }}
    </div>
    <p>
      <a v-if="overflowText" class="toggler" @click.stop="toggle">
        {{ togglerText }}
      </a>
    </p>
  </div>

</template>


<script>

  export default {
    name: 'ToggleText',
    props: {
      text: {
        type: String,
        default: '',
      },
      splitAt: {
        type: Number,
        default: 100,
      },
    },
    data() {
      return {
        expanded: false,
      };
    },
    computed: {
      trimmedText() {
        return this.text.trim();
      },
      splitIndex() {
        // Find where to split the index without breaking words
        // If no spaces are found after the bufferRange, split the text anyways
        let bufferRange = Math.ceil(this.splitAt / 4);
        let start = this.splitAt - bufferRange;
        let end = this.splitAt + bufferRange;
        let index = this.trimmedText.substring(start, end).search(' ');
        let newSplitIndex = index + start;

        // If there are only a few characters left, just return the whole text...
        // Otherwise, return new index.
        return this.trimmedText.length - newSplitIndex <= bufferRange
          ? this.trimmedText.length
          : newSplitIndex;
      },
      overflowText() {
        return this.trimmedText.substring(this.splitIndex, this.trimmedText.length);
      },
      togglerText() {
        return this.expanded ? this.$tr('less') : this.$tr('more');
      },
    },
    methods: {
      toggle() {
        this.expanded = !this.expanded;
      },
    },
    $trs: {
      more: '... More',
      less: 'Less',
    },
  };

</script>


<style lang="less" scoped>

  .toggle-text {
    div {
      .wordwrap;

      display: inline;
      margin: 0;
    }
    .overflow {
      display: block;
      max-height: 0;
      overflow-y: hidden;
      transition: max-height 0.4s linear;
      &.expanded {
        max-height: 100vh;
      }
    }
    .toggler {
      font-weight: bold;
      color: var(--v-grey-darken3);
      text-decoration: none;
      &:hover {
        color: var(--v-blue-darken-1);
      }
    }
  }

</style>
