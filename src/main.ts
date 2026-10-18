import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  requestUrl,
  setTooltip,
} from 'obsidian'

import { ApplyView } from './ApplyView'
import { ChatView } from './ChatView'
import { ChatProps } from './components/chat-view/Chat'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants'
import { McpManager } from './core/mcp/mcpManager'
import { DocIndexService } from './core/rag/docIndexService'
import { FileExplorerDecorator } from './core/rag/fileExplorerDecorator'
import { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { VectorManager } from './database/modules/vector/VectorManager'
import {
  NeuralComposerSettings,
  NeuralComposerSettingsSchema,
} from './settings/schema/setting.types'
import { parseNeuralComposerSettings } from './settings/schema/settings'
import { NeuralComposerSettingTab } from './settings/SettingTab'
import {
  getExcludePatternForPath,
  isExcludedFromGraphSync,
} from './utils/glob-utils'
import { getMentionableBlockData } from './utils/obsidian'
import {
  NATIVE_GRAPH_VIEW_TYPE,
  NativeGraphView,
} from './views/NativeGraphView'

export const PLUGIN_NAME = 'Neural Composer'
export const BACKEND_NAME = 'LightRAG'
export const CMD_INGEST_FOLDER = 'Ingest folder into graph'

// --- MASTER EXTENSION LIST ---
const SUPPORTED_EXTENSIONS = [
  'md',
  'txt',
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'rtf',
  'odt',
  'epub',
  'html',
  'htm',
  'xml',
  'json',
  'yaml',
  'yml',
  'csv',
  'tex',
  'log',
  'conf',
  'ini',
  'properties',
  'sql',
  'bat',
  'sh',
  'c',
  'cpp',
  'py',
  'java',
  'js',
  'ts',
  'swift',
  'go',
  'rb',
  'php',
  'css',
  'scss',
  'less',
]

const TEXT_BASED_EXTENSIONS = [
  'md',
  'txt',
  'html',
  'htm',
  'xml',
  'json',
  'yaml',
  'yml',
  'csv',
  'tex',
  'log',
  'conf',
  'ini',
  'properties',
  'sql',
  'bat',
  'sh',
  'c',
  'cpp',
  'py',
  'java',
  'js',
  'ts',
  'swift',
  'go',
  'rb',
  'php',
  'css',
  'scss',
  'less',
]

// Read-only desktop file access used by NativeGraphView.
type NodeFsLike = {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: string): string
}

type NodePathLike = {
  join(...paths: string[]): string
}

export default class NeuralComposerPlugin extends Plugin {
  settings: NeuralComposerSettings
  initialChatProps?: ChatProps
  settingsChangeListeners: ((newSettings: NeuralComposerSettings) => void)[] =
    []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  ragEngine: RAGEngine | null = null

  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null

  private timeoutIds: number[] = []
  private modifyDebounceMap: Map<string, number> = new Map()
  // shortcut: this queue is in memory; add persistence if restart recovery is needed.
  private pendingModifiedFiles = new Map<string, TFile>()
  private syncingModifiedFiles = false
  public docIndexService: DocIndexService | null = null
  private fileExplorerDecorator: FileExplorerDecorator | null = null
  private lastServerStatus: 'online' | 'offline' | 'busy' = 'offline'
  /** True once the doc-status index has been loaded from disk. Prevents vault
   *  events that fire during Obsidian startup from re-submitting already-ingested files. */
  private docIndexReady = false

  /** Detected LightRAG core version (from GET /health → core_version). Null when offline or not yet checked. */
  public lightRagServerVersion: string | null = null
  /** True once at least one health check has completed (distinguishes "not yet checked" from "offline"). */
  public lightRagServerChecked = false

  private ingestedFolderPaths: Set<string> = new Set()
  private ingestedFolderPathsLoaded = false

  private versionChangeListeners: Set<
    (info: { version: string | null; checked: boolean }) => void
  > = new Set()

  /** Subscribe to LightRAG server version/status changes. Returns an unsubscribe fn. */
  addVersionChangeListener(
    fn: (info: { version: string | null; checked: boolean }) => void,
  ): () => void {
    this.versionChangeListeners.add(fn)
    return () => this.versionChangeListeners.delete(fn)
  }

  private setServerVersion(v: string | null): void {
    const wasChecked = this.lightRagServerChecked
    this.lightRagServerChecked = true
    // Notify if: first health check (checked state just flipped) OR version changed
    if (!wasChecked || v !== this.lightRagServerVersion) {
      this.lightRagServerVersion = v
      this.versionChangeListeners.forEach((fn) =>
        fn({ version: v, checked: true }),
      )
    }
  }

  // Node.js modules — loaded lazily on desktop only, always null on mobile.
  // fs/path are public so views (e.g. NativeGraphView) can reuse them instead
  // of importing Node built-ins themselves.
  _nodeFs: NodeFsLike | null = null
  _nodePath: NodePathLike | null = null

  // --- STATUS BAR PROPERTIES ---
  private statusBarEl: HTMLElement
  private statusDotEl: HTMLElement
  private heartbeatInterval: number

