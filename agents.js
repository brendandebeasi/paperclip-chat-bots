// Resolve an agent alias -> Paperclip agentId, and manage one chat session per (platform, chat, agent).

// Optional alias synonyms (alias -> [synonyms matched against an agent's urlKey/name]).
// Empty by default: aliases resolve via config.agentAliases (alias -> agentId) first, then
// by matching the alias against each agent's urlKey/name. Populate this only if you want
// extra nicknames (e.g. { ada: ["ada", "ada-cto", "cto"] }) without an explicit id mapping.
const KNOWN_SYNONYMS = {};

export async function resolveAgentId(ctx, cfg, companyId, alias) {
  const a = String(alias).toLowerCase();
  const mapped = cfg.agentAliases?.[a];
  if (mapped) return mapped;
  const syns = KNOWN_SYNONYMS[a] || [a];
  let agents = [];
  try {
    agents = await ctx.agents.list({ companyId });
  } catch (e) {
    ctx.logger.error("agents.list failed", { err: String(e) });
    return null;
  }
  const norm = (s) => String(s || "").toLowerCase();
  const match =
    agents.find((ag) => syns.some((s) => norm(ag.urlKey) === s || norm(ag.name) === s)) ||
    agents.find((ag) => syns.some((s) => norm(ag.urlKey).includes(s) || norm(ag.name).includes(s)));
  return match ? match.id : null;
}

// Reverse: an agent record -> its canonical alias (for delegation-scope checks).
export function aliasForAgent(ag) {
  const hay = `${ag?.urlKey || ""} ${ag?.name || ""}`.toLowerCase();
  for (const [canon, syns] of Object.entries(KNOWN_SYNONYMS)) {
    if (syns.some((s) => hay.includes(s))) return canon;
  }
  return String(ag?.urlKey || ag?.name || "").toLowerCase();
}

function sessKey(platform, chatId, agentId) {
  return {
    scopeKind: "instance",
    namespace: "chat-bots-sessions",
    stateKey: `${platform}:${chatId}:${agentId}`
  };
}

// Reuse an active session for this chat+agent, else create one. Session cache is
// best-effort (ctx.state); if state is unavailable we just create a fresh session.
export async function getOrCreateSession(ctx, platform, chatId, agentId, companyId) {
  const key = sessKey(platform, chatId, agentId);
  let sessionId = null;
  try {
    sessionId = await ctx.state.get(key);
  } catch {
    /* state read unavailable */
  }
  if (sessionId) {
    try {
      const list = await ctx.agents.sessions.list(agentId, companyId);
      if (Array.isArray(list) && list.some((s) => s.sessionId === sessionId && s.status === "active")) {
        return sessionId;
      }
    } catch {
      /* fall through to create */
    }
  }
  const created = await ctx.agents.sessions.create(agentId, companyId, {
    reason: `chat-bots ${platform} chat ${chatId}`
  });
  sessionId = created.sessionId;
  try {
    await ctx.state.set(key, sessionId);
  } catch {
    /* state write unavailable; non-fatal */
  }
  return sessionId;
}
