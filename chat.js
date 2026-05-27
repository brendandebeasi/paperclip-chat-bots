// Cheap LLM front-desk router (OpenAI-compatible Chat Completions, e.g. Fireworks/Kimi).
//
// The cheap model does NOT do work itself. Its only jobs are: (1) ROUTE — decide which company
// agent should handle an actionable request and delegate to it via the delegate_to_agent tool
// (the plugin then opens a tracked issue for that agent, which has the real tools/skills); and
// (2) SUMMARISE — write up an agent's result as a concise chat reply. For greetings/small talk
// or to ask one missing detail, it replies directly. Per-chat history lives in ctx.state.
import { chunkText, mdToTelegramHtml } from "./format.js";
import { clearActiveThread } from "./thread.js";

const HIST_NS = "chat-bots-llm-history"; // ctx.state ns: `${platform}:${botKey}:${chatId}` -> message[]
const RESET_RE = /^\/(reset|new|clear)\b/i;

// Keyed by botKey too (a Telegram private chatId == user id across all bots — see thread.js).
function histKey(platform, botKey, chatId) {
  return { scopeKind: "instance", namespace: HIST_NS, stateKey: `${platform}:${botKey}:${chatId}` };
}

// True if the cheap-router backend is usable (configured + a key resolved).
export function llmConfigured(cfg, llmKey) {
  return !!(cfg.llm && cfg.llm.enabled && cfg.llm.model && llmKey);
}

// Append an assistant turn to a chat's router history. Used when an agent's reply comes back
// async (worker.js issue.updated) so a follow-up message has the answer in context — otherwise
// the router only ever sees its own "(delegated …)" placeholder and forgets what was discussed.
export async function recordAssistantReply(ctx, cfg, platform, botKey, chatId, content) {
  const text = String(content ?? "").trim();
  if (!text) return;
  const key = histKey(platform, botKey, chatId);
  let history = [];
  try { const h = await ctx.state.get(key); if (Array.isArray(h)) history = h; } catch { /* ignore */ }
  const trimmed = [...history, { role: "assistant", content: text }]
    .slice(-Math.max(2, cfg.llm.historyTurns * 2));
  try { await ctx.state.set(key, trimmed); } catch { /* non-fatal */ }
}

// Low-level Chat Completions call. Returns the assistant message object, or null on failure.
async function callLlm(ctx, cfg, llmKey, messages, { tools, toolChoice, maxTokens } = {}) {
  try {
    const body = {
      model: cfg.llm.model,
      messages,
      max_tokens: maxTokens ?? cfg.llm.maxTokens,
      temperature: cfg.llm.temperature
    };
    if (tools) { body.tools = tools; body.tool_choice = toolChoice ?? "auto"; }
    const res = await ctx.http.fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmKey}` },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    const m = json?.choices?.[0]?.message;
    if (!m) ctx.logger.error("llm: no message", { status: res?.status, err: json?.error });
    return m || null;
  } catch (e) {
    ctx.logger.error("llm: call threw", { err: e?.message || String(e) });
    return null;
  }
}

const DELEGATE_TOOL = {
  type: "function",
  function: {
    name: "delegate_to_agent",
    description:
      "Delegate an actionable request to the best-fit company agent, opening a NEW thread. Use this " +
      "for ANYTHING that needs real work or tools (scheduling, email, calendar, research, code, infra, " +
      "data lookups, sending messages, content/marketing) when it is NOT a follow-up to the active " +
      "thread below. The agent has the tools; you do not.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Alias of the agent to handle it (from the available list)." },
        task: { type: "string", description: "Complete, self-contained description of what to do, including every detail the user gave." }
      },
      required: ["agent", "task"]
    }
  }
};

const CONTINUE_TOOL = {
  type: "function",
  function: {
    name: "continue_thread",
    description:
      "Use when the message is a FOLLOW-UP to the active thread described below — a correction, " +
      "added detail, reply to its question, or 'also do X' about the same task. The user's message is " +
      "appended to that thread and the same agent resumes with full context. Prefer this over opening a " +
      "new thread whenever the message relates to what's already in flight.",
    parameters: { type: "object", properties: {}, required: [] }
  }
};

function routerSystemPrompt(cfg, roster, activeThread) {
  const lines = roster.map((r) => `- ${r.alias}: ${r.role}`).join("\n");
  const preamble = cfg.llm.systemPrompt ||
    "You are the chat front desk for a company's AI agents. You are a router, not a worker. " +
    "You speak in one voice; never reveal which internal agent handles a request.";
  const threadBlock = activeThread
    ? `\n\nActive thread (work already in flight for this user): "${activeThread.title || "(untitled)"}". ` +
      `If this message is a follow-up to it, call continue_thread. If it's a clearly different task, call delegate_to_agent (new thread).`
    : "";
  return `${preamble}

For ANY actionable request (scheduling, email, research, code, infra, data, sending messages, content, or anything needing tools), delegate — pick the best-fit agent and write a complete task description that includes every detail the user gave. If a request is actionable but missing a detail you truly need, ask ONE short clarifying question instead of delegating. Only reply directly for greetings or small talk. Never claim you did the work yourself.${threadBlock}

Available agents:
${lines}`;
}

