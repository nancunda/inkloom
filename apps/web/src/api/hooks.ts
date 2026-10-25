import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, post } from './client'
import type {
  BlueprintLite,
  Book,
  ChapterDetail,
  DiffResult,
  FinalizeResult,
  GenerateJob,
  HealthReport,
  ProposeResult,
  RelationGraphData,
  SceneDetail,
  SearchResult,
  ThreadsData,
  WorldData,
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

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<{ jobs: GenerateJob[] }>('/jobs'),
    // 有运行中的任务才轮询；全部结束就停，不白耗请求
    refetchInterval: (query) =>
      (query.state.data?.jobs ?? []).some((j) => j.status === 'running') ? 2000 : false,
  })
}

export function useWorld() {
  return useQuery({
    queryKey: ['world'],
    queryFn: () => api<WorldData>('/world'),
  })
}

export function useThreads() {
  return useQuery({
    queryKey: ['threads'],
    queryFn: () => api<ThreadsData>('/threads'),
  })
}

export function useCreateRelation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { fromId: string; toId: string; kind: string; strength: number }) =>
      post('/relations', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['relations'] })
    },
  })
}

export function useSearch() {
  return useMutation({
    mutationFn: (v: { query: string }) => post<SearchResult>('/search', { query: v.query }),
  })
}

export function useRelations(chapter: number | null) {
  return useQuery({
    queryKey: ['relations', chapter],
    queryFn: () =>
      api<RelationGraphData>(`/relations${chapter === null ? '' : `?chapter=${chapter}`}`),
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
    // ★ 改成「提交任务 + 轮询」：生成要 40–90 秒，同步请求会让浏览器干等，
    //   代理层也可能先超时。轮询间隔 2 秒，总上限 6 分钟。
    mutationFn: async (v: { chapterNo: number; guidance?: string }) => {
      const { jobId } = await post<{ jobId: string }>(`/chapters/${v.chapterNo}/generate-async`, {
        ...(v.guidance === undefined ? {} : { guidance: v.guidance }),
      })
      for (let i = 0; i < 180; i += 1) {
        await new Promise((r) => setTimeout(r, 2000))
        const job = await api<GenerateJob>(`/jobs/${jobId}`)
        if (job.status === 'done' && job.result !== null) return job.result
        if (job.status === 'failed') throw new Error(job.error ?? '生成失败')
      }
      throw new Error('生成超时（6 分钟），可稍后看场景列表是否已完成')
    },
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

export function useRewriteScene() {
  const invalidate = useInvalidateChapter()
  return useMutation({
    mutationFn: (v: {
      chapterNo: number
      sceneNo: number
      version: number
      segId: string
      guidance?: string
    }) =>
      post<{ newVersion: number; relPath: string; original: string; rewritten: string }>(
        `/chapters/${v.chapterNo}/scenes/${v.sceneNo}/rewrite`,
        {
          version: v.version,
          segId: v.segId,
          ...(v.guidance === undefined ? {} : { guidance: v.guidance }),
        },
      ),
    onSuccess: (_d, v) => invalidate(v.chapterNo),
  })
}

export function useCheck() {
  return useMutation({
    mutationFn: (v: { chapterNo: number }) =>
      post<HealthReport>(`/chapters/${v.chapterNo}/check`, {}),
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
