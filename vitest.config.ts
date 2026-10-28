import { defineConfig } from 'vitest/config'

// Vitest 5 移除了 vitest.workspace.ts 与 defineWorkspace，
// 多 project 配置统一走 test.projects（Vitest 3+ 新写法）。
export default defineConfig({
  test: {
    // spec §8.1 / P0 DoD：core 覆盖率 >80%。
    // shared 也纳入：本项目把"领域模型"放在 shared，它就是 spec 说的 core 模型层。
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // 纯类型声明文件编译后为空，v8 会算成 0% 并拉低总覆盖率。
      // 只排除“只有 export type / export interface”的文件，带逻辑的 types.ts 不在此列。
      exclude: ['**/*.test.ts', '**/index.ts', '**/revision/types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'apps/web/src/**/*.test.ts',
          ],
          // ★ project 级 exclude 会**完全覆盖**默认值（默认包含 node_modules/dist），
          //   所以必须把默认忽略项也写一遍，否则会把依赖包自带的测试一并跑掉。
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/**/src/**/*.int.test.ts', 'apps/**/src/**/*.http.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
})
