<template>

  <VDialog v-model="show" width="600" max-width="100vw" persistent>
    <VCard class="px-2 py-3">
      <VCardTitle class="pb-0 title font-weight-bold">
        Send email
      </VCardTitle>
      <VForm ref="form" lazy-validation @submit.prevent="emailHandler">
        <VCardText class="pt-3 pb-4">
          <VLayout align-top row class="mb-2">
            <VFlex shrink class="pa-2">
              From:
            </VFlex>
            <VFlex>
              <VChip small>
                {{ senderEmail }}
              </VChip>
            </VFlex>
          </VLayout>
          <VLayout align-top row>
            <VFlex shrink class="pa-2">
              To:
            </VFlex>
            <VFlex>
              <ExpandableList :items="users" :max="4" inline :delimit="false">
                <template #item="{item}">
                  <VTooltip bottom>
                    <template v-slot:activator="{ on }">
                      <VChip
                        small
                        :close="selected.length > 1"
                        data-test="remove"
                        v-on="on"
                        @input="remove(item.id)"
                      >
                        <div style="max-width: 72px;">
                          <div class="text-truncate">
                            {{ item.name }}
                          </div>
                        </div>
                      </VChip>
                    </template>
                    <span>{{ item.name }} &lt;{{ item.email }}&gt;</span>
                  </VTooltip>
                </template>
              </ExpandableList>
            </VFlex>
          </VLayout>
          <VTextField
            v-model="subject"
            class="mt-4"
            outline
            label="Subject line"
            required
            :rules="requiredRules"
          />
          <div class="grey--text caption">
            Add placeholder to message
          </div>
          <div class="mb-1">
            <VBtn
              v-for="placeholder in placeholders"
              :key="`placeholder-${placeholder.label}`"
              small
              round
              depressed
              color="grey lighten-4"
              style="text-transform: none;"
              @click="addPlaceholder(placeholder.placeholder)"
            >
              {{ placeholder.label }}
            </VBtn>
          </div>
          <VTextarea
            v-model="message"
            outline
            auto-grow
            label="Email body"
            required
            :rules="requiredRules"
          />
        </VCardText>
        <VCardActions data-test="buttons">
          <VSpacer />
          <VBtn data-test="cancel" flat @click="cancel">
            Cancel
          </VBtn>
          <VBtn data-test="send" color="primary" type="submit">
            Send email
          </VBtn>
        </VCardActions>
      </VForm>
      <ConfirmationDialog
        v-model="showWarning"
        title="Draft in progress"
        text="Draft will be lost upon exiting this editor. Are you sure you want to continue?"
        confirmButtonText="Discard draft"
        cancelButtonText="Keep open"
        data-test="confirm"
        @confirm="close"
      />
    </VCard>
  </VDialog>

</template>


<script>

  import { mapActions, mapGetters } from 'vuex';
  import ConfirmationDialog from '../../components/ConfirmationDialog';
  import ExpandableList from 'shared/views/ExpandableList';

  export default {
    name: 'EmailUsersDialog',
    components: {
      ExpandableList,
      ConfirmationDialog,
    },
    props: {
      value: {
        type: Boolean,
        default: false,
      },
      userIds: {
        type: Array,
        required: true,
        validator(value) {
          return value.every(v => typeof v === 'string');
        },
      },
    },
    data() {
      return {
        subject: '',
        message: '',
        showWarning: false,
        selected: [],
      };
    },
    computed: {
      ...mapGetters('userAdmin', ['getUsers']),
      show: {
        get() {
          return this.value;
        },
        set(value) {
          this.$emit('input', value);
        },
      },
      users() {
        return this.getUsers(this.selected);
      },
      requiredRules() {
        return [v => Boolean(v.trim()) || 'Field is required'];
      },
      senderEmail() {
        return window.senderEmail;
      },
      placeholders() {
        return [
          {
            label: 'First name',
            placeholder: '{first_name}',
          },
          {
            label: 'Last name',
            placeholder: '{last_name}',
          },
          {
            label: 'Email',
            placeholder: '{email}',
          },
          {
            label: 'Date',
            placeholder: '{current_date}',
          },
          {
            label: 'Time',
            placeholder: '{current_time}',
          },
        ];
      },
    },
    watch: {
      value(value) {
        if (value) {
          this.selected = this.userIds;
        }
      },
    },
    methods: {
      ...mapActions('userAdmin', ['sendEmail']),
      cancel() {
        if (this.subject.trim() || this.message.trim()) {
          this.showWarning = true;
        } else {
          this.close();
        }
      },
      close() {
        this.show = false;
        this.subject = '';
        this.message = '';
        this.$refs.form.resetValidation();
      },
      emailHandler() {
        if (this.$refs.form.validate()) {
          this.sendEmail({
            emails: this.users.map(u => u.email),
            subject: this.subject,
            message: this.message,
          })
            .then(() => {
              this.close();
              this.$store.dispatch('showSnackbarSimple', 'Email sent');
            })
            .catch(() => {
              this.$store.dispatch('showSnackbarSimple', 'Email failed to send');
            });
        }
      },
      addPlaceholder(placeholder) {
        this.message += ` ${placeholder}`;
      },
      remove(id) {
        this.selected = this.selected.filter(u => u !== id);
      },
    },
  };

</script>


<style lang="less" scoped>

  /deep/ .v-chip__close {
    padding-top: 4px;
  }

</style>
