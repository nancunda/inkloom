import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from './index.js'

describe('workspace 骨架', () => {
  it('core 包可导入自身', () => {
    expect(PACKAGE_NAME).toBe('@inkloom/core')
  })
})
