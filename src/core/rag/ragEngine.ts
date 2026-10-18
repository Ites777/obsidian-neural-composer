import { App, Notice, TFile, requestUrl } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { VectorManager } from '../../database/modules/vector/VectorManager'
import { SelectEmbedding } from '../../database/schema'
import { NeuralComposerSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import { isExcludedFromGraphSync } from '../../utils/glob-utils'

import { getEmbeddingModelClient } from './embedding'

// Helper type matching the method signature to avoid 'any' casting
type RagQueryResult = (Omit<SelectEmbedding, 'embedding'> & {
  similarity: number
})[]

// Interface for internal results
type RagResult = {
  id: number
  model?: string
  path: string
  content: string
  similarity: number
  mtime?: number
  metadata?: {
    startLine: number
    endLine: number
    fileName?: string
    content?: string
  }
} & Partial<SelectEmbedding>

// FIX: New interface to type the API response and avoid 'any'
type LightRagAPIResponse = {
  response?: string
  references?: {
    reference_id?: string
    file_path?: string
    content?: string
  }[]
  [key: string]: unknown // Allow other props safely
}

type IndexedDocument = {
  id: string
  file_path: string
  status: string
  error_msg?: string | null
}

/**
 * Count how many times reference [N] is explicitly cited in the response text.
 * LightRAG embeds markers like "[1]", "[2]" in the generated answer when
 * include_references=true, so this gives us a real signal of how much each
 * source contributed to the response.
 */
function countCitations(responseText: string, refNumber: number): number {
  const matches = responseText.match(new RegExp(`\\[${refNumber}\\]`, 'g'))
  return matches ? matches.length : 0
}

export class RAGEngine {
  private app: App
  private settings: NeuralComposerSettings
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private disposed = false
  private reindexQueue: Promise<boolean> = Promise.resolve(true)

  constructor(
    app: App,
    settings: NeuralComposerSettings,
    vectorManager: VectorManager,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = vectorManager
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  cleanup() {
    this.disposed = true
    this.embeddingModel = null
    this.vectorManager = null
  }

  setSettings(settings: NeuralComposerSettings) {
    this.settings = settings
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  private getLightRagHeaders(
    contentType = 'application/json',
  ): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (this.settings.lightRagApiKey) {
      headers['X-API-Key'] = this.settings.lightRagApiKey
    }
    return headers
  }

  // Correct: Returns Promise<void> directly without async/await overhead
  updateVaultIndex(
    _options: { reindexAll: boolean } = { reindexAll: false },
    _onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<void> {
    if (!this.embeddingModel)
      return Promise.reject(new Error('Embedding model is not set'))
    return Promise.resolve()
  }

  // --- 1. TEXT INGESTION ---
  async insertDocument(
    content: string,
    description?: string,
  ): Promise<boolean> {
    const safeName =
      description && description.trim() ? description : `Note_${Date.now()}.md`
    try {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/documents/texts`,
        method: 'POST',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({ texts: [content], file_sources: [safeName] }),
        throw: false,
      })

      if (response.status >= 400) {
        throw new Error(`Error ${response.status}: ${response.text}`)
      }
      return true
    } catch (error) {
      console.error('Error in input of text:', error)
      new Notice(
        `Error saving to the graph: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  // --- 2. BINARY INGESTION (Manual Multipart) ---
  async uploadDocument(
    file: TFile,
    beforeSubmit?: () => void,
  ): Promise<boolean> {
    try {
      const fileData = await this.app.vault.readBinary(file)

      const boundary = '----ObsidianBoundary' + Date.now().toString(16)

      const prePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      const postPart = `\r\n--${boundary}--\r\n`

      const preBuffer = new TextEncoder().encode(prePart)
      const postBuffer = new TextEncoder().encode(postPart)
      const bodyBuffer = new Uint8Array(
        preBuffer.length + fileData.byteLength + postBuffer.length,
      )

      bodyBuffer.set(preBuffer, 0)
      bodyBuffer.set(new Uint8Array(fileData), preBuffer.length)
      bodyBuffer.set(postBuffer, preBuffer.length + fileData.byteLength)

      beforeSubmit?.()
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/documents/upload`,
        method: 'POST',
        headers: this.getLightRagHeaders(
          `multipart/form-data; boundary=${boundary}`,
        ),
        body: bodyBuffer.buffer,
        throw: false,
      })

      if (response.status >= 400) {
        throw new Error(`Error ${response.status}: ${response.text}`)
      }

      return true
    } catch (error) {
      console.error('Error uploading file:', error)
      new Notice(
        `Error uploading ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  // --- 2b. INCREMENTAL SYNC HELPERS ---

  private async listAllDocuments(): Promise<IndexedDocument[]> {
    const pageSize = 200
    const out: IndexedDocument[] = []
    let page = 1
    for (;;) {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/documents/paginated`,
        method: 'POST',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({
          page,
          page_size: pageSize,
          sort_field: 'file_path',
          sort_direction: 'asc',
        }),
        throw: false,
      })
      if (response.status >= 400) {
        throw new Error(`Cannot list documents: HTTP ${response.status}`)
      }
      const data = response.json as {
        documents?: IndexedDocument[]
        pagination?: { has_next?: boolean }
      }
      const docs = data.documents
      if (
        !Array.isArray(docs) ||
        typeof data.pagination?.has_next !== 'boolean' ||
        docs.some(
          (doc) =>
            !doc ||
            typeof doc.id !== 'string' ||
            typeof doc.file_path !== 'string' ||
            typeof doc.status !== 'string',
        )
      ) {
        throw new Error('Invalid document list response')
      }
      for (const doc of docs) {
        if (doc.file_path.length > 0) {
          out.push(doc)
        }
      }
      if (!data.pagination.has_next) break
      if (docs.length === 0 || page >= 1000) {
        throw new Error('Incomplete document pagination')
      }
      page++
    }
    return out
  }

  async listAllDocumentPaths(): Promise<string[]> {
    return (await this.listAllDocuments()).map((d) => d.file_path)
  }

  /**
   * Returns a map of vault file_path → LightRAG doc_id, built in a single
   * pagination pass. Both the full path and the bare filename are indexed so
   * callers can match either (pre-v1.2 entries stored only the filename).
   */
  async getDocIdMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const d of await this.listAllDocuments()) {
      map.set(d.file_path, d.id)
      const base = d.file_path.replace(/\\/g, '/').split('/').pop()
      if (base && !map.has(base)) map.set(base, d.id)
    }
    return map
  }

  /**
   * Deletes multiple documents in one request. /documents/delete_document
   * accepts a doc_ids array, so bulk operations send all ids at once instead
   * of one request per file.
   */
  async deleteDocumentsByIds(docIds: string[]): Promise<boolean> {
    if (docIds.length === 0) return true
    try {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/documents/delete_document`,
        method: 'DELETE',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({
          doc_ids: docIds,
          delete_file: false,
          delete_llm_cache: true,
        }),
        throw: false,
      })
      return response.status < 400
    } catch {
      return false
    }
  }

  // Finds a LightRAG doc_id matching the given file.
  // Tries the full vault-relative path first (v1.2+ ingest), then falls back to
  // bare filename (pre-v1.2 ingest used file.name instead of file.path).
  async findDocIdByFilePath(
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    return (await this.findDocument(filePath, fileName))?.id ?? null
  }

  private async findDocument(
    filePath: string,
    fileName: string,
  ): Promise<IndexedDocument | undefined> {
    const docs = await this.listAllDocuments()
    let matches = docs.filter((doc) => doc.file_path === filePath)
    if (matches.length === 0) {
      matches = docs.filter((doc) => doc.file_path === fileName)
      if (
        matches.length > 0 &&
        this.app.vault.getFiles().filter((file) => file.name === fileName)
          .length !== 1
      ) {
        throw new Error(`Ambiguous legacy document name: ${fileName}`)
      }
    }
    if (matches.length > 1) throw new Error(`Ambiguous document: ${filePath}`)
    return matches[0]
  }

  async deleteDocumentByFilePath(
    filePath: string,
    fileName: string,
  ): Promise<boolean> {
    try {
      const docId = await this.findDocIdByFilePath(filePath, fileName)
      if (!docId) return false
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/documents/delete_document`,
        method: 'DELETE',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({
          doc_ids: [docId],
          delete_file: false,
          delete_llm_cache: true,
        }),
        throw: false,
      })
      return response.status < 400
    } catch {
      return false
    }
  }

  reindexFile(file: TFile): Promise<boolean> {
    const path = file.path
    const settings = this.settings
    const result = this.reindexQueue.then(() =>
      this.performReindex(file, path, settings),
    )
    this.reindexQueue = result.catch(() => false)
    return result
  }

  private async performReindex(
    file: TFile,
    path: string,
    settings: NeuralComposerSettings,
  ): Promise<boolean> {
    const serverUrl = settings.lightRagServerUrl
    const apiKey = settings.lightRagApiKey
    const deadline = Date.now() + 30 * 60 * 1000
    const assertCurrent = () => {
      if (
        this.disposed ||
        serverUrl !== this.settings.lightRagServerUrl ||
        apiKey !== this.settings.lightRagApiKey ||
        file.path !== path ||
        this.app.vault.getAbstractFileByPath(path) !== file ||
        isExcludedFromGraphSync(path, {
          excludePatterns: this.settings.lightRagExcludePatterns,
          excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
        })
      ) {
        throw new Error(
          'Document update cancelled: source or connection changed',
        )
      }
    }
    const waitUntil = async (check: () => Promise<boolean>) => {
      for (;;) {
        assertCurrent()
        if (Date.now() >= deadline) throw new Error('Document update timed out')
        const ready = await check()
        assertCurrent()
        if (ready) return
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
    }
    const isIdle = async () => {
      const response = await requestUrl({
        url: `${serverUrl}/documents/pipeline_status`,
        method: 'GET',
        headers: this.getLightRagHeaders(),
        throw: false,
      })
      const status = response.json as {
        busy?: boolean
        destructive_busy?: boolean
        scanning?: boolean
        pending_enqueues?: number
        recovery_required?: boolean
      }
      if (response.status >= 400 || typeof status.busy !== 'boolean') {
        throw new Error('Cannot read pipeline status')
      }
      if (status.recovery_required)
        throw new Error('LightRAG requires recovery')
      return (
        !status.busy &&
        !status.destructive_busy &&
        !status.scanning &&
        !status.pending_enqueues
      )
    }

    try {
      await waitUntil(isIdle)
      const previous = await this.findDocument(path, file.name)
      assertCurrent()
      if (previous) {
        await waitUntil(async () => {
          if (!(await isIdle())) return false
          assertCurrent()
          const response = await requestUrl({
            url: `${serverUrl}/documents/delete_document`,
            method: 'DELETE',
            headers: this.getLightRagHeaders(),
            body: JSON.stringify({
              doc_ids: [previous.id],
              delete_file: false,
              delete_llm_cache: true,
            }),
            throw: false,
          })
          if (response.status >= 400)
            throw new Error(`Delete failed: HTTP ${response.status}`)
          const status = response.json as { status?: string }
          if (status.status === 'busy') return false
          if (status.status !== 'deletion_started')
            throw new Error('Deletion was not accepted')
          return true
        })
        await waitUntil(
          async () =>
            (await isIdle()) &&
            !(await this.listAllDocuments()).some(
              (doc) => doc.id === previous.id,
            ),
        )
      }

      await waitUntil(isIdle)
      assertCurrent()
      if (!(await this.ingestFile(file, assertCurrent))) return false
      await waitUntil(async () => {
        const doc = await this.findDocument(path, file.name)
        if (doc?.status.toLowerCase() === 'failed') {
          throw new Error(doc.error_msg || 'Document processing failed')
        }
        return doc?.status.toLowerCase() === 'processed'
      })
      return true
    } catch (error) {
      console.error('Document update failed:', error)
      if (!this.disposed) {
        new Notice(
          `Graph sync: ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return false
    }
  }

  // Inserts a file into the index without deleting first.
  async ingestFile(file: TFile, beforeSubmit?: () => void): Promise<boolean> {
    // Defense-in-depth: callers already gate excluded files, but this
    // prevents any future call site from bypassing exclusion settings.
    if (
      isExcludedFromGraphSync(file.path, {
        excludePatterns: this.settings.lightRagExcludePatterns,
        excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
      })
    ) {
      return false
    }

    const ext = file.extension.toLowerCase()
    const textExts = ['md', 'txt', 'csv', 'json', 'html', 'htm', 'xml']
    if (textExts.includes(ext)) {
      const content = await this.app.vault.read(file)
      const finalContent =
        ext === 'md' ? `Title: ${file.basename}\n\n${content}` : content
      beforeSubmit?.()
      return this.insertDocument(finalContent, file.path)
    }
    return this.uploadDocument(file, beforeSubmit)
  }

  // --- 3. MASTER QUERY ---
  async processQuery({
    query,
    scope,
    onQueryProgressChange,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<RagQueryResult> {
    // 1. LOCAL STRATEGY
    if (scope && scope.files && scope.files.length > 0) {
      const localResults: RagResult[] = []
      for (const filePath of scope.files) {
        const file = this.app.vault.getAbstractFileByPath(filePath)
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file)
          localResults.push({
            id: -1,
            model: 'local-file',
            path: filePath,
            content: content,
            similarity: 1.0,
            mtime: file.stat.mtime,
            metadata: {
              startLine: 0,
              endLine: 0,
              fileName: file.name,
              content: content,
            },
          })
        }
      }
      onQueryProgressChange?.({ type: 'querying-done', queryResult: [] })
      // Safe casting to expected return type
      return localResults as unknown as RagQueryResult
    }

    // 2. GLOBAL STRATEGY
    onQueryProgressChange?.({ type: 'querying' })

    // FIX: Typed return promise to avoid implicit 'any' from response.json
    const performQuery = async (): Promise<LightRagAPIResponse> => {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/query`,
        method: 'POST',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({
          query: query,
          mode: this.settings.lightRagQueryMode || 'mix',
          stream: false,
          only_need_context: false,
          // Ask LightRAG to embed [N] citation markers so we can score references
          include_references: true,
        }),
        throw: false,
      })

      if (response.status >= 400) {
        const errorText = response.text
        if (
          errorText.toLowerCase().includes('quota') ||
          errorText.toLowerCase().includes('credit') ||
          errorText.toLowerCase().includes('429')
        ) {
          new Notice(
            'Rerank error: quota exceeded. Please check your API key.',
            0,
          )
        } else if (errorText.toLowerCase().includes('rerank')) {
          new Notice(`Reranking error: ${errorText}`, 5000)
        }
        throw new Error(`Status ${response.status}: ${errorText}`)
      }
      // FIX: Cast to interface instead of returning 'any'
      return response.json as LightRagAPIResponse
    }

    try {
      const data = await performQuery()

      const results: RagResult[] = []
      const graphAnswer = data.response || ''
      const refs = data.references ?? []

      // --- Compute real relevance scores from citation frequency ---
      // LightRAG embeds [1], [2], ... markers in the response when references
      // are included. Count how often each source is cited → normalize to 0–1.
      const citationCounts = refs.map((_, i) =>
        countCitations(graphAnswer, i + 1),
      )
      const maxCitations = Math.max(...citationCounts, 1)

      // Score formula:
      //   cited ≥1 time  → 0.40 + (citedCount / maxCited) * 0.55   [0.40 – 0.95]
      //   cited 0 times  → 0.20  (listed as reference but not explicitly cited)
      const refScore = (citations: number): number =>
        citations > 0 ? 0.4 + (citations / maxCitations) * 0.55 : 0.2

      // Build master "Graph's memory" entry (the raw LightRAG answer)
      if (graphAnswer) {
        results.push({
          id: -1,
          model: 'lightrag-master',
          path: "Graph's memory",
          content: graphAnswer,
          similarity: 1.0,
          mtime: Date.now(),
          metadata: { startLine: 0, endLine: 0, fileName: 'Graph answer' },
        })
      }

      // Build one entry per cited document with a real relevance score
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i]
        const filePath = ref.file_path || `Source #${i + 1}`
        results.push({
          id: -(i + 2),
          model: 'lightrag-ref',
          path: filePath, // clean path — no [N] prefix
          content: ref.content || '',
          similarity: refScore(citationCounts[i]),
          mtime: Date.now(),
          metadata: { startLine: 0, endLine: 0, fileName: filePath },
        })
      }

      onQueryProgressChange?.({ type: 'querying-done', queryResult: [] })
      return results as unknown as RagQueryResult
    } catch (error: unknown) {
      console.error('Final error:', error)
      const message = error instanceof Error ? error.message : String(error)
      const errorDoc: RagResult = {
        id: -2,
        path: 'Query error',
        content: `No response could be obtained from graph.\n\nPossible cause: ${message}\n\nIf you use reranking, check your credits.`,
        similarity: 1.0,
        metadata: { startLine: 0, endLine: 0 },
      }
      return [errorDoc] as unknown as RagQueryResult
    }
  }

  private getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel)
      return Promise.reject(new Error('Embedding model not set'))
    return this.embeddingModel.getEmbedding(query)
  }
}
