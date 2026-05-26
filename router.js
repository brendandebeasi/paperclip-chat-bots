// Inbound router: message -> rule check -> resolve target agent -> hand to the agent
// as an ISSUE -> ack. The clean reply is forwarded later from the issue's completion
// comment (see worker.js issue.updated handler).
//
// Why issue-based (not sessions.sendMessage streaming): a native (claude_local) agent's
// session stream is raw run stdout (tool calls, system noise) — long and unintelligible.
// The agent's clean answer is its completion summary, delivered via issue.updated(done).
import { userPolicy, allowedAgents, canUseAgent, parseMention, pickAgentAlias, stripMention } from "./rules.js";
import { resolveAgentId } from "./agents.js";
import { tryAnswerPending } from "./interactions.js";
import { llmConfigured, chatReply } from "./chat.js";
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
        platform: msg.platform,
        botKey: msg.botKey,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: truncate(msg.text, 140)
      });
      return;
    }

    // If this chat has a pending agent question, treat the message as the answer (not a new task).
    if (await tryAnswerPending(ctx, tx, msg, deps.boardApi)) return;

    // Target agent: explicit @mention (if allowed) > the bot's bound agent > fallback.
    let alias = null;
    const mention = parseMention(msg.text);
    if (mention) {
      if (!canUseAgent(policy, mention)) {
        await tx.sendText(target, `You don't have access to @${mention}.`);
        return;
      }
      alias = mention;
    } else if (msg.boundAgent) {
      if (!canUseAgent(policy, msg.boundAgent)) {
        await tx.sendText(target, "Sorry — you're not authorized to talk to this agent.");
        return;
      }
      alias = msg.boundAgent;
    } else {
      const pick = pickAgentAlias(cfg, policy, msg.text);
      if (pick.error) {
        await tx.sendText(target, "Which agent should handle this? Mention one with @<agent>.");
        return;
      }
      alias = pick.alias;
    }

    const agentId = await resolveAgentId(ctx, cfg, companyId, alias);
    if (!agentId) {
      await tx.sendText(target, `Couldn't find an agent for @${alias}.`);
      return;
    }

    const prompt = mention ? stripMention(msg.text, alias) : String(msg.text || "").trim();
    if (!prompt) {
      await tx.sendText(target, `Hi, this is @${alias}. What would you like? (Use ${cfg.escalate.commands[0]} <task> to open a tracked task.)`);
      return;
    }

    // Hand a prompt to the resolved agent as a tracked ISSUE (full agent, with tools/skills).
    // The clean reply comes back via the issue.updated(done) handler in worker.js.
    const handToAgentAsIssue = async (body) => {
      let issue;
      try {
        issue = await ctx.issues.create({
          companyId,
          title: `[TG] ${truncate(body, 180)}`,
          description: body, // always write the full message to the ticket description
          assigneeAgentId: agentId
        });
        await ctx.issues.update(issue.id, { status: "todo" }, companyId);
      } catch (e) {
        ctx.logger.error("issue create failed", { err: e?.message || String(e) });
        await tx.sendText(target, "Couldn't hand that to the agent — try again shortly.");
        return;
      }
      // Map issue -> originating chat/bot so the completion comment routes back here.
      try {
        await ctx.state.set(
          { scopeKind: "instance", namespace: ISSUE_NS, stateKey: issue.id },
          {
            botKey: msg.botKey,
            chatId: msg.chatId,
            threadId: msg.threadId,
            agent: alias,
            // Requester's delegation scope — the watchdog blocks delegation outside this.
            allowedAgents: allowedAgents(policy),
            requester: policy.name || msg.senderName,
            root: true
          }
        );
      } catch { /* non-fatal */ }
      try { await tx.typing?.(target); } catch { /* non-fatal */ }
      // First-person ack: the bot you messaged is the single point of contact and reports back here.
      await tx.sendText(target, "🤖 On it — opened a task and working on it; I'll report back here.", { silent: true });
    };

    // 1) Explicit escalation (e.g. "/task ...") -> always a tracked issue.
    const esc = matchEscalation(cfg.escalate.commands, prompt);
    if (esc !== null) {
      if (!esc) {
        await tx.sendText(target, `What's the task? e.g. "${cfg.escalate.commands[0]} summarise today's uploads".`);
        return;
      }
      await handToAgentAsIssue(esc);
      return;
    }

    // 2) Default: cheap direct chat (no issue, no agent run) when a chat backend is configured.
    if (llmConfigured(cfg, deps.llmKey)) {
      await chatReply(ctx, cfg, deps.llmKey, tx, msg, alias, prompt);
      return;
    }

    // 3) No chat backend configured -> fall back to the issue path (legacy behaviour).
    await handToAgentAsIssue(prompt);
  };
}
