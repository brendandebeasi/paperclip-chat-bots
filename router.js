// Inbound router. The cheap model (chat.js) decides: delegate an actionable request to the
// best-fit agent (opened as a tracked ISSUE — the agent has the real tools/skills) or reply
// directly for small talk / one clarifying question. Explicit "/task" and "@agent" bypass the
// model and delegate straight to a named agent. The agent's clean reply (and any follow-up
// questions) come back via the issue.updated / interactions handlers in worker.js.
import { userPolicy, allowedAgents, botAllowsUser, effectiveRoster, parseMention, stripMention } from "./rules.js";
import { resolveAgentId } from "./agents.js";
import { tryAnswerPending } from "./interactions.js";
import { llmConfigured, routeMessage } from "./chat.js";
import { getActiveThread, setActiveThread, continueThread } from "./thread.js";
import { truncate } from "./format.js";

// If `text` begins with one of `commands` (e.g. "/task"), return the remainder (task body);
// "" means the command was given with no body; null means no escalation command.
function matchEscalation(commands, text) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  for (const cmd of commands) {
    if (lower === cmd || lower.startsWith(cmd + " ") || lower.startsWith(cmd + "\n")) {
      return t.slice(cmd.length).trim();
    }
  }
  return null;
}

export const ISSUE_NS = "chat-bots-issue"; // ctx.state namespace mapping issueId -> chat

export function makeInboundHandler(ctx, cfg, getCompanyId, deps = {}) {
  return async function onInbound(msg, tx) {
    if (!tx) return;
    const bot = tx.bot || {};
    const target = { chatId: msg.chatId, threadId: msg.threadId };

    const companyId = await getCompanyId();
    if (!companyId) {
      ctx.logger.error("chat-bots: no companyId; dropping message");
      return;
    }

    // Two gates: the user must be in rules.users AND allowed to DM this specific bot.
    const policy = userPolicy(cfg, msg.senderId);
    if (!policy || !botAllowsUser(bot, msg.senderId)) {
      // Unauthorized: ignore COMPLETELY — no reply — just log it.
      ctx.logger.warn("chat-bots: ignoring unauthorized sender", {
        platform: msg.platform, botKey: msg.botKey, senderId: msg.senderId,
        senderName: msg.senderName, chatId: msg.chatId, text: truncate(msg.text, 140)
      });
      return;
    }

    // If this chat has a pending agent question, treat the message as the answer (not a new task).
    if (await tryAnswerPending(ctx, tx, msg, deps.boardApi)) return;

    // Agents reachable on this (bot, user): (bot offering ∩ user scope). Both the access gate and
    // the topic-routing roster derive from this — there is no way to reach an agent outside it.
    const roster = effectiveRoster(cfg, bot, policy);
    const rosterAliases = new Set(roster.map((r) => r.alias));
    const fallbackAgent = () => {
      if (bot.mode === "direct" && bot.agent && rosterAliases.has(bot.agent)) return bot.agent;
      const def = cfg.rules.defaultAgent ? String(cfg.rules.defaultAgent).toLowerCase() : null;
      if (def && rosterAliases.has(def)) return def;
      return roster[0]?.alias || null;
    };

    // Open a NEW tracked thread: delegate `body` to agent `alias` (the full agent, with tools/skills),
    // record it as this chat's active thread, and ack in one concierge voice (no agent name leaked).
    const delegate = async (rawAlias, body) => {
      const alias = String(rawAlias || "").toLowerCase().trim();
      if (!alias || !rosterAliases.has(alias)) { await tx.sendText(target, "Sorry — I can't help with that here."); return; }
      const agentId = await resolveAgentId(ctx, cfg, companyId, alias);
      if (!agentId) { await tx.sendText(target, "Something went wrong routing that — try again shortly."); return; }
      let issue;
      try {
        issue = await ctx.issues.create({
          companyId,
          title: `[TG] ${truncate(body, 180)}`,
          description: body,
          assigneeAgentId: agentId
        });
        await ctx.issues.update(issue.id, { status: "todo" }, companyId);
      } catch (e) {
        ctx.logger.error("issue create failed", { err: e?.message || String(e) });
        await tx.sendText(target, "Couldn't start that just now — try again shortly.");
        return;
      }
      // Map issue -> originating chat/bot so completion + follow-up questions route back here.
      try {
        await ctx.state.set(
          { scopeKind: "instance", namespace: ISSUE_NS, stateKey: issue.id },
          {
            botKey: msg.botKey, chatId: msg.chatId, threadId: msg.threadId, agent: alias,
            // Requester's delegation scope — the watchdog blocks delegation outside this.
            allowedAgents: allowedAgents(policy),
            requester: policy.name || msg.senderName,
            root: true,
            // Advanced as we forward agent replies, so multi-round threads don't re-forward.
            lastForwardedCommentId: null
          }
        );
      } catch { /* non-fatal */ }
      // This issue is now the chat's active thread; follow-ups continue it.
      await setActiveThread(ctx, tx.platform, msg.botKey, msg.chatId, issue.id, alias);
      try { await tx.typing?.(target); } catch { /* non-fatal */ }
      await tx.sendText(target, "🤖 On it — give me a moment.", { silent: true });
    };

    const text = String(msg.text || "").trim();

    // 1) Explicit escalation ("/task …") -> always a NEW tracked thread.
    const esc = matchEscalation(cfg.escalate.commands, text);
    if (esc !== null) {
      if (!esc) { await tx.sendText(target, `What's the task? e.g. "${cfg.escalate.commands[0]} ...".`); return; }
      const m = parseMention(esc);
      if (m) { await delegate(m, stripMention(esc, m)); return; }
      await delegate(fallbackAgent(), esc);
      return;
    }

    // 2) Explicit @mention of a reachable agent -> NEW thread to that agent (manual override).
    //    A mention of an agent NOT reachable on this bot falls through to the router as plain text.
    const mention = parseMention(text);
    if (mention && rosterAliases.has(mention)) { await delegate(mention, stripMention(text, mention)); return; }

    // 3) Default: the cheap model decides continue-thread / new-thread / direct reply.
    if (llmConfigured(cfg, deps.llmKey)) {
      const active = await getActiveThread(ctx, tx.platform, msg.botKey, msg.chatId, companyId);
      // Only offer continuation if the thread's agent is still reachable on this (bot, user).
      const offer = active && rosterAliases.has(String(active.agent || "")) ? active : null;
      const decision = await routeMessage(ctx, cfg, deps.llmKey, tx, msg, text, roster, offer);
      if (decision.kind === "continue" && offer) {
        try { await tx.typing?.(target); } catch { /* non-fatal */ }
        const ok = await continueThread(ctx, deps.boardApi, companyId, offer, text);
        if (!ok) await delegate(offer.agent || fallbackAgent(), text); // fall back to a fresh thread
        return;
      }
      if (decision.kind === "delegate") await delegate(decision.agent, decision.task);
      return;
    }

    // 4) No model configured -> straight to the bound/fallback agent (legacy behaviour).
    await delegate(msg.boundAgent || fallbackAgent(), text);
  };
}
