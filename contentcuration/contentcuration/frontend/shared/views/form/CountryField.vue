<template>

  <VAutocomplete
    v-model="locations"
    :items="options"
    :label="label || $tr('locationLabel')"
    :multiple="multiple"
    :outline="outline"
    item-value="id"
    item-text="name"
    :required="required"
    :rules="rules"
    :search-input.sync="searchInput"
    :no-data-text="$tr('noCountriesFound')"
    :chips="multiple"
    clearable
    @change="searchInput=''"
  />

</template>


<script>

  var countries = require('i18n-iso-countries');
  countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
  countries.registerLocale(require('i18n-iso-countries/langs/es.json'));
  countries.registerLocale(require('i18n-iso-countries/langs/ar.json'));

  export default {
    name: 'CountryField',
    props: {
      value: {
        type: [String, Array],
        default() {
          return [];
        },
      },
      required: {
        type: Boolean,
        default: false,
      },
      outline: {
        type: Boolean,
        default: true,
      },
      multiple: {
        type: Boolean,
        default: true,
      },
      label: {
        type: String,
        required: false,
      },
    },
    data() {
      return {
        searchInput: '',
      };
    },
    computed: {
      locations: {
        get() {
          return this.value;
        },
        set(value) {
          this.$emit('input', value);
        },
      },
      options() {
        return Object.entries(countries.getNames('en')).map(country => {
          return {
            id: country[1],
            name: countries.getName(country[0], window.languageCode),
          };
        });
      },
      rules() {
        return [v => (!this.required || v.length ? true : this.$tr('locationRequiredMessage'))];
      },
    },
    $trs: {
      locationLabel: 'Select all that apply',
      locationRequiredMessage: 'Field is required',
      noCountriesFound: 'No countries found',
    },
  };

</script>


<style lang="less" scoped>

  /deep/ .v-select__selections {
    width: calc(100% - 48px); // Account for clear icon
    min-height: 0 !important;
  }

  .v-autocomplete {
    max-width: 500px;
  }

</style>
