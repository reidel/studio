<template>

  <div class="bottom-bar pa-2">
    <slot></slot>
  </div>

</template>

<style lang="less" scoped>

  .bottom-bar {
    position: fixed;
    bottom: 0;
    z-index: 3;
    width: 100%;
    height: 72px;
    background-color: #ffffff;
    border-top: 1px solid #dddddd;
  }

</style>
