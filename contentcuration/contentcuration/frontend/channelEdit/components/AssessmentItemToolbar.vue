<template>

  <VLayout justify-end>
    <VFlex
      v-for="(action, idx) in iconActions"
      :key="idx"
      class="toolbar-item"
    >
      <VTooltip top>
        <template slot="activator" slot-scope="{ on }">
          <VBtn
            icon
            :disabled="!isIconClickable(action)"
            :data-test="`toolbarIcon-${action}`"
            v-on="on"
            @click="clickItem(action)"
          >
            <VIcon :color="iconColor(action)">
              {{ config[action].icon }}
            </VIcon>
          </VBtn>
        </template>
        <span>{{ config[action].label }}</span>
      </VTooltip>
    </VFlex>

    <VFlex
      v-if="displayMenu"
      class="toolbar-item"
    >
      <VMenu
        bottom
        left
      >
        <template slot="activator" slot-scope="{ on }">
          <VBtn
            icon
            v-on="on"
          >
            <VIcon color="grey darken-1">
              more_vert
            </VIcon>
          </VBtn>
        </template>

        <VList
          v-for="(action, idx) in menuActions"
          :key="idx"
        >
          <VListTile
            :data-test="`toolbarMenuItem-${action}`"
            @click="clickItem(action)"
          >
            <VListTileTitle>{{ config[action].label }}</VListTileTitle>
          </VListTile>
        </VList>
      </VMenu>
    </VFlex>
  </VLayout>

</template>

<script>

  import { AssessmentItemToolbarActions } from '../constants';

  const configItemToAction = item => {
    if (Array.isArray(item)) {
      return item[0];
    } else {
      return item;
    }
  };

  const isConfigItemCollapsible = item => {
    return Array.isArray(item) && item.length === 2 && item[1].collapse === true;
  };

  export default {
    name: 'AssessmentItemToolbar',
    props: {
      /*
        An array of AssessmentItemToolbarActions
        [
          AssessmentItemToolbarActions.ADD_ITEM_ABOVE,
          AssessmentItemToolbarActions.DELETE_ITEM
        ]

        If you need collapse control, you an add a configuration
        object to an item:

        [
          [ AssessmentItemToolbarActions.ADD_ITEM_BELOW, { collapse: true }],
          AssessmentItemToolbarActions.DELETE_ITEM,
          [ AssessmentItemToolbarActions.DELETE_ITEM, { collapse: false }]
        ]
        (last two items are equivalent)

        `collapse` - if `true`, the action icon will be moved to menu items
                     in collapsed mode, otherwise it'll stay in icons section
                     of a toolbar

        Note:
          ADD_ITEM_ABOVE and ADD_ITEM_BELOW action icons are currently
          not supported. These actions can be rendered only within menu.
      */
      iconActionsConfig: {
        type: Array,
      },
      displayMenu: {
        type: Boolean,
        default: false,
      },
      /*
        Action items to be rendered in menu if menu displayed.
        Example:
        [
          AssessmentItemToolbarActions.ADD_ITEM_ABOVE,
          AssessmentItemToolbarActions.ADD_ITEM_BELOW,
          AssessmentItemToolbarActions.DELETE_ITEM
        ]
      */
      menuActionsConfig: {
        type: Array,
      },
      collapse: {
        type: Boolean,
        default: false,
      },
      canMoveUp: {
        type: Boolean,
        default: true,
      },
      canMoveDown: {
        type: Boolean,
        default: true,
      },
      itemLabel: {
        type: String,
        default: 'item',
      },
    },
    computed: {
      config() {
        return {
          [AssessmentItemToolbarActions.EDIT_ITEM]: {
            icon: 'edit',
            label: this.$tr('toolbarLabelEdit'),
          },
          [AssessmentItemToolbarActions.MOVE_ITEM_UP]: {
            icon: 'keyboard_arrow_up',
            label: this.$tr('toolbarLabelMoveUp'),
          },
          [AssessmentItemToolbarActions.MOVE_ITEM_DOWN]: {
            icon: 'keyboard_arrow_down',
            label: this.$tr('toolbarLabelMoveDown'),
          },
          [AssessmentItemToolbarActions.DELETE_ITEM]: {
            icon: 'close',
            label: this.$tr('toolbarLabelDelete'),
          },
          [AssessmentItemToolbarActions.ADD_ITEM_ABOVE]: {
            icon: null,
            label: this.$tr('toolbarLabelAddAbove', { itemLabel: this.itemLabel }),
          },
          [AssessmentItemToolbarActions.ADD_ITEM_BELOW]: {
            icon: null,
            label: this.$tr('toolbarLabelAddBelow', { itemLabel: this.itemLabel }),
          },
        };
      },
      // return an array of AssessmentItemToolbarActions
      // to be rendered as icons
      iconActions() {
        if (!this.iconActionsConfig) {
          return [];
        }

        // collapse configuration of items can be ignored outside of collapse mode
        if (!this.collapse) {
          return this.iconActionsConfig.map(item => configItemToAction(item));
        }

        return this.iconActionsConfig
          .filter(item => !isConfigItemCollapsible(item))
          .map(item => configItemToAction(item));
      },
      // return an array of AssessmentItemToolbarActions
      // to be rendered as menu items
      menuActions() {
        if (!this.collapse) {
          return this.menuActionsConfig;
        }

        let collapsedIconActions = [];

        if (this.iconActionsConfig) {
          collapsedIconActions = this.iconActionsConfig
            .filter(item => isConfigItemCollapsible(item))
            .map(item => configItemToAction(item));

          if (!this.canMoveUp) {
            collapsedIconActions = collapsedIconActions.filter(
              action => action !== AssessmentItemToolbarActions.MOVE_ITEM_UP
            );
          }

          if (!this.canMoveDown) {
            collapsedIconActions = collapsedIconActions.filter(
              action => action !== AssessmentItemToolbarActions.MOVE_ITEM_DOWN
            );
          }
        }

        return [...collapsedIconActions, ...this.menuActionsConfig];
      },
    },
    methods: {
      isIconClickable(action) {
        if (action === AssessmentItemToolbarActions.MOVE_ITEM_UP && !this.canMoveUp) {
          return false;
        }

        if (action === AssessmentItemToolbarActions.MOVE_ITEM_DOWN && !this.canMoveDown) {
          return false;
        }

        return true;
      },
      iconColor(action) {
        switch (action) {
          case AssessmentItemToolbarActions.MOVE_ITEM_UP:
            if (this.canMoveUp) {
              return 'grey darken-1';
            } else {
              return 'grey lighten-2';
            }

          case AssessmentItemToolbarActions.MOVE_ITEM_DOWN:
            if (this.canMoveDown) {
              return 'grey darken-1';
            } else {
              return 'grey lighten-2';
            }

          default:
            return 'grey darken-1';
        }
      },
      clickItem(action) {
        this.$emit('click', action);
      },
    },
    $trs: {
      toolbarLabelEdit: 'Edit',
      toolbarLabelMoveUp: 'Move up',
      toolbarLabelMoveDown: 'Move down',
      toolbarLabelDelete: 'Delete',
      toolbarLabelAddAbove: 'Add {itemLabel} above',
      toolbarLabelAddBelow: 'Add {itemLabel} below',
    },
  };

</script>

<style lang="less" scoped>

  .toolbar-item {
    max-width: 50px;
  }

</style>
