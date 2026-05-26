// The routing / access-control rule engine. Default-deny, per-user -> per-agent.
// "agents" is a list of agent aliases the user may address, or ["*"] for all.

export function userPolicy(cfg, userId) {
  const u = cfg.rules.users?.[String(userId)];
  return u && typeof u === "object" ? u : null;
}

export function allowedAgents(policy) {
  if (!policy || !Array.isArray(policy.agents)) return [];
  return policy.agents;
}

export function canUseAgent(policy, alias) {
  if (!policy || !alias) return false;
  const a = allowedAgents(policy).map((x) => String(x).toLowerCase());
  return a.includes("*") || a.includes(String(alias).toLowerCase());
}

// Extract a leading/embedded @alias from the message text, if any.
export function parseMention(text) {
  const m = /(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]*)/.exec(String(text || ""));
  return m ? m[1].toLowerCase() : null;
}

// Decide which agent alias an inbound message targets, honoring the user's policy.
// Returns { alias } on success, or { error } describing why not.
export function pickAgentAlias(cfg, policy, text) {
  if (!policy) return { error: "unauthorized" };
  const mentioned = parseMention(text);
  if (mentioned) {
    if (!canUseAgent(policy, mentioned)) return { error: "forbidden_agent", alias: mentioned };
    return { alias: mentioned };
  }
  const allowed = allowedAgents(policy).filter((x) => x !== "*");
  // Exactly one specific allowed agent -> use it (e.g. a user allowed only @support).
  if (allowed.length === 1) return { alias: String(allowed[0]).toLowerCase() };
  // Fall back to the configured default agent if the user may use it.
  if (cfg.rules.defaultAgent && canUseAgent(policy, cfg.rules.defaultAgent)) {
    return { alias: String(cfg.rules.defaultAgent).toLowerCase() };
  }
  return { error: "ambiguous" };
}

// Strip the addressing @alias from the prompt so the agent doesn't see it.
export function stripMention(text, alias) {
  if (!alias) return String(text || "").trim();
  return String(text || "")
    .replace(new RegExp("(?:^|\\s)@" + alias + "\\b", "i"), " ")
    .trim() || String(text || "").trim();
}
