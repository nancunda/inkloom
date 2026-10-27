import type { FetchLike } from '../llm/types.js'

export type SearchProviderId = 'tavily' | 'searxng' | 'duckduckgo'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  provider: SearchProviderId
}

export interface SearchProvider {
  readonly id: SearchProviderId
  search(query: string, maxResults?: number): Promise<SearchHit[]>
}

export interface SearchResult {
  hits: SearchHit[]
  provider: SearchProviderId | null
  degraded: boolean
  warnings: string[]
}

export interface ProviderOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
}
