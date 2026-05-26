// Parse the raw operator config (ctx.config.get()) into a typed-ish shape with defaults.
//
// Telegram is ONE BOT PER AGENT: each bot is bound to an agent, so DMing that bot talks
// to that agent directly (no in-message @mention needed). Access is still gated by rules.
//
// Config shape (set via POST /api/plugins/:id/config -> {configJson}).
// See config.example.jsonc for a fuller, commented example. Sketch:
// {
//   telegram: {
//     enabled: true,
//     bots: [
//       { agent: "support", botTokenFile: "/paperclip/.paperclip/chat-bots/tg-token-support" },
//       { agent: "eng",     botTokenFile: "/paperclip/.paperclip/chat-bots/tg-token-eng" }
//     ],
//     pollIntervalMs: 1500, drainOnStart: true
//   },
//   agentAliases: { support: "<agentId>", ... },  // optional; else resolved by name/urlKey
//   rules: {
//     defaultDeny: true, defaultAgent: "support",
//     users: {
//       "<telegramUserId>": { name: "Owner",     agents: ["*"] },
//       "<telegramUserId>": { name: "Teammate",  agents: ["support"] }
//     }
//   },
//   notify: { defaultChatId: "<telegramChatId>", agent: "support", onApproval: true, onIssueCreated: false }
// }
export function parseConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const tg = c.telegram && typeof c.telegram === "object" ? c.telegram : {};
  const wa = c.whatsapp && typeof c.whatsapp === "object" ? c.whatsapp : {};
  const rules = c.rules && typeof c.rules === "object" ? c.rules : {};
  const notify = c.notify && typeof c.notify === "object" ? c.notify : {};
  const board = c.board && typeof c.board === "object" ? c.board : {};
  const llm = c.llm && typeof c.llm === "object" ? c.llm : {};
  const escalate = c.escalate && typeof c.escalate === "object" ? c.escalate : {};

  // Bots list; fall back to a legacy single-bot shape if present.
  let bots = Array.isArray(tg.bots) ? tg.bots : [];
  if (!bots.length && (tg.botTokenFile || tg.botTokenEnv || tg.botTokenRef || c.telegramBotTokenRef)) {
    bots = [
      {
        agent: tg.agent ?? null,
        botTokenFile: tg.botTokenFile ?? null,
        botTokenEnv: tg.botTokenEnv ?? null,
        botTokenRef: tg.botTokenRef ?? c.telegramBotTokenRef ?? null
      }
    ];
  }

  return {
    telegram: {
      enabled: tg.enabled ?? bots.length > 0,
      bots: bots.map((b) => ({
        agent: b.agent ? String(b.agent).toLowerCase() : null,
        botTokenFile: b.botTokenFile ?? null,
        botTokenEnv: b.botTokenEnv ?? null,
        botTokenRef: b.botTokenRef ?? null
      })),
      // Short-poll: the host's ctx.http.fetch aborts a long getUpdates hold, so poll
      // with timeout=0 and pace with pollIntervalMs.
      pollTimeoutSec: Number(tg.pollTimeoutSec ?? 0),
      pollIntervalMs: Number(tg.pollIntervalMs ?? 1500),
      // On first start (no persisted offset) skip any backlog so old/stale messages
      // don't wake agents.
      drainOnStart: tg.drainOnStart ?? true
    },
    whatsapp: {
      enabled: wa.enabled ?? false,
      sessionDir: wa.sessionDir ?? "/paperclip/.paperclip/chat-bots/wa-session"
    },
    agentAliases: c.agentAliases && typeof c.agentAliases === "object" ? c.agentAliases : {},
    rules: {
      defaultDeny: rules.defaultDeny ?? true,
      defaultAgent: rules.defaultAgent ?? null,
      users: rules.users && typeof rules.users === "object" ? rules.users : {}
    },
    notify: {
      defaultChatId: notify.defaultChatId ?? null,
      approvalsChatId: notify.approvalsChatId ?? notify.defaultChatId ?? null,
      agent: notify.agent ? String(notify.agent).toLowerCase() : null,
      onIssueCreated: notify.onIssueCreated ?? false,
      onApproval: notify.onApproval ?? true
    },
    replyTimeoutMs: Number(c.replyTimeoutMs ?? 180000),
    // Resolved once (avoids companies.list from the background loop, which lacks an
    // ambient invocation scope; company-scoped calls derive scope from params.companyId).
    companyId: c.companyId ?? null,
    // Public Paperclip URL, used to build "open full reply" links on truncated messages.
    // Leave null to skip the link (e.g. https://paperclip.example.com).
    paperclipPublicUrl: c.paperclipPublicUrl ?? null,
    // Verbose replies are truncated to this and linked to the full Paperclip thread.
    maxReplyChars: Number(c.maxReplyChars ?? 900),
    // Board API access for the follow-up-question relay (submitting interaction answers).
    // apiBase MUST be the canonical host URL — the loopback enforces a hostname allowlist and
    // fetch() can't set Host; defaults to paperclipPublicUrl. Key via file/env/secret-ref.
    board: {
      keyFile: board.keyFile ?? null,
      keyEnv: board.keyEnv ?? null,
      keyRef: board.keyRef ?? null,
      apiBase: board.apiBase ?? c.paperclipPublicUrl ?? null
    },
    // Cheap direct-chat backend (OpenAI-compatible). When enabled, inbound messages are
    // answered by a direct model call (NO issue, NO agent run); escalation creates an issue.
    // Key via file/env/secret-ref (the worker has a stripped env — prefer apiKeyFile).
    llm: {
      enabled: llm.enabled ?? false,
      baseUrl: llm.baseUrl ?? "https://api.fireworks.ai/inference/v1",
      model: llm.model ?? null, // e.g. "accounts/fireworks/models/kimi-k2p6"
      apiKeyFile: llm.apiKeyFile ?? null,
      apiKeyEnv: llm.apiKeyEnv ?? null,
      apiKeyRef: llm.apiKeyRef ?? null,
      maxTokens: Number(llm.maxTokens ?? 1024),
      temperature: Number(llm.temperature ?? 0.7),
      historyTurns: Number(llm.historyTurns ?? 10),
      systemPrompt: typeof llm.systemPrompt === "string" ? llm.systemPrompt : null,
      // Per-agent-alias persona system prompts (alias -> prompt). Falls back to systemPrompt.
      personas: llm.personas && typeof llm.personas === "object" ? llm.personas : {}
    },
    // Escalation: messages starting with one of these commands create a tracked issue routed
    // to the resolved agent (full agent w/ tools/skills) instead of a direct chat reply.
    escalate: {
      commands:
        Array.isArray(escalate.commands) && escalate.commands.length
          ? escalate.commands.map((s) => String(s).toLowerCase())
          : ["/task", "/issue"]
    }
  };
}
