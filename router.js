// Inbound router. The cheap model (chat.js) decides: delegate an actionable request to the
// best-fit agent (opened as a tracked ISSUE — the agent has the real tools/skills) or reply
// directly for small talk / one clarifying question. Explicit "/task" and "@agent" bypass the
// model and delegate straight to a named agent. The agent's clean reply (and any follow-up
// questions) come back via the issue.updated / interactions handlers in worker.js.
import { userPolicy, allowedAgents, canUseAgent, parseMention, stripMention } from "./rules.js";
import { resolveAgentId } from "./agents.js";
import { tryAnswerPending } from "./interactions.js";
import { llmConfigured, routeMessage } from "./chat.js";
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

// Roster of { alias, role } the user is allowed to delegate to (cfg.llm.agents filtered by policy).
function buildRoster(cfg, policy) {
  const agents = cfg.llm.agents || {};
  const allowed = allowedAgents(policy).map((a) => String(a).toLowerCase());
  const all = allowed.includes("*");
  return Object.entries(agents)
    .filter(([alias]) => all || allowed.includes(String(alias).toLowerCase()))
    .map(([alias, role]) => ({ alias, role: String(role) }));
}

export const ISSUE_NS = "chat-bots-issue"; // ctx.state namespace mapping issueId -> chat

export function makeInboundHandler(ctx, cfg, getCompanyId, deps = {}) {
  return async function onInbound(msg, tx) {
    if (!tx) return;
    const target = { chatId: msg.chatId, threadId: msg.threadId };

    const companyId = await getCompanyId();
    if (!companyId) {
      ctx.logger.error("chat-bots: no companyId; dropping message");
      return;
    }

    const policy = userPolicy(cfg, msg.senderId);
    if (!policy) {
      // Unknown sender (not in the access list): ignore COMPLETELY — no reply — just log it.
      ctx.logger.warn("chat-bots: ignoring unauthorized sender", {
        platform: msg.platform, botKey: msg.botKey, senderId: msg.senderId,
        senderName: msg.senderName, chatId: msg.chatId, text: truncate(msg.text, 140)
      });
      return;
    }

    // If this chat has a pending agent question, treat the message as the answer (not a new task).
    if (await tryAnswerPending(ctx, tx, msg, deps.boardApi)) return;

    // Delegate `body` to agent `alias` as a tracked issue (the full agent, with tools/skills).
    // Enforces the user's access policy. The reply comes back via worker.js issue.updated(done).
    const delegate = async (rawAlias, body) => {
      const alias = String(rawAlias || "").toLowerCase().trim();
      if (!alias) { await tx.sendText(target, "Which agent should handle this? Mention one with @<agent>."); return; }
      if (!canUseAgent(policy, alias)) { await tx.sendText(target, `You don't have access to @${alias}.`); return; }
      const agentId = await resolveAgentId(ctx, cfg, companyId, alias);
      if (!agentId) { await tx.sendText(target, `Couldn't find an agent for @${alias}.`); return; }
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
        await tx.sendText(target, "Couldn't hand that to the agent — try again shortly.");
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
            root: true
          }
        );
      } catch { /* non-fatal */ }
      try { await tx.typing?.(target); } catch { /* non-fatal */ }
      await tx.sendText(target, `🤖 On it — handing this to @${alias}; I'll report back here.`, { silent: true });
    };

    const text = String(msg.text || "").trim();

    // 1) Explicit escalation: "/task ..." forces a tracked issue (to @mentioned or bound agent).
    const esc = matchEscalation(cfg.escalate.commands, text);
    if (esc !== null) {
      if (!esc) { await tx.sendText(target, `What's the task? e.g. "${cfg.escalate.commands[0]} ...".`); return; }
      const m = parseMention(esc);
      if (m) { await delegate(m, stripMention(esc, m)); return; }
      await delegate(msg.boundAgent || cfg.rules.defaultAgent, esc);
      return;
    }

    // 2) Explicit @mention -> delegate straight to that agent (manual override of routing).
    const mention = parseMention(text);
    if (mention) { await delegate(mention, stripMention(text, mention)); return; }

    // 3) Default: the cheap model routes — delegate to the best agent, or reply directly.
    if (llmConfigured(cfg, deps.llmKey)) {
      const decision = await routeMessage(ctx, cfg, deps.llmKey, tx, msg, text, buildRoster(cfg, policy));
      if (decision.kind === "delegate") await delegate(decision.agent, decision.task);
      return;
    }

    // 4) No model configured -> straight to the bound agent (legacy behaviour).
    await delegate(msg.boundAgent || cfg.rules.defaultAgent, text);
  };
}
