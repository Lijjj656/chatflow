<script setup>
import ToastHost from './components/ToastHost.vue';
</script>

<template>
  <router-view v-slot="{ Component }">
    <transition name="fade" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>

  <ToastHost />
</template>

<style>
/* 全局挂载点占满视口；页面自己决定内部怎么分栏 */
#app {
  height: 100%;
  overflow: hidden;
}
</style>
