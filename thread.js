// Per-chat conversation thread. Maps a chat to its active Paperclip issue so follow-up messages
// CONTINUE the same issue (the assigned agent resumes with full thread context) instead of
// spawning a fresh issue each time. The user's follow-up is posted as an issue COMMENT via the
// board API (lands as authorType:"user"); the agent's reply comes back as an authorType:"agent"
// comment, forwarded to chat by worker.js. The concierge bot owns the conversation; which
// specialist is behind a given thread is never surfaced to the user.

const ACTIVE_NS = "chat-bots-active-thread"; // ctx.state: `${platform}:${botKey}:${chatId}` -> { issueId, agent }

// Keyed by botKey too: a Telegram private chatId equals the user id across ALL bots, so omitting
// botKey would collide every bot's thread for the same user in a multi-bot deploy.
function activeKey(platform, botKey, chatId) {
  return { scopeKind: "instance", namespace: ACTIVE_NS, stateKey: `${platform}:${botKey}:${chatId}` };
}

// Statuses a prior issue can't be resumed from -> drop the pointer and start a fresh thread.
const DEAD_STATUS = new Set(["cancelled", "archived"]);
// Statuses where the agent is already running -> post the comment but don't re-trigger a run.
const RUNNING_STATUS = new Set(["running", "in_progress"]);

// IMPORTANT: issue mutations/reads here run in the Telegram poll-loop context, which has NO host
// invocation scope — so ctx.issues.update/get throw "not allowed ... missing invocation scope".
// We go through the board API (unscoped admin REST, same path as the comment/interaction relay),
// falling back to the SDK only if no board key is configured.

// Set an issue's status. Returns true on success.
export async function setIssueStatus(ctx, boardApi, companyId, issueId, status) {
  if (boardApi) {
    try {
      const res = await boardApi("PATCH", `/api/issues/${issueId}`, { status });
      if (res && (res.ok === true || (typeof res.status === "number" && res.status >= 200 && res.status < 300))) return true;
    } catch { /* fall through to SDK */ }
  }
  try { await ctx.issues.update(issueId, { status }, companyId); return true; } catch { return false; }
}

// Fetch an issue (for the resumability check). Returns the issue object or null.
async function fetchIssue(ctx, boardApi, companyId, issueId) {
  if (boardApi) {
    try {
      const res = await boardApi("GET", `/api/issues/${issueId}`);
      if (res && res.ok !== false) { const j = await res.json().catch(() => null); if (j && j.id) return j; }
      return null;
    } catch { /* fall through to SDK */ }
  }
  try { return await ctx.issues.get(issueId, companyId); } catch { return null; }
}

// Resolve the chat's active thread, verifying the issue still exists and is resumable.
// Returns { issueId, agent, status, title } or null (and clears a dead/missing pointer).
export async function getActiveThread(ctx, boardApi, platform, botKey, chatId, companyId) {
  let rec = null;
  try { rec = await ctx.state.get(activeKey(platform, botKey, chatId)); } catch { /* ignore */ }
  if (!rec || !rec.issueId) return null;
  const issue = await fetchIssue(ctx, boardApi, companyId, rec.issueId);
  if (!issue || DEAD_STATUS.has(String(issue.status))) {
    await clearActiveThread(ctx, platform, botKey, chatId);
    return null;
  }
  return { issueId: rec.issueId, agent: rec.agent || null, status: String(issue.status || ""), title: issue.title || "" };
}

export async function setActiveThread(ctx, platform, botKey, chatId, issueId, agent) {
  try { await ctx.state.set(activeKey(platform, botKey, chatId), { issueId, agent: agent || null }); } catch { /* non-fatal */ }
}

// Clear by writing {} — value_json is NOT NULL, so we can't store null.
export async function clearActiveThread(ctx, platform, botKey, chatId) {
  try { await ctx.state.set(activeKey(platform, botKey, chatId), {}); } catch { /* non-fatal */ }
}

// Post the user's message as a comment on the active issue, then re-trigger the assigned agent
// (status -> todo) unless it's already running. Returns true on success.
export async function continueThread(ctx, boardApi, companyId, thread, text) {
  if (!boardApi || !thread?.issueId) return false;
  let ok = false;
  try {
    const res = await boardApi("POST", `/api/issues/${thread.issueId}/comments`, { body: String(text || "") });
    ok = !!(res && (res.ok === true || (typeof res.status === "number" && res.status >= 200 && res.status < 300)));
  } catch { ok = false; }
  if (!ok) return false;
  if (!RUNNING_STATUS.has(thread.status)) {
    await setIssueStatus(ctx, boardApi, companyId, thread.issueId, "todo");
  }
  return true;
}
