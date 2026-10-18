# Neural Composer

> **KnowledgeHub fork:** LightRAG runs as an independent service. This plugin only connects to its API; it does not start, stop, restart, or write configuration files for the server. The upstream managed-server instructions below do not apply to this fork.

**Graph-based AI chat for your Obsidian vault.**

![Hero Banner](https://raw.githubusercontent.com/oscampo/obsidian-neural-composer/main/images/hero-banner.GIF)

[![Release](https://img.shields.io/github/v/release/oscampo/obsidian-neural-composer?style=flat-square&color=6c47ff)](https://github.com/oscampo/obsidian-neural-composer/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md/plugins?id=neural-composer)

---

## TL;DR

Chat with your vault using a **Knowledge Graph**, not just keyword search. Neural Composer runs a local [LightRAG](https://github.com/HKUDS/LightRAG) server, builds a graph of your notes, and lets you ask questions that trace connections across your entire vault.

- 🔍 **Finds relationships**, not just matching words
- ⚡ **Manages the LightRAG server** for you — no terminal juggling
- 🔒 **100% local** when used with Ollama — your data never leaves your machine

**Requirements:** Python 3.10+ · `pip install "lightrag-hku[api]"` · Obsidian 1.7.2+

---

## Features

| | |
|---|---|
| **⚡ Automated Server** | Starts and stops the LightRAG Python process automatically. No terminal needed. |
| **🧠 Graph + Vector Search** | Combines entity-relationship traversal with semantic vector search for deep, contextual answers. |
| **📂 Vault Sync** | Set a watched folder — notes are re-indexed on save. Status dots in the file explorer show each note's graph state: 🟢 processed · 🟡 processing · 🔴 failed · 🔵 removed. |
| **📊 Knowledge Graph View** | Explore your graph visually in 2D or 3D. Overview mode renders all nodes; Explore mode does a BFS walk from any entity. |
| **🌐 Remote Server** | Connect to a LightRAG instance on a NAS, VPS, or Docker container. |
| **🤖 MCP Tools** | Expose your graph to any MCP-compatible client (Claude Desktop, etc.). |
| **🔍 Source Transparency** | Every answer includes citations `[1]` linked to the exact notes and text chunks that were used. |
| **🔒 Local & Private** | Use Ollama for a fully offline setup, or any hosted provider you prefer. |

<details>
<summary>Complete list of supported file formats</summary>

`md` `txt` `docx` `pdf` `pptx` `xlsx` `rtf` `odt` `epub` `html` `htm` `xml` `json` `yaml` `yml` `csv` `tex` `log` `conf` `ini` `properties` `sql` `bat` `sh` `c` `cpp` `py` `java` `js` `ts` `swift` `go` `rb` `php` `css` `scss` `less`

</details>

---

## Why Graph RAG?

Standard vector search finds *similar text*. Graph RAG finds *connected ideas*.

| | Standard Vector Search | Neural Composer (Graph RAG) |
|:---|:---|:---|
| **How it works** | Finds chunks that match your query semantically | Traverses relationships between entities in your notes |
| **Best for** | "What is X?" | "How does X influence Y across my research?" |
| **Context quality** | Often fragmented | Holistic — sees the whole picture |
| **Multi-hop reasoning** | ✗ | ✓ |

---

## Getting Started

> 📖 Full documentation on the [Wiki](https://github.com/oscampo/obsidian-neural-composer/wiki)

### 1. Install the LightRAG backend

```bash
# Recommended: use a virtual environment
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install "lightrag-hku[api]"
```

Then find the path to the installed executable (you'll need it in Step 3):

```bash
which lightrag-server        # macOS / Linux
where.exe lightrag-server    # Windows
```

### 2. Install the Plugin

Search for **"Neural Composer"** in **Settings → Community Plugins → Browse** and enable it.

### 3. Connect & Configure

Open **Settings → Neural Composer**. The panel has a sidebar with seven tabs:

1. **Providers** — add your API keys (OpenAI, Anthropic, Gemini, Groq, Ollama, etc.)
2. **Models** — select your chat, apply, and embedding models
3. **Graph & Vault** — set the `lightrag-server` path, choose a data directory, and optionally configure a **Watched Folder** for auto-sync
4. Toggle **Auto-start** on, then click **Restart Server**

A green dot in the status bar confirms the server is running. Right-click any folder in your vault to ingest notes and start chatting.

---

<details>
<summary>🛠️ Use Cases</summary>

- **Researchers** — synthesize arguments across hundreds of papers, surface consensus and contradictions that keyword search misses.
- **Writers & Game Masters** — track relationships between characters and lore; keep your world internally consistent without digging through folders.
- **Journalers** — connect entries from months ago to today, spotting patterns that aren't visible day-to-day.
- **Project Managers** — visualize dependencies between project notes that otherwise look like separate tasks.

</details>

<details>
<summary>🧩 Advanced Options</summary>

| Feature | Where to configure |
|:---|:---|
| **Watched Folder** | Settings → Graph & Vault → Watched folder |
| **Remote Server** | Settings → Graph & Vault → Use remote server |
| **Custom Ontology** | Settings → Graph & Vault → Ontology section — teach the graph domain-specific entity types (e.g. "Experiment", "Theorem") |
| **Reranking** | Settings → Graph & Vault → Reranking — Jina AI, Cohere, or a custom local endpoint |
| **MCP Servers** | Settings → Tools (MCP) |
| **Graph Visualization** | Settings → Graph & Vault → Graph rendering engine — 2D (fast) or 3D (immersive) |
| **Performance Tuning** | Settings → Advanced — chunk size, overlap, async workers |
| **Custom `.env` overrides** | Settings → Advanced — raw `.env` editor with full LightRAG configuration access |

</details>

<details>
<summary>🔒 Privacy & Security</summary>

Neural Composer is designed with privacy as a core principle.

### What leaves your machine

| Destination | When | Why |
|:---|:---|:---|
| **Your AI provider** (OpenAI, Anthropic, Gemini, Groq, etc.) | Every chat message or ingestion | To generate responses and embeddings. Only notes you explicitly ingest or attach are sent. |
| **Your local LightRAG server** (`localhost`) | Every query and ingestion | The plugin talks to a Python process on your own machine. No data leaves. |
| **Your remote LightRAG server** | Only if you configure a remote URL | Off by default. Opt-in only. |

**Using Ollama + local LightRAG = zero data leaves your machine.**

### What never happens

- The plugin does **not** send telemetry, analytics, or crash reports.
- The plugin does **not** contact `github.com` or any external domain at runtime. Links in the UI are navigation-only — never fetched programmatically.
- API keys are stored **only** in Obsidian's own `data.json` in your local vault.

### System-level access disclosures

<details>
<summary>Why the Obsidian scanner flags certain capabilities</summary>

| Capability | Reason |
|:---|:---|
| **`fs` (filesystem)** | Writes the LightRAG `.env` config file to your chosen work directory, which may be outside the vault. |
| **`child_process` (shell)** | Starts and stops the local LightRAG Python server. The command is always the exact path you configure — no user input is interpolated into shell arguments. |
| **Vault enumeration** | Lists file paths for ingestion and the search index. File content is only read when you explicitly ingest a file. |
| **Clipboard** | Inherited from the Lexical rich-text editor in the chat input. Standard paste operations only. |
| **`atob`/`btoa` (Base64)** | Used by bundled deps: `@modelcontextprotocol/sdk` decodes JWT tokens for MCP OAuth; `sigma`/`three-forcegraph` encode WebGL shader data. No sensitive data is encoded this way. |
| **`new Function`** | Used by two bundled libraries: `ngraph.forcelayout` (3D physics) and `ajv` (JSON schema validation via MCP SDK). Neither executes user-provided code. |

</details>
</details>

<details>
<summary>📋 Changelog</summary>

### v1.4.0 — 2026-05-27
- **Mobile support (iOS / Android)** — plugin loads on Obsidian mobile and chats against a remote LightRAG server over HTTP. `lightRagUseRemote` is forced on, local-server management settings are hidden, and the bundle ships an `events` polyfill plus a `require` shim so node-only deps don't abort module evaluation on a non-Electron webview.
- **Graph view on mobile** — the "desktop-only" notice is gone; the view renders via the same `/graphs` HTTP endpoints. A right-anchored sidebar slides in/out via a new toolbar button and an `x` next to the "Node manager" title. Node sizes shrunk for narrow viewports. Newer LightRAG versions (≥1.4) now use the `file_path` property sent on each node, so the local `kv_store_*.json` reads aren't needed for citation filenames on either platform.
- **Fix:** `AbstractJsonRepository.ensureDirectory()` was fire-and-forget — on Android `adapter.list()` raced ahead of `mkdir` and crashed the template list. Every public method now awaits a shared directory-ready promise.

### v1.3.1 — 2026-05-25
- Fix: removed all `!important` CSS declarations — replaced with higher-specificity selectors to comply with the Obsidian plugin linter.

### v1.3.0 — 2026-05-24
- **Settings UI redesign** — new sidebar navigation with 7 tabs: Providers, Models, Chat, Graph & Vault, Tools (MCP), Advanced, Help.
- **Document status tracking** — colored dots in the file explorer for each note (🟢 processed, 🟡 processing, 🔴 failed, 🔵 removed). Watched folder shows an aggregate status dot.
- **LightRAG version detection** — the server version is displayed as a badge in Settings → Graph & Vault.
- **Watched folder sync** — notes are automatically re-indexed on save with a 5-second debounce.
- **"Remove from graph" action** — right-click context menu lets you remove individual notes from the graph without deleting the file.
- **Tooltip improvements** — status bar tooltip correctly distinguishes local vs. remote server offline state.

### v1.2.3 — 2026-05-22
- Fix: correct LightRAG provider config for OpenRouter and Ollama (LLM\_BINDING\_HOST was missing, causing 401 errors).
- Fix: expose active embedding model selector in settings UI.
- Add: "Reprocess failed documents" button in Graph & Vault settings.
- Fix: stop server now correctly kills orphaned processes on macOS/Linux via port lookup.

### v1.2.1 — 2026-05-20
- **Knowledge Graph Visualization** — 2D and 3D interactive graph view inside Obsidian.
- Overview mode (all nodes) and Explore mode (BFS from a selected entity).
- Real relevance scores for cited references (citation-frequency formula).
- Improved "Context used" panel — shows scores, snippets, and click-to-open for `.md` files.
- Fix: single-click on isolated nodes now auto-explores and shows full entity details.

### v1.2.0 — 2026-05-17
- Initial public release on the Obsidian Community Plugin marketplace.
- Local LightRAG server management (auto-start, restart, stop).
- Right-click folder ingestion with multi-format support.
- Chat with graph RAG, hybrid query modes, Jina/Cohere reranking.
- Custom ontology (entity types) and `.env` editor.

</details>

---

Built on the shoulders of giants:
- Forked from **[Smart Composer](https://github.com/glowingjade/obsidian-smart-composer)** by glowingjade
- Powered by **[LightRAG](https://github.com/HKUDS/LightRAG)**
- Developed by **Oscar Campo** & **Cora** (AI)
- Mobile support (iOS / Android, remote LightRAG) by **[Arseniy Seroka (jagajaga)](https://github.com/jagajaga)**
