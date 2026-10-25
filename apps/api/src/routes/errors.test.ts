import { InkloomError } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { httpStatusFor, toApiError } from './errors.js'

describe('httpStatusFor', () => {
  it('★ 输入错误 → 400', () => {
    expect(httpStatusFor('INVALID_INPUT')).toBe(400)
  })

  it('★ 不存在 → 404', () => {
    expect(httpStatusFor('NOT_FOUND')).toBe(404)
  })

  it('★ 冲突 → 409（file changed / concurrent write）', () => {
    expect(httpStatusFor('CONFLICT')).toBe(409)
    expect(httpStatusFor('CAS_MISMATCH')).toBe(409)
  })

  it('★ 鉴权 → 401', () => {
    expect(httpStatusFor('AUTH')).toBe(401)
  })

  it('未知码 → 500（不静默当成功）', () => {
    expect(httpStatusFor('WHATEVER')).toBe(500)
  })
})

describe('toApiError', () => {
  it('★ InkloomError → 带 code 的结构化错误', () => {
    const r = toApiError(new InkloomError('NOT_FOUND', '没有这一章'))
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: '没有这一章' } })
  })

  it('★ 普通 Error → 500 且不泄漏堆栈', () => {
    const r = toApiError(new Error('数据库炸了'))
    expect(r.status).toBe(500)
    expect(r.body.error.code).toBe('INTERNAL')
    expect(r.body.error.message).toBe('数据库炸了')
    expect(JSON.stringify(r.body)).not.toContain('at ')
  })

  it('非 Error 也能处理', () => {
    expect(toApiError('boom').body.error.code).toBe('INTERNAL')
    expect(toApiError('boom').body.error.message).toBe('boom')
  })
})
