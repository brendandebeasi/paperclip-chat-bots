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

// Per-bot DM gate (on top of rules.users membership). No allowUsers list => allow anyone the
// global rules already authorized; ["*"] => everyone; else only the listed Telegram user ids.
export function botAllowsUser(bot, userId) {
  const list = bot && Array.isArray(bot.allowUsers) ? bot.allowUsers.map(String) : null;
  if (!list || !list.length) return true;
  return list.includes("*") || list.includes(String(userId));
}

// The agents a user can actually reach THROUGH a given bot = (what the bot offers) ∩ (user scope).
// direct bots offer only their bound agent; concierge bots offer their `roster` (or all llm.agents).
// Returns [{ alias, role }] using the role blurbs in cfg.llm.agents (for the router's topic pick).
export function effectiveRoster(cfg, bot, policy) {
  const agents = (cfg.llm && cfg.llm.agents) || {};
  const offered =
    bot && bot.mode === "direct"
      ? (bot.agent ? [bot.agent] : [])
      : (Array.isArray(bot?.roster) && bot.roster.length ? bot.roster : Object.keys(agents)).map((a) => String(a).toLowerCase());
  const allowed = allowedAgents(policy).map((a) => String(a).toLowerCase());
  const all = allowed.includes("*");
  return offered
    .filter((a) => all || allowed.includes(a))
    .map((a) => ({ alias: a, role: String(agents[a] || a) }));
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
