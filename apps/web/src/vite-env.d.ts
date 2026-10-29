/// <reference types="vite/client" />

/**
 * 构建期注入的版本号，来源是 apps/web/package.json 的 version。
 * 定义在 vite.config.ts 的 define 里：发版只改 package.json 一处。
 */
declare const __APP_VERSION__: string
