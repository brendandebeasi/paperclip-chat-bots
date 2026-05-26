// Follow-up question relay. When an agent needs input mid-task it creates an issue-thread
// INTERACTION (ask_user_questions / request_confirmation). We forward it to the origin chat,
// capture the user's reply, and submit it back via the board API so the agent's run resumes.
//
// The SDK has no "respond to interaction" method, so answers go through the board API:
//   POST /api/issues/:id/interactions/:interactionId/respond   { answers:[{questionId, optionIds}] }
//   POST /api/issues/:id/interactions/:interactionId/accept|reject   (request_confirmation)
// Those calls must target the canonical host URL (paperclipPublicUrl) — the loopback enforces a
// hostname allowlist and fetch() can't override the Host header.
import { truncate, escapeHtml } from "./format.js";

export const PENDING_NS = "chat-bots-pending"; // ctx.state ns: `${platform}:${chatId}` -> pending interaction

function pendKey(platform, chatId) {
  return { scopeKind: "instance", namespace: PENDING_NS, stateKey: `${platform}:${chatId}` };
}

// Shape-defensive extraction from the issue.interactions.create event.
export function readInteraction(event) {
  const p = event.payload || {};
  const interaction = p.interaction || p;
  return {
    kind: interaction.kind || p.kind || null,
    interactionId: interaction.id || p.interactionId || null,
    issueId: interaction.issueId || p.issueId || event.entityId || null,
    ipayload: interaction.payload || p.payload || {}
  };
}

// Forward a newly-created interaction to the chat + store pending state. Returns true if forwarded.
export async function forwardInteraction(ctx, tx, map, event) {
  const { kind, interactionId, issueId, ipayload } = readInteraction(event);
  if (!kind || !interactionId) return false;
  const target = { chatId: map.chatId, threadId: map.threadId };

  if (kind === "ask_user_questions") {
    const questions = Array.isArray(ipayload.questions) ? ipayload.questions : [];
    if (!questions.length) return false;
    const multi = questions.length > 1;
    const lines = [];
    if (ipayload.title) lines.push(`❓ <b>${escapeHtml(ipayload.title)}</b>`);
    questions.forEach((q, qi) => {
      const head = multi ? `<b>Q${qi + 1}.</b> ` : "❓ ";
      lines.push(`${head}${escapeHtml(q.prompt)}${q.selectionMode === "multi" ? " (pick one or more)" : ""}`);
      (q.options || []).forEach((o, oi) => lines.push(`  ${oi + 1}. ${escapeHtml(o.label)}`));
    });
    lines.push(multi
      ? "\nReply with one number per question, comma-separated (e.g. <code>1,2</code>)."
      : "\nReply with the option number(s).");
    await tx.sendText(target, lines.join("\n"), { parseMode: "HTML" });
    await ctx.state.set(pendKey(tx.platform, map.chatId), {
      kind, interactionId, issueId, botKey: map.botKey, threadId: map.threadId,
      questions: questions.map((q) => ({
        id: q.id,
        selectionMode: q.selectionMode,
        options: (q.options || []).map((o) => ({ id: o.id, label: o.label }))
      }))
    });
    return true;
  }

  if (kind === "request_confirmation") {
    const prompt = ipayload.prompt || ipayload.message || ipayload.title || "Please confirm.";
    await tx.sendText(target, `❓ ${escapeHtml(prompt)}\n\nReply <b>yes</b> or <b>no</b>.`, { parseMode: "HTML" });
    await ctx.state.set(pendKey(tx.platform, map.chatId), {
      kind, interactionId, issueId, botKey: map.botKey, threadId: map.threadId
    });
    return true;
  }

  return false; // other interaction kinds (suggest_tasks, etc.) are not relayed
}

// If the chat has a pending interaction, treat msg as the answer + submit it. Returns true if consumed.
export async function tryAnswerPending(ctx, tx, msg, boardApi) {
  if (!boardApi) return false;
  const key = pendKey(msg.platform, msg.chatId);
  let pend = null;
  try { pend = await ctx.state.get(key); } catch { /* ignore */ }
  if (!pend || pend.answered || !pend.interactionId) return false;
  const target = { chatId: msg.chatId, threadId: msg.threadId };
  const text = String(msg.text || "").trim();

  if (pend.kind === "request_confirmation") {
    const yes = /^(y|yes|yep|yeah|confirm|ok|okay|approve|accept|sure)\b/i.test(text);
    const no = /^(n|no|nope|cancel|reject|deny|stop)\b/i.test(text);
    if (!yes && !no) { await tx.sendText(target, "Please reply <b>yes</b> or <b>no</b>.", { parseMode: "HTML" }); return true; }
    const path = `/api/issues/${pend.issueId}/interactions/${pend.interactionId}/${yes ? "accept" : "reject"}`;
    const ok = await submit(ctx, boardApi, path, yes ? {} : { reason: text });
    await finish(ctx, tx, target, key, ok);
    return true;
  }

  // ask_user_questions
  const tokens = text.split(/[,\s]+/).map((t) => parseInt(t, 10)).filter((n) => Number.isInteger(n) && n > 0);
  if (!tokens.length) { await tx.sendText(target, "Reply with the option number(s)."); return true; }
  const questions = pend.questions || [];
  let answers;
  if (questions.length === 1) {
    const q = questions[0];
    const sel = q.selectionMode === "multi" ? tokens : tokens.slice(0, 1);
    const optionIds = sel.map((n) => q.options?.[n - 1]?.id).filter(Boolean);
    if (!optionIds.length) { await tx.sendText(target, "That option number isn't valid — try again."); return true; }
    answers = [{ questionId: q.id, optionIds }];
  } else {
    answers = questions.map((q, idx) => {
      const id = q.options?.[tokens[idx] - 1]?.id;
      return { questionId: q.id, optionIds: id ? [id] : [] };
    });
    if (answers.some((a) => !a.optionIds.length)) {
      await tx.sendText(target, `Please reply with ${questions.length} numbers, comma-separated (one per question).`);
      return true;
    }
  }
  const ok = await submit(ctx, boardApi, `/api/issues/${pend.issueId}/interactions/${pend.interactionId}/respond`, { answers });
  await finish(ctx, tx, target, key, ok);
  return true;
}

async function submit(ctx, boardApi, path, body) {
  try {
    const res = await boardApi("POST", path, body);
    if (res && (res.ok === true || (typeof res.status === "number" && res.status >= 200 && res.status < 300))) return true;
    let detail = "";
    try { detail = res && res.text ? await res.text() : ""; } catch { /* ignore */ }
    ctx.logger.error("interaction submit failed", { path, status: res?.status, detail: truncate(detail, 200) });
    return false;
  } catch (e) {
    ctx.logger.error("interaction submit threw", { path, err: e?.message || String(e) });
    return false;
  }
}

async function finish(ctx, tx, target, key, ok) {
  try { await ctx.state.set(key, { answered: true }); } catch { /* non-fatal — value_json is NOT NULL */ }
  await tx.sendText(target, ok ? "✓ Got it — continuing." : "⚠️ Couldn't submit that — try again, or check Paperclip.");
}
