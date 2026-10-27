import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, post } from './client'
import type {
  AssetsData,
  BlueprintLite,
  Book,
  ChapterDetail,
  ChapterText,
  CharacterRow,
  CheckpointRow,
  DiffResult,
  FinalizeResult,
  GenerateJob,
  HealthReport,
  LibraryCurrent,
  LibraryData,
  LocationRow,
  LoreItem,
  OntologyClassesData,
  OntologyDetailData,
  OntologyGraphData,
  OverviewData,
  PowerSystem,
  ProposeResult,
  RelationGraphData,
  RouteRow,
  SceneDetail,
  SearchResult,
  SettingsData,
  ThreadsData,
  WorldData,
  WorldRuleRow,
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

export function useCheckpoints() {
  return useQuery({
    queryKey: ['checkpoints'],
    queryFn: () => api<{ checkpoints: CheckpointRow[] }>('/checkpoints'),
  })
}

/**
 * 拍一个检查点：先把当前文件全部提交，再记录每个要素历史文件的行数。
 * ★ 行数必须在 commit 之后取（createCheckpoint 内部保证），否则回退时
 *   文件回到这一刻、要素历史却多留了几条，状态会对不上。
 */
export function useCreateCheckpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (label: string) => post<{ checkpoint: CheckpointRow }>('/checkpoints', { label }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['checkpoints'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

/**
 * 回到某个检查点：恢复文件 + 截断要素历史 + 重建索引。
 * ★ 成功后把整棵树都 invalidate：回退可能动了章节、角色、世界、线索——
 *   只清某一个 query 的话，界面上会留一半旧数据。
 */
export function useRollbackCheckpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      post<{
        ok: true
        restoredPaths: string[]
        truncatedRevisionFiles: string[]
        warnings: string[]
        reindex: { characters: number; chapters: number; warnings: string[] }
      }>(`/checkpoints/${encodeURIComponent(id)}/rollback`, {}),
    onSuccess: () => {
      void qc.invalidateQueries()
    },
  })
}

export function useOverview(enabled = true) {
  return useQuery({
    queryKey: ['overview'],
    queryFn: () => api<OverviewData>('/overview'),
    enabled,
  })
}

export function useAssets() {
  return useQuery({ queryKey: ['assets'], queryFn: () => api<AssetsData>('/assets') })
}

/** 整场重写：产生新版本 + 全新段 ID（区别于「重写这段」的段级精修） */
export function useRewriteSceneFull(chapterNo: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { sceneNo: number; guidance?: string }) =>
      post<{ scene: { sceneNo: number; version: number; wordCount: number } }>(
        `/chapters/${chapterNo}/scenes/${input.sceneNo}/rewrite-full`,
        input.guidance === undefined ? {} : { guidance: input.guidance },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chapter', chapterNo] })
      void qc.invalidateQueries({ queryKey: ['chapter-text', chapterNo] })
    },
  })
}

/** 生成角色形象：与 CLI `portrait` 同一条服务端链路 */
export function useGeneratePortrait() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { characterId: string; style?: string }) =>
      fetch('/api/portraits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null
          throw new Error(e?.error?.message ?? `生成失败 HTTP ${r.status}`)
        }
        return (await r.json()) as { characterId: string; name: string; filePath: string }
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets'] })
    },
  })
}

export function useChapterText(chapterNo: number) {
  return useQuery({
    queryKey: ['chapter-text', chapterNo],
    queryFn: () => api<ChapterText>(`/chapters/${chapterNo}/text`),
  })
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/settings') })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null
          throw new Error(e?.error?.message ?? `保存失败 HTTP ${r.status}`)
        }
        return (await r.json()) as { note: string }
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}

export function useWorld() {
  return useQuery({
    queryKey: ['world'],
    queryFn: () => api<WorldData>('/world'),
  })
}

/** 要素文件读取：characters/index.json 等（只允许 characters/ 与 world/ 下） */
export function useCharacters() {
  return useQuery({
    queryKey: ['element', 'characters/index.json'],
    queryFn: () =>
      api<{ path: string; data: CharacterRow[] }>('/elements?path=characters%2Findex.json').then(
        (r) => r.data,
      ),
  })
}

export function useRules() {
  return useQuery({
    queryKey: ['element', 'world/rules.json'],
    queryFn: () =>
      api<{ path: string; data: WorldRuleRow[] }>('/elements?path=world%2Frules.json').then(
        (r) => r.data,
      ),
  })
}

export function useLocations() {
  return useQuery({
    queryKey: ['element', 'world/locations.json'],
    queryFn: () =>
      api<{ path: string; data: LocationRow[]; hash: string }>(
        '/elements?path=world%2Flocations.json',
      ).then((r) => r.data),
  })
}

export function useRoutes() {
  return useQuery({
    queryKey: ['element', 'world/routes.json'],
    queryFn: () =>
      api<{ path: string; data: RouteRow[]; hash: string }>(
        '/elements?path=world%2Froutes.json',
      ).then((r) => r.data),
  })
}

