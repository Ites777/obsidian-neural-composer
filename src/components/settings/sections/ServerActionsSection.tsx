export function ServerActionsSection() {
  return (
    <div className="nrlcmp-settings-section">
      <div className="nrlcmp-settings-header">LightRAG server</div>
      <p>
        LightRAG runs independently of Obsidian. Configure its models,
        embeddings, parsing, reranking, and environment variables on the server.
        Start, stop, and restart it through your deployment tools.
      </p>
      <p>
        Set the server URL and optional API key under Graph &amp; Vault. Closing
        Obsidian or disabling this plugin leaves the server running.
      </p>
    </div>
  )
}
