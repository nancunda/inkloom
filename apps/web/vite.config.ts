import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // ★ 用 127.0.0.1 不用 localhost：API 只绑 IPv4，而 localhost 在
    //   Windows 上会先解析成 ::1，代理就会连不上。
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
})
