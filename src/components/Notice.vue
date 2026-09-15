<script setup lang="ts">
/**
 * 顶部提示条（v2.12）：**会自动消失**的轻提示。
 *
 * 第一个用户是"地址里的会话不存在"（无效/已删 id）：那时我们把人送回欢迎页，
 * 得让他知道为什么 —— 但这条信息用完就没用了，挂在顶上不走反而碍事。
 *
 * 口径（用户 2026-09-15 定）：**5 秒自动消失；左键点一下就立刻消失**。
 * 因此这里不做"关闭按钮"（点哪儿都关，按钮反而多一个要瞄准的目标），
 * 也不做"仅红字常驻"（那是 bootError 横幅的职责，管的是真错误）。
 */
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(defineProps<{ text: string; ms?: number }>(), { ms: 5000 })
const emit = defineEmits<{ (e: 'close'): void }>()

let timer: ReturnType<typeof setTimeout> | null = null

function close(): void {
  if (timer) clearTimeout(timer)
  timer = null
  emit('close')
}

onMounted(() => {
  timer = setTimeout(close, Math.max(1000, props.ms))
})

// 组件先被卸载（例如又跳了一次路由）时要清掉定时器，别让回调打在已卸载的组件上
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <div
    data-testid="notice"
    class="fixed left-1/2 top-14 z-50 -translate-x-1/2 cursor-pointer select-none rounded-lg bg-gray-900/90 px-3 py-2 text-sm text-white shadow-lg dark:bg-gray-100/95 dark:text-gray-900"
    role="status"
    @click="close()"
  >
    {{ text }}
  </div>
</template>
