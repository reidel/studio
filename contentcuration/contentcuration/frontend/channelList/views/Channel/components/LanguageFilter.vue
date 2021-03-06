<template>

  <VAutocomplete
    v-model="languages"
    :items="availableLanguages"
    :label="$tr('languageLabel')"
    color="primary"
    item-value="id"
    :item-text="languageSearchValue"
    autoSelectFirst
    :no-data-text="$tr('noMatchingLanguageText')"
    outline
    multiple
    clearable
    :search-input.sync="languageInput"
    v-bind="$attrs"
    @change="languageInput=''"
  >
    <template #selection="{item}">
      <VTooltip bottom>
        <template #activator="{on}">
          <VChip class="ma-1" v-on="on">
            <div class="text-truncate">
              {{ item.name }}
            </div>
          </VChip>
        </template>
        <span>{{ item.name }}</span>
      </VTooltip>
    </template>
    <template #item="{item}">
      <Checkbox :key="item.id" :input-value="value" :value="item.id" class="mt-0">
        <template #label>
          <VTooltip bottom>
            <template v-slot:activator="{ on }">
              <div class="text-truncate" style="width: 250px;" v-on="on">
                {{ languageText(item) }}
              </div>
            </template>
            <span>{{ languageText(item) }}</span>
          </VTooltip>
        </template>
      </Checkbox>
    </template>
  </VAutocomplete>

</template>


<script>

  import Checkbox from 'shared/views/form/Checkbox';
  import LanguagesMap, { LanguagesList } from 'shared/leUtils/Languages';

  const publicLanguages = Object.entries(window.publicLanguages || {}).map(([langId, count]) => {
    const baseLanguage = LanguagesMap.get(langId);
    return {
      id: langId,
      name: baseLanguage.native_name,
      count: count,
      related_names: LanguagesList.filter(lang => lang.lang_code === langId)
        .map(lang => [lang.native_name, lang.id, lang.readable_name])
        .flat(),
    };
  });

  export default {
    name: 'LanguageFilter',
    components: {
      Checkbox,
    },
    props: {
      value: {
        type: Array,
        default() {
          return [];
        },
      },
    },
    data() {
      return {
        languageInput: '',
        availableLanguages: publicLanguages,
      };
    },
    computed: {
      languages: {
        get() {
          return this.value;
        },
        set(value) {
          this.$emit('input', value.filter(Boolean));
        },
      },
    },
    methods: {
      languageSearchValue(item) {
        return item.name + (item.related_names || []).join('') + item.id;
      },
      languageText(item) {
        return this.$tr('languageText', { language: item.name, code: item.id, count: item.count });
      },
    },
    $trs: {
      languageLabel: 'Languages',
      languageText: '{language} {code} ({count})',
      noMatchingLanguageText: 'No languages found',
    },
  };

</script>

<style lang="less" scoped>

  // Need to set otherwise chips will exceed width of selection box

  /deep/ .v-select__selections {
    width: calc(100% - 48px);
  }
  .v-chip,
  /deep/ .v-chip__content,
  .text-truncate {
    max-width: 100%;
  }

</style>
