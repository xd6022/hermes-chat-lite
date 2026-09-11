import { createApp } from 'vue'
import './style.css'
import 'highlight.js/styles/github.css' // 浅色代码配色；深色见 style.css 的 .dark .hljs-*
import { initTheme } from './lib/theme'
import App from './App.vue'

// 挂载前定主题：首帧就是对的颜色（index.html 的内联脚本已加好 class，这里只同步 ref）
initTheme()

createApp(App).mount('#app')
