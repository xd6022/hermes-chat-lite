<script setup lang="ts">
/**
 * P0 自检页（临时）。P1 会用真正的三段式布局替换。
 * 目的：证明「vite 起得来 + 反代注入 key + getSessions 拿到真实数据」这条链路通了。
 */
import { onMounted, ref } from 'vue'
import { getSessions, health } from './api/hermes'

const status = ref('检查中…')
const version = ref('')
const count = ref<number | null>(null)
const first = ref('')
const err = ref('')

onMounted(async () => {
  try {
    const h = await health()
    status.value = h.status === 'ok' ? '已连接' : h.status
    version.value = h.version ?? ''
    const s = await getSessions(5)
    count.value = s.data.length
    first.value = s.data[0]?.title ?? '(无标题)'
    console.log('[P0 自检] sessions =', s.data)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <div class="mx-auto max-w-chat p-6">
    <h1 class="mb-4 text-xl font-semibold">Hermes Chat Lite · P0 自检</h1>
    <ul class="space-y-2 text-sm">
      <li>连接状态：<b>{{ status }}</b> <span v-if="version">（Hermes v{{ version }}）</span></li>
      <li>最近会话数：<b>{{ count ?? '—' }}</b></li>
      <li>最新会话标题：{{ first || '—' }}</li>
      <li v-if="err" class="text-red-600">错误：{{ err }}</li>
    </ul>
  </div>
</template>
