import { defineConfig } from 'vitest/config'

// Vitest 5 移除了 vitest.workspace.ts 与 defineWorkspace，
// 多 project 配置统一走 test.projects（Vitest 3+ 新写法）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/**/src/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
})
