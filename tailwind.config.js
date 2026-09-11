/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  // 白天/黑夜靠 <html class="dark"> 切换（不用 media 查询）：
  // 用户手动选择必须能覆盖系统偏好，否则"跟随系统"就没法与手动切换共存。
  darkMode: 'class',
  theme: {
    extend: {
      maxWidth: {
        chat: '768px',
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"PingFang SC"',
          '"Hiragino Sans GB"', '"Microsoft YaHei"', 'sans-serif',
        ],
        mono: ['"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
