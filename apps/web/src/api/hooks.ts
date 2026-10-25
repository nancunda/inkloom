import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, post } from './client'
import type {
  BlueprintLite,
  Book,
  ChapterDetail,
  DiffResult,
  FinalizeResult,
  GenerateResult,
  ProposeResult,
  SceneDetail,
} from './types'

export function useBook() {
  return useQuery({ queryKey: ['book'], queryFn: () => api<Book>('/book') })
}

export function useChapter(n: number) {
  return useQuery({
    queryKey: ['chapter', n],
    queryFn: () => api<ChapterDetail>(`/chapters/${n}`),
    enabled: n > 0,
  })
}

export function useScene(chapterNo: number, sceneNo: number, version: number) {
  return useQuery({
    queryKey: ['scene', chapterNo, sceneNo, version],
    queryFn: () => api<SceneDetail>(`/chapters/${chapterNo}/scenes/${sceneNo}?version=${version}`),
    enabled: chapterNo > 0 && sceneNo > 0 && version > 0,
  })
}

export function useDiff(chapterNo: number, sceneNo: number, from: number, to: number) {
  return useQuery({
    queryKey: ['diff', chapterNo, sceneNo, from, to],
    queryFn: () =>
      api<DiffResult>(`/chapters/${chapterNo}/scenes/${sceneNo}/diff?from=${from}&to=${to}`),
    enabled: from > 0 && to > 0 && from !== to,
  })
}

export function useBlueprints() {
  return useQuery({
    queryKey: ['blueprints'],
    queryFn: () => api<{ chapters: BlueprintLite[] }>('/blueprints'),
  })
}

/**
 * 所有写操作都会 invalidate 章节缓存。
 *
 * ★ 不 invalidate 的话界面还是旧的——这是最容易犯也最难查的 bug
 *   （"我点接受了，但它还是灰的"）。
 */
function useInvalidateChapter() {
  const qc = useQueryClient()
  return (chapterNo: number) => {
    void qc.invalidateQueries({ queryKey: ['chapter', chapterNo] })
    void qc.invalidateQueries({ queryKey: ['book'] })
    void qc.invalidateQueries({ queryKey: ['diff', chapterNo] })
  }
}

export function useGenerate() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number; guidance?: string }) =>
      post<GenerateResult>(`/chapters/${v.chapterNo}/generate`, {
        ...(v.guidance === undefined ? {} : { guidance: v.guidance }),
      }),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useAcceptScene() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number; sceneNo: number; version: number }) =>
      post(`/chapters/${v.chapterNo}/scenes/${v.sceneNo}/accept`, { version: v.version }),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useRejectScene() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number; sceneNo: number; version: number }) =>
      post(`/chapters/${v.chapterNo}/scenes/${v.sceneNo}/reject`, { version: v.version }),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useEditScene() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: {
      chapterNo: number
      sceneNo: number
      version: number
      segId: string
      newText: string
    }) =>
      post<{ newVersion: number; relPath: string }>(
        `/chapters/${v.chapterNo}/scenes/${v.sceneNo}/edit`,
        { version: v.version, segId: v.segId, newText: v.newText },
      ),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useFinalize() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number }) =>
      post<FinalizeResult>(`/chapters/${v.chapterNo}/finalize`, {}),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useUnfinalize() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number }) => post(`/chapters/${v.chapterNo}/unfinalize`, {}),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function usePropose() {
  return useMutation({
    mutationFn: (v: { chapterNo: number }) =>
      post<ProposeResult>(`/chapters/${v.chapterNo}/propose`, {}),
  })
}

export function useApplyProposals() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: { chapterNo: number; acceptIds: string[] }) =>
      post<{ applied: number; skipped: number }>(`/chapters/${v.chapterNo}/proposals/apply`, {
        acceptIds: v.acceptIds,
      }),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}
