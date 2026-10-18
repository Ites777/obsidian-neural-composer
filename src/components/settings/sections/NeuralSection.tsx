import { AbstractInputSuggest, App, Platform, Setting, TFolder } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import NeuralComposerPlugin from '../../../main'

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly input: HTMLInputElement

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl)
    this.input = inputEl
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase()
    return this.app.vault
      .getAllFolders(false)
      .filter((f) => f.path.toLowerCase().includes(lower))
      .slice(0, 50)
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path)
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path)
    this.input.dispatchEvent(new Event('input'))
    this.close()
  }
}

export const BACKEND_NAME = 'LightRAG'
export const TWO_D = '2D'
export const THREE_D = '3D'
export const GRAPH_UNIT = 'GPU'
export const YOUR_SERVER = 'http://your-server:9621'

export const NeuralSection = ({ plugin }: { plugin: NeuralComposerPlugin }) => {
  const settingsRef = useRef<HTMLDivElement>(null)

  const [settings, setLocalSettings] = useState(plugin.settings)

  /**
   * Server info state — { version, checked }
   *   checked=false → first health check hasn't run yet → hide badge
   *   checked=true, version=null → offline → red "offline" badge
   *   checked=true, version='1.4.16' → online → green version badge
   */
  const [serverInfo, setServerInfo] = useState<{
    version: string | null
    checked: boolean
  }>(() => ({
    version: plugin.lightRagServerVersion,
    checked: plugin.lightRagServerChecked,
  }))

  useEffect(() => {
    return plugin.addSettingsChangeListener(setLocalSettings)
  }, [plugin])

  // Subscribe to server version/status changes (populated by checkAndUpdateStatus)
  useEffect(() => {
    return plugin.addVersionChangeListener(setServerInfo)
  }, [plugin])

  useEffect(() => {
    if (!settingsRef.current) return
    settingsRef.current.empty()
    const container = settingsRef.current

    // All text inputs use blur-based saving: the DOM is only rebuilt when the
    // user finishes editing a field (focus leaves), never while they are still
    // typing. This prevents the settings-change listener from triggering a
    // useEffect re-run (and container.empty()) mid-keystroke on any platform.

    // Header row: title + version badge side by side
    const headerRow = container.createDiv({ cls: 'nc-server-header-row' })
    headerRow.createEl('h3', { text: `Neural backend (${BACKEND_NAME})` })
    // Version badge — updated reactively by the separate useEffect below.
    // data-nc-version acts as a stable selector so the reactive effect can
    // find and update this element without rebuilding the whole DOM.
    const versionBadge = headerRow.createSpan({
      cls: 'nc-version-badge',
      attr: { 'data-nc-version': '' },
    })
    // Render initial state (before the reactive effect runs)
    if (plugin.lightRagServerChecked) {
      if (plugin.lightRagServerVersion) {
        versionBadge.textContent = `v${plugin.lightRagServerVersion}`
        versionBadge.addClass('nc-version-badge--online')
      } else {
        versionBadge.textContent = 'Offline'
        versionBadge.addClass('nc-version-badge--offline')
      }
    }

    container.createEl('p', {
      text: 'Connect to an independently managed LightRAG server. This plugin does not start, stop, or configure the server.',
      cls: 'setting-item-description',
    })

    // On non-desktop the Setting layout is horizontal (info left, control right),
    // which leaves text inputs too narrow. stacked() flips to column so the
    // control sits below the description at full width.
    const stacked = (s: Setting) => {
      if (!Platform.isDesktop) s.settingEl.addClass('nrlcmp-setting-stacked')
      return s
    }

    stacked(
      new Setting(container)
        .setName('Server URL')
        .setDesc(
          'Base URL of your LightRAG server (e.g., http://localhost:9621).',
        )
        .addText((text) => {
          text
            .setPlaceholder(`${YOUR_SERVER}`)
            .setValue(plugin.settings.lightRagServerUrl)
          text.inputEl.addEventListener('blur', () => {
            void plugin.setSettings({
              ...plugin.settings,
              lightRagServerUrl: text.getValue(),
            })
          })
        }),
    )

    stacked(
      new Setting(container)
        .setName('API key')
        .setDesc('Optional authentication key for the server.')
        .addText((text) => {
          text
            .setPlaceholder('Leave empty if not required')
            .setValue(plugin.settings.lightRagApiKey)
          text.inputEl.addEventListener('blur', () => {
            void plugin.setSettings({
              ...plugin.settings,
              lightRagApiKey: text.getValue(),
            })
          })
        }),
    )

    // 5. Citations
    new Setting(container)
      .setName('Show citations in chat')
      .setDesc(
        'If enabled, the AI will add footnotes like [1] linking to sources.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.settings.lightRagShowCitations)
          .onChange((value) => {
            void plugin.setSettings({
              ...plugin.settings,
              lightRagShowCitations: value,
            })
          }),
      )

    // --- INCREMENTAL SYNC ---
    container.createEl('h4', { text: 'Vault sync' })

    stacked(
      new Setting(container)
        .setName('Watched folder')
        .setDesc(
          'Vault-relative folder to watch for changes. ' +
            'When set, deleting or renaming a note removes it from the graph automatically, ' +
            'and saving a note re-indexes it after 5 s of inactivity. ' +
            'Leave empty to disable. Only files you have previously ingested are affected.',
        )
        .addText((text) => {
          text
            .setPlaceholder('e.g. Main/Knowledge')
            .setValue(plugin.settings.lightRagSyncFolder)
          text.inputEl.addEventListener('blur', () => {
            void plugin.setSettings({
              ...plugin.settings,
              lightRagSyncFolder: text.getValue(),
            })
          })
          new FolderSuggest(plugin.app, text.inputEl)
        }),
    )

    new Setting(container)
      .setName('Exclude hidden files and folders')
      .setDesc(
        'When enabled, files and folders whose name starts with a dot ' +
          '(e.g. ".trash", ".git") are never ingested into the graph.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.settings.lightRagExcludeHiddenFiles)
          .onChange((value) => {
            void plugin.setSettings({
              ...plugin.settings,
              lightRagExcludeHiddenFiles: value,
            })
          }),
      )

    stacked(
      new Setting(container)
        .setName('Exclude patterns')
        .setDesc(
          'Glob patterns (one per line) for vault paths that should never be ' +
            'ingested into the graph. Patterns are vault-relative ' +
            '(e.g. "Main/Templates/**"). ' +
            'You can also right-click a file or folder and choose "Exclude from graph sync".',
        )
        .addTextArea((textArea) => {
          textArea
            .setPlaceholder('Main/Templates/**\nMain/Inbox/scratch.md')
            .setValue(plugin.settings.lightRagExcludePatterns.join('\n'))
          textArea.inputEl.addEventListener('blur', () => {
            const patterns = textArea
              .getValue()
              .split('\n')
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
            void plugin.setSettings({
              ...plugin.settings,
              lightRagExcludePatterns: patterns,
            })
          })
          textArea.inputEl.rows = 4
          textArea.inputEl.setCssStyles({ width: '100%' })
        }),
    )

    // VISUALIZATION
    container.createEl('h4', { text: 'Visualization' })

    new Setting(container)
      .setName('Graph rendering engine')
      .setDesc(
        `Choose ${TWO_D} for performance/clarity or ${THREE_D} for immersion (requires ${GRAPH_UNIT}).`,
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('2d', `${TWO_D} - Fast & clean`)
        dropdown.addOption('3d', `${THREE_D} - Immersive - uses ${GRAPH_UNIT}`)
        dropdown.setValue(plugin.settings.graphViewMode)
        dropdown.onChange((value) => {
          // Removed async
          void plugin.setSettings({
            ...plugin.settings,
            graphViewMode: value as '2d' | '3d',
          })
        })
      })
  }, [settings, plugin])

  // Reactively update the version badge on every server info change
  // without rebuilding the entire DOM (no focus loss, no flicker).
  useEffect(() => {
    const badge =
      settingsRef.current?.querySelector<HTMLElement>('[data-nc-version]')
    if (!badge) return

    const { version, checked } = serverInfo

    // Reset all state classes first
    badge.classList.remove(
      'nc-version-badge--online',
      'nc-version-badge--offline',
    )

    if (!checked) {
      // Health check hasn't run yet — hide badge completely
      badge.textContent = ''
    } else if (version) {
      // Online with detected version
      badge.textContent = `v${version}`
      badge.classList.add('nc-version-badge--online')
    } else {
      // Checked and server is offline
      badge.textContent = 'Offline'
      badge.classList.add('nc-version-badge--offline')
    }
  }, [serverInfo])

  return <div ref={settingsRef} />
}