  private getLightRagHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.settings.lightRagApiKey) {
      headers['X-API-Key'] = this.settings.lightRagApiKey
    }
    return headers
  }

  async onload() {
    await this.loadSettings()

    // Load Node.js built-ins once at startup — desktop only, never on mobile.
    // Obsidian desktop exposes Node's `require` on the window object. Calling
    // it as a member (`window.require`) rather than a bare `require` keeps
    // these Node built-ins out of the static import graph the Obsidian plugin
    // linter rejects, while resolving the exact same modules at runtime.
    if (Platform.isDesktop) {
      const nodeRequire = (
        window as unknown as { require: (id: string) => unknown }
      ).require
      this._nodeFs = nodeRequire('fs') as NodeFsLike
      this._nodePath = nodeRequire('path') as NodePathLike
    }

    // --- STATUS BAR INITIALIZATION ---
    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('nrlcmp-status-bar-item')
    this.statusDotEl = this.statusBarEl.createSpan({ cls: 'nrlcmp-status-dot' })
    this.statusBarEl.createSpan({ text: 'Neural' })
    setTooltip(this.statusBarEl, `${BACKEND_NAME} server status`)

    this.statusBarEl.onclick = () => {
      void this.handleStatusBarClick()
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf))

    this.addRibbonIcon('brain-circuit', `Open ${PLUGIN_NAME}`, () => {
      void this.openChatView()
    })

    // NATIVE GRAPH VIEWER
    this.registerView(
      NATIVE_GRAPH_VIEW_TYPE,
      (leaf) => new NativeGraphView(leaf, this),
    )

    this.addCommand({
      id: 'open-native-graph',
      name: 'Open native graph view',
      callback: () => {
        // Wrapped in void async IIFE to satisfy void return expectation
        void (async () => {
          const { workspace } = this.app
          let leaf: WorkspaceLeaf | null = null
          const leaves = workspace.getLeavesOfType(NATIVE_GRAPH_VIEW_TYPE)

          if (leaves.length > 0) {
            leaf = leaves[0]
          } else {
            leaf = workspace.getLeaf(true)
            await leaf.setViewState({
              type: NATIVE_GRAPH_VIEW_TYPE,
              active: true,
            })
          }
          if (leaf) await workspace.revealLeaf(leaf)
        })()
      },
    })

    this.addCommand({
      id: 'open-new-chat',
      name: 'Open chat',
      callback: () => {
        void this.openChatView(true)
      },
    })

    this.addCommand({
      id: 'add-selection-to-chat',
      name: 'Add selection to chat',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.addSelectionToChat(editor, view)
      },
    })

    // --- CONTEXT MENU (FOLDERS) ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          const inGraph = this.isFolderInGraph(file.path)
          const showIngest = !this.ingestedFolderPathsLoaded || !inGraph
          const showRemove = !this.ingestedFolderPathsLoaded || inGraph

          if (showIngest) {
            menu.addItem((item) => {
              item
                .setTitle(CMD_INGEST_FOLDER)
                .setIcon('layers')
                .onClick(() => {
                  void this.batchIngestFolder(file)
                })
            })
          }
          if (showRemove) {
            menu.addItem((item) => {
              item
                .setTitle('Remove folder from graph')
                .setIcon('trash-2')
                .onClick(() => {
                  void this.batchRemoveFolderFromGraph(file)
                })
            })
          }
        }
      }),
    )

    // --- CONTEXT MENU: exclude / re-include from graph sync ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        this.addGraphExclusionMenuItem(menu, [file])
      }),
    )
    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        this.addGraphExclusionMenuItem(menu, files)
      }),
    )

    // --- SINGLE FILE INGEST COMMAND ---
    this.addCommand({
      id: 'ingest-current-file',
      name: 'Ingest current file into knowledge graph',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile()
        if (
          !file ||
          !SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())
        ) {
          return false
        }
        if (checking) return true

        // IIFE to handle async in callback safely
        void (async () => {
          const title = file.basename
          const ext = file.extension.toLowerCase()
          const notice = new Notice(
            `Sending "${file.name}" to the system...`,
            0,
          )

          try {
            const ragEngine = await this.getRAGEngine()
            let success = false

            if (TEXT_BASED_EXTENSIONS.includes(ext)) {
              const content = await this.app.vault.read(file)
              const finalContent =
                ext === 'md' ? `Title: ${title}\n\n${content}` : content
              success = await ragEngine.insertDocument(finalContent, file.path)
            } else {
              success = await ragEngine.uploadDocument(file)
            }

            if (success) {
              notice.setMessage(`Sent. Processing in background...`)
              await this.monitorPipeline(notice)
            } else {
              notice.setMessage(`Upload failed.`)
              window.setTimeout(() => notice.hide(), 5000)
            }
          } catch (error) {
            console.error(error)
            notice.setMessage(`Critical error connecting to backend.`)
            window.setTimeout(() => notice.hide(), 5000)
          }
        })()
      },
    })

    // --- INCREMENTAL SYNC: vault event listeners ---
    // Only active when the user has configured a watched sync folder.
    // isInSyncFolder checks that the file lives inside (or at) that folder.
    const isInSyncFolder = (filePath: string): boolean => {
      const syncFolder = this.settings.lightRagSyncFolder.trim()
      if (!syncFolder) return false
      const normalized = syncFolder.endsWith('/')
        ? syncFolder
        : `${syncFolder}/`
      return filePath === syncFolder || filePath.startsWith(normalized)
    }

    const syncModifiedFiles = async () => {
      if (this.syncingModifiedFiles) return
      this.syncingModifiedFiles = true
      try {
        while (this.docIndexReady && this.pendingModifiedFiles.size > 0) {
          const [path, file] = this.pendingModifiedFiles.entries().next()
            .value as [string, TFile]
          this.pendingModifiedFiles.delete(path)
          const index = this.docIndexService
          if (
            !index ||
            file.path !== path ||
            this.app.vault.getAbstractFileByPath(path) !== file ||
            !isInSyncFolder(path) ||
            this.isPathExcludedFromGraph(path) ||
            index.getStatus(path) === 'removed' ||
            (!index.needsIngestion(path, file.stat.mtime) &&
              index.getMtime(path) === file.stat.mtime)
          )
            continue

          const mtime = file.stat.mtime
          const notice = new Notice(`Graph sync: updating "${file.name}"...`, 0)
          index.startReindex(path, mtime)
          let ok = false
          try {
            const ragEngine = await this.getRAGEngine()
            if (!this.docIndexReady) break
            ok = await ragEngine.reindexFile(file)
          } catch (error) {
            console.error('Graph sync: document update failed', error)
          } finally {
            if (this.docIndexReady) index.finishReindex(path, ok)
            notice.hide()
          }
          if (!this.docIndexReady) break
          new Notice(
            ok
              ? `Graph sync: "${file.name}" updated.`
              : `Graph sync: failed to update "${file.name}". Use Reprocess document to retry.`,
          )
          if (file.path === path && file.stat.mtime !== mtime) {
            this.pendingModifiedFiles.set(path, file)
          }
        }
      } finally {
        this.syncingModifiedFiles = false
      }
    }

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile)) return
        if (!isInSyncFolder(file.path)) return
        if (!SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())) return
        if (this.isPathExcludedFromGraph(file.path)) return
        // Guard here (before setTimeout) so startup create-events are dropped
        // before the 2 s timer is even scheduled. By the time the timer would
        // fire, onLayoutReady has already set docIndexReady = true, so the
        // guard inside the async callback would be bypassed on every startup file.
        if (!this.docIndexReady) return
        // Wait 2 s so the file content is available (especially for moves/imports)
        window.setTimeout(() => {
          void (async () => {
            // Skip if already processed and not modified
            if (
              this.docIndexService &&
              !this.docIndexService.needsIngestion(file.path, file.stat.mtime)
            ) {
              return
            }
            const notice = new Notice(
              `Graph sync: sending "${file.name}"...`,
              0,
            )
            const ragEngine = await this.getRAGEngine()
            this.docIndexService?.setProcessing(file.path, file.stat.mtime)
            const ok = await ragEngine.ingestFile(file)
            if (!ok) {
              this.docIndexService?.setFailed(file.path)
            } else {
              // Poll pipeline_status every 1 s → sync when done → update dots
              this.docIndexService?.startPipelineWatch(1000)
            }
            notice.setMessage(
              ok
                ? `Graph sync: "${file.name}" sent — processing in background.`
                : `Graph sync: failed to send "${file.name}".`,
            )
            window.setTimeout(() => notice.hide(), 6000)
          })()
        }, 2000)
      }),
    )

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return
        if (!isInSyncFolder(file.path)) return
        void (async () => {
          const notice = new Notice(
            `Graph sync: removing "${file.name}" from index...`,
            0,
          )
          const ragEngine = await this.getRAGEngine()
          const removed = await ragEngine.deleteDocumentByFilePath(
            file.path,
            file.name,
          )
          if (removed) this.docIndexService?.removeEntry(file.path)
          notice.setMessage(
            removed
              ? `Graph sync: "${file.name}" removed from graph.`
              : `Graph sync: "${file.name}" was not in the graph.`,
          )
          window.setTimeout(() => notice.hide(), 6000)
        })()
      }),
    )

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return
        const wasInFolder = isInSyncFolder(oldPath)
        const nowInFolder = isInSyncFolder(file.path)
        if (!wasInFolder && !nowInFolder) return
        void (async () => {
          const ragEngine = await this.getRAGEngine()

          if (wasInFolder && nowInFolder) {
            // Renamed or moved within the watched folder.
            // If the new path is now excluded, remove the old doc and stop.
            if (this.isPathExcludedFromGraph(file.path)) {
              const oldName = oldPath.split('/').pop() ?? oldPath
              await ragEngine.deleteDocumentByFilePath(oldPath, oldName)
              this.docIndexService?.removeEntry(oldPath)
              return
            }
            const notice = new Notice(
              `Graph sync: updating "${file.name}" in graph...`,
              0,
            )
            const oldName = oldPath.split('/').pop() ?? oldPath
            await ragEngine.deleteDocumentByFilePath(oldPath, oldName)
            this.docIndexService?.renameEntry(oldPath, file.path)
            const ok = await ragEngine.ingestFile(file)
            notice.setMessage(
              ok
                ? `Graph sync: graph updated for "${file.name}".`
                : `Graph sync: failed to update "${file.name}".`,
            )
            window.setTimeout(() => notice.hide(), 6000)
          } else if (wasInFolder) {
            // Moved OUT of the watched folder
            const notice = new Notice(
              `Graph sync: removing "${file.name}" from graph...`,
              0,
            )
            const oldName = oldPath.split('/').pop() ?? oldPath
            const removed = await ragEngine.deleteDocumentByFilePath(
              oldPath,
              oldName,
            )
            notice.setMessage(
              removed
                ? `Graph sync: "${file.name}" removed from graph.`
                : `Graph sync: "${file.name}" was not in the graph.`,
            )
            window.setTimeout(() => notice.hide(), 6000)
          } else {
            // Moved INTO the watched folder
            if (this.isPathExcludedFromGraph(file.path)) return
            const notice = new Notice(
              `Graph sync: sending "${file.name}"...`,
              0,
            )
            this.docIndexService?.setProcessing(file.path, file.stat.mtime)
            const ok = await ragEngine.ingestFile(file)
            if (!ok) {
              this.docIndexService?.setFailed(file.path)
            } else {
              this.docIndexService?.startPipelineWatch(1000)
            }
            notice.setMessage(
              ok
                ? `Graph sync: "${file.name}" sent — processing in background.`
                : `Graph sync: failed to send "${file.name}".`,
            )
            window.setTimeout(() => notice.hide(), 6000)
          }
        })()
      }),
    )

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return
        if (!isInSyncFolder(file.path)) return
        if (!SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())) return
        if (this.isPathExcludedFromGraph(file.path)) return

        // Debounce: wait 5 s of inactivity before re-indexing
        const existing = this.modifyDebounceMap.get(file.path)
        if (existing) window.clearTimeout(existing)
        const id = window.setTimeout(() => {
          this.modifyDebounceMap.delete(file.path)
          if (!this.docIndexReady) return
          this.pendingModifiedFiles.set(file.path, file)
          void syncModifiedFiles()
        }, 5000)
        this.modifyDebounceMap.set(file.path, id)
      }),
    )

    // --- DOCUMENT STATUS CONTEXT MENUS ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
        const syncFolder = this.settings.lightRagSyncFolder.trim()
        if (!syncFolder || !this.docIndexService) return

        if (file instanceof TFile) {
          const inFolder =
            file.path === syncFolder || file.path.startsWith(syncFolder + '/')
          if (!inFolder) return

          const status = this.docIndexService.getStatus(file.path)

          // Allow reprocessing for any non-processed state, including
          // 'processing' (stuck from a crashed session) and 'removed'
          // (user wants to re-add the doc to the graph).
          if (
            status === 'failed' ||
            status === 'unknown' ||
            status === 'processing' ||
            status === 'removed'
          ) {
            menu.addItem((item) =>
              item
                .setTitle('Reprocess document')
                .setIcon('refresh-cw')
                .onClick(() => {
                  void (async () => {
                    const ragEngine = await this.getRAGEngine()
                    const path = file.path
                    const index = this.docIndexService!
                    index.startReindex(path, file.stat.mtime)
                    const ok = await ragEngine.reindexFile(file)
                    if (this.docIndexReady) index.finishReindex(path, ok)
                  })()
                }),
            )
          }

          if (status === 'processed') {
            menu.addItem((item) =>
              item
                .setTitle('Remove from graph')
                .setIcon('trash-2')
                .onClick(() => {
                  void (async () => {
                    const ragEngine = await this.getRAGEngine()
                    await ragEngine.deleteDocumentByFilePath(
                      file.path,
                      file.name,
                    )
                    // Mark as 'removed' (blue dot) instead of deleting the entry.
                    // This preserves the intentional-removal state across restarts
                    // and prevents auto-reingestion on file-change events.
                    this.docIndexService!.setRemoved(file.path)
                  })()
                }),
            )
          }
        }

        if (file instanceof TFolder && file.path === syncFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Reprocess folder')
              .setIcon('refresh-cw')
              .onClick(() => {
                void (async () => {
                  const ragEngine = await this.getRAGEngine()
                  const files = this.app.vault
                    .getFiles()
                    .filter(
                      (f) =>
                        (f.path === syncFolder ||
                          f.path.startsWith(syncFolder + '/')) &&
                        SUPPORTED_EXTENSIONS.includes(
                          f.extension.toLowerCase(),
                        ),
                    )
                  let anySubmitted = false
                  for (const f of files) {
                    const st = this.docIndexService!.getStatus(f.path)
                    // Include 'processing' — a doc can be stuck at that
                    // status from a previous failed/interrupted submission.
                    if (
                      st === 'failed' ||
                      st === 'unknown' ||
                      st === 'processing'
                    ) {
                      this.docIndexService!.setProcessing(f.path, f.stat.mtime)
                      const ok = await ragEngine.ingestFile(f)
                      if (!ok) this.docIndexService!.setFailed(f.path)
                      else anySubmitted = true
                    }
                  }
                  if (anySubmitted) {
                    this.docIndexService!.startPipelineWatch(1000)
                  }
                })()
              }),
          )
        }
      }),
    )

    this.addSettingTab(new NeuralComposerSettingTab(this.app, this))

    // Monitor the independently managed LightRAG server.
    this.app.workspace.onLayoutReady(() => {
      // --- LATIDO LEGAL Y SEGURO ---
      // registerInterval asegura que el proceso muera si el plugin se apaga
      this.registerInterval(
        window.setInterval(() => {
          void this.checkAndUpdateStatus()
        }, 30000),
      )

      // Primera revisión inmediata
      void this.checkAndUpdateStatus()

      // Initialize doc index service + file explorer decoration
      this.docIndexService = new DocIndexService(this)
      this.fileExplorerDecorator = new FileExplorerDecorator()
      this.docIndexService.setUpdateCallback(() => this.decorateFileExplorer())

      // MutationObserver inside FileExplorerDecorator watches childList changes
      // (Obsidian re-rendering file items) and re-applies data-nc-status attributes.
      // Safe: our setAttribute calls are attribute mutations — they do NOT fire
      // childList observers, so there is zero risk of an infinite loop.
      this.fileExplorerDecorator.startObserving(() =>
        this.decorateFileExplorer(),
      )

      // Re-decorate whenever the workspace layout changes (pane open/close, etc.)
      this.registerEvent(
        this.app.workspace.on('layout-change', () => {
          this.decorateFileExplorer()
        }),
      )

      // Load persisted index → render immediately, then sync with server
      void (async () => {
        await this.docIndexService!.load()
        this.docIndexReady = true // vault events safe to process from here
        this.decorateFileExplorer() // render cached statuses right away

        // Give a short delay for the server to be reachable, then sync.
        // We check health first so we don't clobber the cached index when
        // the server is simply offline.
        window.setTimeout(() => {
          void (async () => {
            const online = await this.docIndexService?.isServerOnline()
            if (online) {
              await this.docIndexService?.syncFromServer()
              this.decorateFileExplorer()
              // Always start pipeline watch after the initial sync:
              // • If the pipeline is idle → one poll → busy=false → stops immediately
              // • If docs are processing (from a previous session) → watches until done
              this.docIndexService?.startPipelineWatch(2000)
            }
          })()
        }, 2000)
      })()
    })
  }

  // --- MONITORING LOGIC ---
  async monitorPipeline(
    notice: Notice,
    doneMessage = 'Integrated knowledge!\nThe graph is up to date.',
  ) {
    this.updateStatusUI('busy')
    let isBusy = true
    let errors = 0
    // Wait for server to register task
    await new Promise((r) => window.setTimeout(r, 1000))

    while (isBusy) {
      try {
        const response = await requestUrl({
          url: `${this.settings.lightRagServerUrl}/documents/pipeline_status`,
          method: 'GET',
          headers: this.getLightRagHeaders(),
        })

        type PipelineStatus = {
          busy: boolean
          job_name?: string
          batchs?: number
          cur_batch?: number
          latest_message?: string
        }
        const status = response.json as PipelineStatus
        isBusy = status.busy

        if (isBusy) {
          const total = status.batchs || 1
          const current = status.cur_batch || 0
          const percent = Math.round((current / total) * 100)
          // job_name distinguishes deletion ("Deleting N Documents") from
          // ingestion so the header reflects what the server is actually doing.
          const header = status.job_name || 'System processing...'

          notice.setMessage(
            `${header}\n` +
              `Progress: ${percent}% (${current}/${total})\n` +
              `📝 ${status.latest_message || 'Analyzing...'}`,
          )
        }

        if (!isBusy) break

        await new Promise((r) => window.setTimeout(r, 1500)) // Polling 1.5s
      } catch {
        // Fix: Use empty catch block to avoid unused variable '_' warning
        errors++
        if (errors > 3) isBusy = false
        await new Promise((r) => window.setTimeout(r, 2000))
      }
    }

    this.updateStatusUI('online')
    notice.setMessage(doneMessage)
    window.setTimeout(() => notice.hide(), 5000)
  }

  /**
   * Poll /documents/pipeline_status until the server is idle. Used to serialize
   * bulk deletes: LightRAG runs one deletion job at a time and drops delete
   * requests received while it's busy, so callers must wait for each batch to
   * drain before sending the next. `onBusy` receives the live status on each
   * poll where the pipeline is busy (for progress UI).
   */
  private async waitForPipelineIdle(
    onBusy?: (status: Record<string, unknown>) => void,
    maxMs = 60 * 60 * 1000,
  ): Promise<void> {
    const start = Date.now()
    // Grace period so we don't read `busy:false` before the job registers.
    await new Promise((r) => window.setTimeout(r, 1500))
    let idleReads = 0
    let errors = 0
    while (Date.now() - start < maxMs) {
      try {
        const response = await requestUrl({
          url: `${this.settings.lightRagServerUrl}/documents/pipeline_status`,
          method: 'GET',
          headers: this.getLightRagHeaders(),
          throw: false,
        })
        const status = response.json as Record<string, unknown>
        if (status.busy) {
          idleReads = 0
          onBusy?.(status)
        } else if (++idleReads >= 2) {
          // Two consecutive idle reads → this batch has finished on the server.
          return
        }
        errors = 0
      } catch {
        if (++errors > 5) return
      }
      await new Promise((r) => window.setTimeout(r, 2000))
    }
  }

  // --- BATCH LOGIC ---
  private getAllSupportedFiles(folder: TFolder): TFile[] {
    let files: TFile[] = []
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (SUPPORTED_EXTENSIONS.includes(child.extension.toLowerCase())) {
          files.push(child)
        }
      } else if (child instanceof TFolder) {
        files = files.concat(this.getAllSupportedFiles(child))
      }
    }
    return files
  }

  async batchIngestFolder(folder: TFolder) {
    const files = this.getAllSupportedFiles(folder).filter(
      (file) => !this.isPathExcludedFromGraph(file.path),
    )
    if (files.length === 0) {
      new Notice('Empty folder or no supported files.')
      return
    }

    const notice = new Notice(
      `📦 Sending ${files.length} files to system...`,
      0,
    )

    try {
      const ragEngine = await this.getRAGEngine()
      let successCount = 0

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext = file.extension.toLowerCase()

        notice.setMessage(
          `📦 Sending (${i + 1}/${files.length}):\n📄 ${file.name}`,
        )

        try {
          let result = false
          if (TEXT_BASED_EXTENSIONS.includes(ext)) {
            const content = await this.app.vault.read(file)
            const finalContent =
              ext === 'md' ? `Title: ${file.basename}\n\n${content}` : content
            result = await ragEngine.insertDocument(finalContent, file.path)
          } else {
            result = await ragEngine.uploadDocument(file)
          }

          if (result) successCount++
          await new Promise((resolve) => window.setTimeout(resolve, 200))
        } catch (err) {
          console.error(`Error processing ${file.name}:`, err)
        }
      }

      notice.setMessage(
        `Uploaded files (${successCount}).\nStart processing...`,
      )
      await this.monitorPipeline(notice)
      void this.refreshIngestedFolderPaths()
    } catch (error) {
      console.error('Batch error:', error)
      notice.setMessage('Error starting upload.')
      window.setTimeout(() => notice.hide(), 5000)
    }
  }

  async refreshIngestedFolderPaths(): Promise<void> {
    try {
      const ragEngine = await this.getRAGEngine()
      const paths = await ragEngine.listAllDocumentPaths()
      const folders = new Set<string>()
      for (const filePath of paths) {
        const normalized = filePath.replace(/\\/g, '/')
        const parts = normalized.split('/')
        for (let i = parts.length - 1; i > 0; i--) {
          folders.add(parts.slice(0, i).join('/'))
        }
      }
      this.ingestedFolderPaths = folders
      this.ingestedFolderPathsLoaded = true
    } catch (e) {
      console.error('refreshIngestedFolderPaths failed:', e)
    }
  }

  private isFolderInGraph(folderPath: string): boolean {
    if (!this.ingestedFolderPathsLoaded) return false
    return this.ingestedFolderPaths.has(folderPath)
  }

  isPathExcludedFromGraph(path: string): boolean {
    return isExcludedFromGraphSync(path, {
      excludePatterns: this.settings.lightRagExcludePatterns,
      excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
    })
  }

  private addGraphExclusionMenuItem(menu: Menu, files: TAbstractFile[]) {
    if (files.length === 0) return

    const patterns = files.map((file) =>
      getExcludePatternForPath(file.path, file instanceof TFolder),
    )
    const current = this.settings.lightRagExcludePatterns
    const allExcluded = patterns.every((p) => current.includes(p))

    menu.addItem((item) => {
      item
        .setTitle(
          allExcluded ? 'Re-include in graph sync' : 'Exclude from graph sync',
        )
        .setIcon(allExcluded ? 'eye' : 'eye-off')
        .onClick(() => {
          if (allExcluded) {
            void this.removeGraphExcludePatterns(patterns)
          } else {
            void this.addGraphExclusionForFiles(files, patterns)
          }
        })
    })
  }

  private async addGraphExclusionForFiles(
    files: TAbstractFile[],
    patterns: string[],
  ) {
    const merged = Array.from(
      new Set([...this.settings.lightRagExcludePatterns, ...patterns]),
    )
    await this.setSettings({
      ...this.settings,
      lightRagExcludePatterns: merged,
    })

    // Collect all TFile instances (expanding folders)
    const targetFiles: TFile[] = []
    for (const file of files) {
      if (file instanceof TFolder) {
        targetFiles.push(...this.getAllSupportedFiles(file))
      } else if (file instanceof TFile) {
        targetFiles.push(file)
      }
    }

    if (targetFiles.length === 0) {
      new Notice('Excluded from graph sync')
      return
    }

    const notice = new Notice('Removing excluded files from graph...', 0)
    try {
      const ragEngine = await this.getRAGEngine()

      // Single pagination pass to build the full id map, then batch-delete.
      // This avoids O(N) full paginations when excluding a folder with many files.
      const idMap = await ragEngine.getDocIdMap()
      const docIds: string[] = []
      for (const file of targetFiles) {
        const id = idMap.get(file.path) ?? idMap.get(file.name)
        if (id) docIds.push(id)
      }

      if (docIds.length > 0) {
        await ragEngine.deleteDocumentsByIds(docIds)
        for (const file of targetFiles) {
          if (idMap.has(file.path) || idMap.has(file.name)) {
            this.docIndexService?.setRemoved(file.path)
          }
        }
      }

      notice.setMessage(
        docIds.length > 0
          ? `Excluded from graph sync (removed ${docIds.length} file${docIds.length === 1 ? '' : 's'} from graph)`
          : 'Excluded from graph sync',
      )
    } catch (error) {
      console.error('Error removing excluded files from graph:', error)
      notice.setMessage('Excluded from graph sync (failed to update graph)')
    } finally {
      window.setTimeout(() => notice.hide(), 4000)
    }
  }

  private async removeGraphExcludePatterns(patterns: string[]) {
    const toRemove = new Set(patterns)
    const remaining = this.settings.lightRagExcludePatterns.filter(
      (p) => !toRemove.has(p),
    )
    await this.setSettings({
      ...this.settings,
      lightRagExcludePatterns: remaining,
    })
    new Notice(
      `Re-included in graph sync. Edit the file to re-ingest it, or use "${CMD_INGEST_FOLDER}".`,
    )
  }

  batchRemoveFolderFromGraph(folder: TFolder) {
    const files = this.getAllSupportedFiles(folder)
    if (files.length === 0) {
      new Notice('Empty folder or no supported files.')
      return
    }

    new ConfirmModal(this.app, {
      title: 'Remove folder from graph',
      message: `Remove ${files.length} file${
        files.length === 1 ? '' : 's'
      } in "${folder.path}" (and its subfolders) from the ${BACKEND_NAME} graph?\n\nThe files themselves stay in the vault.`,
      ctaText: 'Remove',
      onConfirm: () => {
        void this.executeBatchRemoveFolderFromGraph(folder, files)
      },
    }).open()
  }

  private async executeBatchRemoveFolderFromGraph(
    folder: TFolder,
    files: TFile[],
  ) {
    const notice = new Notice(`Removing ${files.length} files from graph...`, 0)
    const syncFolder = this.settings.lightRagSyncFolder.trim()
    const isInWatchedFolder = (path: string) =>
      !!syncFolder && (path === syncFolder || path.startsWith(syncFolder + '/'))

    try {
      const ragEngine = await this.getRAGEngine()

      // Resolve every doc_id in ONE pagination pass (the document list spans
      // multiple pages on large vaults), then delete in batches.
      notice.setMessage('Looking up documents in graph…')
      const idMap = await ragEngine.getDocIdMap()
      const toDelete: { docId: string; path: string }[] = []
      for (const file of files) {
        const docId = idMap.get(file.path) ?? idMap.get(file.name)
        if (docId) toDelete.push({ docId, path: file.path })
      }
      const missing = files.length - toDelete.length
      const tail = missing > 0 ? ` (${missing} not in graph)` : ''

      if (toDelete.length === 0) {
        notice.setMessage(
          missing > 0
            ? `Nothing removed — ${missing} file(s) were not in the graph.`
            : 'Nothing to remove.',
        )
        window.setTimeout(() => notice.hide(), 5000)
        return
      }

      // Delete in chunks, SEQUENTIALLY. LightRAG runs one deletion job at a
      // time and drops delete requests received while it's busy, so firing all
      // chunks at once would only delete the first. We send a chunk, wait for
      // the server pipeline to drain, then send the next. Deletion is also slow
      // (the entity graph is reprocessed per document), so we surface live
      // per-batch progress in the notice.
      const CHUNK = 100
      const totalBatches = Math.ceil(toDelete.length / CHUNK)
      let removed = 0
      for (let b = 0; b < totalBatches; b++) {
        const batch = toDelete.slice(b * CHUNK, b * CHUNK + CHUNK)
        notice.setMessage(
          `Removing from "${folder.path}"${tail}\n` +
            `Batch ${b + 1}/${totalBatches} — sending ${batch.length}…`,
        )
        const ok = await ragEngine.deleteDocumentsByIds(
          batch.map((x) => x.docId),
        )
        if (ok) {
          removed += batch.length
          for (const x of batch) {
            if (isInWatchedFolder(x.path)) {
              this.docIndexService?.setRemoved(x.path)
            }
          }
        }
        this.updateStatusUI('busy')
        await this.waitForPipelineIdle((status) => {
          const cur = (status.cur_batch as number) || 0
          const tot = (status.batchs as number) || batch.length
          const pct = Math.round((cur / Math.max(tot, 1)) * 100)
          notice.setMessage(
            `Removing from "${folder.path}"${tail}\n` +
              `Batch ${b + 1}/${totalBatches} · ${pct}%\n` +
              `📝 ${(status.latest_message as string) || 'Processing…'}`,
          )
        })
      }

      this.updateStatusUI('online')
      notice.setMessage(
        `Removed ${removed} from "${folder.path}"${tail}.\nReopen the graph view to refresh.`,
      )
      window.setTimeout(() => notice.hide(), 6000)
      void this.refreshIngestedFolderPaths()
      this.decorateFileExplorer()
    } catch (error) {
      console.error('Batch remove error:', error)
      notice.setMessage('Error removing files from graph.')
      window.setTimeout(() => notice.hide(), 5000)
    }
  }

  // --- LIFECYCLE & SERVER MANAGEMENT ---

  onunload() {
    this.docIndexReady = false
    this.pendingModifiedFiles.clear()
    window.clearInterval(this.heartbeatInterval)
    this.timeoutIds.forEach((id) => window.clearTimeout(id))
    this.timeoutIds = []
    this.modifyDebounceMap.forEach((id) => window.clearTimeout(id))
    this.modifyDebounceMap.clear()

    if (this.ragEngine) {
      this.ragEngine.cleanup()
      this.ragEngine = null
    }

    // Reset promises so they can be re-initialized if plugin is re-enabled without full reload
    this.dbManagerInitPromise = null
    this.ragEngineInitPromise = null

    if (this.dbManager) {
      // FIX: Use void operator to handle the async cleanup promise
      void this.dbManager.cleanup()
      this.dbManager = null
    }
    if (this.mcpManager) {
      // FIX: Use void operator here too if mcpManager.cleanup() is async
      void this.mcpManager.cleanup()
      this.mcpManager = null
    }
    this.docIndexService?.destroy()
    this.docIndexService = null
    this.fileExplorerDecorator?.clear()
    this.fileExplorerDecorator = null
  }

  /** Apply data-nc-status attributes to files and the watched folder. No DOM injection. */
  private decorateFileExplorer(): void {
    if (!this.fileExplorerDecorator || !this.docIndexService) return
    const syncFolder = this.settings.lightRagSyncFolder.trim()

    // Compute aggregate folder status from ALL files in the sync folder,
    // not just the ones visible in the DOM (avoids false-green on scroll).
    const folderFilePaths = syncFolder
      ? this.app.vault
          .getFiles()
          .filter(
            (f) => f.path === syncFolder || f.path.startsWith(syncFolder + '/'),
          )
          .map((f) => f.path)
      : []
    const folderStatus =
      this.docIndexService.computeFolderStatus(folderFilePaths)

    this.fileExplorerDecorator.decorate(
      syncFolder,
      (path) => this.docIndexService!.getStatus(path),
      folderStatus,
    )
  }

  public async reprocessFailedDocuments(): Promise<void> {
    const url = `${this.settings.lightRagServerUrl}/documents/reprocess_failed`
    try {
      const response = await requestUrl({
        url,
        method: 'POST',
        headers: this.settings.lightRagApiKey
          ? { 'X-API-Key': this.settings.lightRagApiKey }
          : {},
        throw: false,
      })
      if (response.status < 400) {
        new Notice(
          'Re-processing failed documents — check the graph view in a few minutes.',
        )
      } else {
        new Notice(`Reprocess request failed (HTTP ${response.status})`)
      }
    } catch (e) {
      console.error('reprocessFailedDocuments error:', e)
      new Notice('Could not reach the LightRAG server.')
    }
  }

  async loadSettings() {
    this.settings = parseNeuralComposerSettings(await this.loadData())
    await this.saveData(this.settings)
  }

  async setSettings(newSettings: NeuralComposerSettings) {
    const validationResult = NeuralComposerSettingsSchema.safeParse(newSettings)
    if (!validationResult.success) {
      new Notice('Invalid settings')
      return
    }
    this.settings = newSettings
    await this.saveData(newSettings)
    this.ragEngine?.setSettings(newSettings)
    this.settingsChangeListeners.forEach((listener) => listener(newSettings))
  }

  addSettingsChangeListener(
    listener: (newSettings: NeuralComposerSettings) => void,
  ) {
    this.settingsChangeListeners.push(listener)
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  openChatView(openNewChat = false) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (!view || !editor) {
      void this.activateChatView(undefined, openNewChat)
      return
    }
    const selectedBlockData = getMentionableBlockData(editor, view)
    void this.activateChatView(
      { selectedBlock: selectedBlockData ?? undefined },
      openNewChat,
    )
  }

  async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    this.initialChatProps = chatProps
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf
      if (leaf) {
        await leaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true,
        })
      }
    }

    // Ensure leaf exists before accessing view
    leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]

    if (leaf) {
      // FIX: Add await because revealLeaf returns a Promise
      await this.app.workspace.revealLeaf(leaf)

      if (openNewChat && leaf.view instanceof ChatView) {
        leaf.view.openNewChat(chatProps?.selectedBlock)
      }
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({ selectedBlock: data })
      return
    }

    const leaf = leaves[0]
    await this.app.workspace.revealLeaf(leaf)

    if (leaf.view instanceof ChatView) {
      const chatView = leaf.view
      chatView.addSelectionToChat(data)
      chatView.focusMessage()
    }
  }

  // --- BYPASS ---
  getDbManager(): Promise<DatabaseManager> {
    // Changed to return Promise.resolve to satisfy interface without async keyword overhead for mock
    return Promise.resolve({} as DatabaseManager)
  }

  // Fix: Removed 'async' keyword as the method implementation is synchronous
  // wrapping the result in Promises manually to satisfy the interface.
  getRAGEngine(): Promise<RAGEngine> {
    if (this.ragEngine) return Promise.resolve(this.ragEngine)

    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = new Promise<RAGEngine>((resolve, reject) => {
        try {
          this.ragEngine = new RAGEngine(
            this.app,
            this.settings,
            // FIX: Use safe double-casting instead of 'any'
            // We cast to unknown first, then to the expected type.
            {} as unknown as VectorManager,
          )
          resolve(this.ragEngine)
        } catch (error) {
          this.ragEngineInitPromise = null
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
    return this.ragEngineInitPromise
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) return this.mcpManager
    try {
      this.mcpManager = new McpManager({
        settings: this.settings,
        registerSettingsListener: (l) => this.addSettingsChangeListener(l),
      })
      await this.mcpManager.initialize()
      return this.mcpManager
    } catch (error) {
      this.mcpManager = null
      throw error
    }
  }

  // Simple Helper for LLM Call
  async simpleLLMCall(prompt: string): Promise<string> {
    const chatModelId = this.settings.chatModelId
    const modelObj = this.settings.chatModels.find((m) => m.id === chatModelId)
    const provider = this.settings.providers.find(
      (p) => p.id === modelObj?.providerId,
    )

    if (!provider || !modelObj) throw new Error('Model not configured')

    // Gemini Logic
    if (provider.id === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelObj.model}:generateContent?key=${provider.apiKey}`

      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      })

      const data = response.json as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }

    // Generic Fallback (OpenAI/Ollama/Compatible)
    const baseUrl =
      provider.baseUrl ||
      (provider.id === 'openai'
        ? 'https://api.openai.com/v1'
        : 'http://localhost:11434/v1')

    const response = await requestUrl({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey || 'ollama'}`,
      },
      body: JSON.stringify({
        model: modelObj.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })

    const data = response.json as {
      choices?: { message?: { content?: string } }[]
    }
    return data.choices?.[0]?.message?.content || ''
  }

  // --- STATUS BAR LOGIC ---
  private startStatusHeartbeat() {
    // Revisar cada 30 segundos
    this.heartbeatInterval = window.setInterval(() => {
      void this.checkAndUpdateStatus()
    }, 30000)
    // Primera revisión inmediata
    void this.checkAndUpdateStatus()
  }

  private async checkAndUpdateStatus() {
    try {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/health`,
        method: 'GET',
        headers: this.getLightRagHeaders(),
        throw: false,
      })

      if (response.status === 200) {
        const data = response.json as {
          pipeline_busy?: boolean
          core_version?: string
          api_version?: string
        }
        const isBusy = data?.pipeline_busy ?? false
        // Store the server version (core_version is canonical; api_version as fallback)
        this.setServerVersion(data?.core_version ?? data?.api_version ?? null)
        this.updateStatusUI(isBusy ? 'busy' : 'online')
        if (!this.ingestedFolderPathsLoaded) {
          void this.refreshIngestedFolderPaths()
        }
      } else {
        this.setServerVersion(null)
        this.updateStatusUI('offline')
      }
    } catch {
      this.setServerVersion(null)
      this.updateStatusUI('offline')
    }
  }

  private updateStatusUI(status: 'online' | 'offline' | 'busy') {
    if (status === 'online' && this.lastServerStatus !== 'online') {
      // Server just came online — sync statuses and update dots
      void (async () => {
        await this.docIndexService?.syncFromServer()
        this.decorateFileExplorer()
      })()
    }
    this.lastServerStatus = status
    if (!this.statusDotEl) return
    this.statusDotEl.removeClass('is-online', 'is-offline', 'is-busy')

    const versionTag = this.lightRagServerVersion
      ? ` v${this.lightRagServerVersion}`
      : ''
    if (status === 'online') {
      this.statusDotEl.addClass('is-online')
      setTooltip(this.statusBarEl, `LightRAG${versionTag} · Online`, {
        placement: 'top',
      })
    } else if (status === 'busy') {
      this.statusDotEl.addClass('is-busy')
      setTooltip(this.statusBarEl, `LightRAG${versionTag} · Processing…`, {
        placement: 'top',
      })
    } else {
      this.statusDotEl.addClass('is-offline')
      setTooltip(
        this.statusBarEl,
        'LightRAG · Offline (check server connection)',
        {
          placement: 'top',
        },
      )
    }
  }

  private async handleStatusBarClick() {
    new Notice(`Checking ${BACKEND_NAME} server connection...`)
    await this.checkAndUpdateStatus()
  }
}
