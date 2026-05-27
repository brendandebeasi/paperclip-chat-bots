// Static plugin manifest, read by the host BEFORE the worker runs.
// Capability names verified against the in-image SDK + paperclip-plugin-telegram manifest.
export default {
  id: "paperclip-plugin-chat-bots",
  apiVersion: 1,
  version: "0.4.2",
  displayName: "Chat Bots",
  description:
    "Platform-agnostic chat bots (Telegram + WhatsApp) with per-user -> per-agent routing rules. " +
    "Inbound chat routes to agent sessions; outbound issue/approval notifications. " +
    "Supports DM / group / group+thread and @mentions.",
  author: "paperclip-chat-bots contributors",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    // NOTE: do NOT declare "issue.interactions.create" — declaring it makes the host fail
    // worker activation ("Worker process exited code=0"). The interactions relay only
    // *subscribes* to the issue.interactions.create EVENT (covered by events.subscribe) and
    // answers via the board API (http.outbound); it never calls issues.createInteraction.
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref"
  ],
  entrypoints: { worker: "./worker.js" },
  // Permissive schema so config can be set via the board API. The real shape is
  // documented in config.js / README.md.
  instanceConfigSchema: {
    type: "object",
    additionalProperties: true,
    // NOTE: the host strips top-level keys NOT declared here (despite additionalProperties),
    // so every persisted config key must be listed.
    properties: {
      telegram: { type: "object", additionalProperties: true },
      whatsapp: { type: "object", additionalProperties: true },
      rules: { type: "object", additionalProperties: true },
      notify: { type: "object", additionalProperties: true },
      board: { type: "object", additionalProperties: true },
      llm: { type: "object", additionalProperties: true },
      escalate: { type: "object", additionalProperties: true },
      agentAliases: { type: "object", additionalProperties: true },
      companyId: { type: "string" },
      paperclipPublicUrl: { type: "string" },
      maxReplyChars: { type: "number" },
      replyTimeoutMs: { type: "number" }
    }
  }
};