export function usePowerSystem() {
  return useQuery({
    queryKey: ['element', 'world/power-system.json'],
    queryFn: () =>
      api<{ path: string; data: PowerSystem }>('/elements?path=world%2Fpower-system.json').then(
        (r) => r.data,
      ),
  })
}

/** 保存要素：与 CLI `element set` 同一条写入路径（CAS + revision + commit） */
export function useSaveElement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      relPath: string
      entityType: string
      entityId: string
      payload: unknown
      reason?: string
    }) =>
      // 先读当前 hash 再写：这份编辑是基于刚才读到的那个版本，
      // 中间被别人（CLI / 另一个标签页）改过就 409，而不是静默覆盖。
      api<{ hash: string }>(`/elements?path=${encodeURIComponent(input.relPath)}`)
        .then((r) =>
          fetch('/api/elements', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...input, expectedHash: r.hash }),
          }),
        )
        .then(async (r) => {
          if (!r.ok) {
            const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null
            throw new Error(e?.error?.message ?? `保存失败 HTTP ${r.status}`)
          }
          return (await r.json()) as { version: number }
        }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['element', v.relPath] })
      // 角色名/关系可能被别处引用，一并刷新
      void qc.invalidateQueries({ queryKey: ['relations'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
      // 地点/路线同时被 /api/world 读取（地图），不刷新的话图还是旧位置
      void qc.invalidateQueries({ queryKey: ['world'] })
    },
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

/** 新建章节蓝图：id / projectId 由服务端生成 */
export function useCreateBlueprint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      chapterNo: number
      title?: string
      goal: string
      conflict: string
      hook: string
      beatType?: string
      tensionLevel?: number
    }) =>
      fetch('/api/blueprints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null
          throw new Error(e?.error?.message ?? `新建失败 HTTP ${r.status}`)
        }
        return (await r.json()) as { chapterNo: number; version: number }
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blueprints'] })
      void qc.invalidateQueries({ queryKey: ['book'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
    },
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

// ---------------------------------------------------------------------------
// 书库
// ---------------------------------------------------------------------------

/**
 * 切书后整页重载：当前页面的 query 缓存、Agent runId、选中的章节
 * 都属于上一本书，局部 invalidate 清不干净。
 */
function reloadAfterBookChange(): void {
  window.localStorage.removeItem('inkloom.agent.runId')
  window.location.reload()
}

export function useLibrary() {
  return useQuery({
    queryKey: ['library'],
    queryFn: () => api<LibraryData>('/library'),
    retry: false,
  })
}

export function useOpenLibraryBook() {
  return useMutation({
    mutationFn: (folder: string) =>
      post<{ current: LibraryCurrent | null }>('/library/open', { folder }),
    onSuccess: reloadAfterBookChange,
  })
}

export function useCreateLibraryBook() {
  return useMutation({
    mutationFn: (v: {
      name: string
      genre: string
      totalChapters?: number
      wordsPerChapter?: number
    }) => post<{ current: LibraryCurrent | null; folder: string }>('/library/create', v),
    onSuccess: reloadAfterBookChange,
  })
}

export function useCloseLibraryBook() {
  return useMutation({
    mutationFn: () => post<{ current: null }>('/library/close'),
    onSuccess: reloadAfterBookChange,
  })
}

// ---------------------------------------------------------------------------
// 图谱
// ---------------------------------------------------------------------------

export function useOntologyGraph(params: {
  classId?: string | undefined
  q?: string
  issuesOnly?: boolean
}) {
  const search = new URLSearchParams()
  if (params.classId !== undefined) search.set('class', params.classId)
  if (params.q !== undefined && params.q.length > 0) search.set('q', params.q)
  if (params.issuesOnly === true) search.set('issues', '1')
  const qs = search.toString()
  return useQuery({
    queryKey: ['ontology', 'graph', qs],
    queryFn: () => api<OntologyGraphData>(`/ontology/graph${qs.length > 0 ? `?${qs}` : ''}`),
  })
}

export function useOntologyNode(id: string | null) {
  return useQuery({
    queryKey: ['ontology', 'node', id],
    queryFn: () => api<OntologyDetailData>(`/ontology/nodes/${id}`),
    enabled: id !== null,
  })
}

export function useOntologyClasses() {
  return useQuery({
    queryKey: ['ontology', 'classes'],
    queryFn: () => api<OntologyClassesData>('/ontology/classes'),
  })
}

// ---------------------------------------------------------------------------
// 资料卡
// ---------------------------------------------------------------------------

export function useLore(approved?: boolean) {
  return useQuery({
    queryKey: ['lore', approved ?? 'all'],
    queryFn: () =>
      api<{ items: LoreItem[] }>(
        `/lore${approved === undefined ? '' : `?approved=${approved ? '1' : '0'}`}`,
      ),
  })
}

export function useApproveLore() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => post<LoreItem>(`/lore/${id}/approve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lore'] }),
  })
}

export function useDeleteLore() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/lore/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lore'] }),
  })
}