// Decide what to do with an inbound message. Returns one of:
//   { kind: "delegate", agent, task }  — caller should open a NEW issue for `agent`
//   { kind: "continue" }               — caller should append to the active thread
//   { kind: "reply" }                  — a direct reply was already sent (clarifying Q / small talk)
//   { kind: "reset" }                  — history + active thread cleared
export async function routeMessage(ctx, cfg, llmKey, tx, msg, prompt, roster, activeThread) {
  const target = { chatId: msg.chatId, threadId: msg.threadId };
  const key = histKey(tx.platform, msg.botKey, msg.chatId);

  if (RESET_RE.test(prompt)) {
    try { await ctx.state.set(key, []); } catch { /* non-fatal */ }
    await clearActiveThread(ctx, tx.platform, msg.botKey, msg.chatId);
    await tx.sendText(target, "🧹 Started a fresh conversation.");
    return { kind: "reset" };
  }

  let history = [];
  try { const h = await ctx.state.get(key); if (Array.isArray(h)) history = h; } catch { /* ignore */ }
  const userMsg = { role: "user", content: prompt };
  const messages = [{ role: "system", content: routerSystemPrompt(cfg, roster, activeThread) }, ...history, userMsg];
  const tools = activeThread ? [DELEGATE_TOOL, CONTINUE_TOOL] : [DELEGATE_TOOL];

  try { await tx.typing?.(target); } catch { /* non-fatal */ }
  // tool_choice:auto + headroom — Kimi reasons in content before emitting the tool call.
  const m = await callLlm(ctx, cfg, llmKey, messages, {
    tools, toolChoice: "auto", maxTokens: Math.max(Number(cfg.llm.maxTokens) || 0, 700)
  });

  const saveHistory = async (assistantContent) => {
    const trimmed = [...history, userMsg, { role: "assistant", content: assistantContent }]
      .slice(-Math.max(2, cfg.llm.historyTurns * 2));
    try { await ctx.state.set(key, trimmed); } catch { /* non-fatal */ }
  };

  // Follow-up to the active thread: caller posts the user's message as a comment + resumes the agent.
  if (activeThread && m?.tool_calls?.some((t) => t?.function?.name === "continue_thread")) {
    await saveHistory("(continuing the active thread)");
    return { kind: "continue" };
  }

  const tc = m?.tool_calls?.find((t) => t?.function?.name === "delegate_to_agent");
  if (tc) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore */ }
    const agent = String(args.agent || "").toLowerCase().trim();
    const task = String(args.task || prompt).trim();
    if (agent) {
      await saveHistory(`(delegated to ${agent}: ${task})`);
      return { kind: "delegate", agent, task };
    }
  }

  const reply = (m?.content || "").trim();
  if (!reply) {
    await tx.sendText(target, "⚠️ I couldn't reach the model just now — try again in a moment.");
    return { kind: "reply" };
  }
  await saveHistory(reply);
  for (const part of chunkText(reply)) await tx.sendText(target, mdToTelegramHtml(part), { parseMode: "HTML" });
  return { kind: "reply" };
}

// Summarise an agent's (possibly long) completion into a concise, chat-friendly reply.
// Falls back to the original text if the model is unavailable.
export async function summarize(ctx, cfg, llmKey, text) {
  const m = await callLlm(ctx, cfg, llmKey, [
    { role: "system", content: "Rewrite the result as a concise, friendly chat reply to the user, in first person and one consistent voice. Preserve key facts, links, and any question asked. Do NOT mention which internal agent did the work or that it was delegated. No preamble, no meta commentary." },
    { role: "user", content: text }
  ], { maxTokens: Math.min(Number(cfg.llm.maxTokens) || 700, 700) });
  return (m?.content || "").trim() || text;
}
