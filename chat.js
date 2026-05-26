// Cheap LLM front-desk router (OpenAI-compatible Chat Completions, e.g. Fireworks/Kimi).
//
// The cheap model does NOT do work itself. Its only jobs are: (1) ROUTE — decide which company
// agent should handle an actionable request and delegate to it via the delegate_to_agent tool
// (the plugin then opens a tracked issue for that agent, which has the real tools/skills); and
// (2) SUMMARISE — write up an agent's result as a concise chat reply. For greetings/small talk
// or to ask one missing detail, it replies directly. Per-chat history lives in ctx.state.
import { chunkText, mdToTelegramHtml } from "./format.js";

const HIST_NS = "chat-bots-llm-history"; // ctx.state ns: `${platform}:${chatId}` -> message[]
const RESET_RE = /^\/(reset|new|clear)\b/i;

function histKey(platform, chatId) {
  return { scopeKind: "instance", namespace: HIST_NS, stateKey: `${platform}:${chatId}` };
}

// True if the cheap-router backend is usable (configured + a key resolved).
export function llmConfigured(cfg, llmKey) {
  return !!(cfg.llm && cfg.llm.enabled && cfg.llm.model && llmKey);
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

const DELEGATE_TOOL = [{
  type: "function",
  function: {
    name: "delegate_to_agent",
    description:
      "Delegate an actionable request to the best-fit company agent. Use this for ANYTHING that " +
      "needs real work or tools: scheduling, email, calendar, research, code, infra, data lookups, " +
      "sending messages, content/marketing, etc. The agent has the tools; you do not.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Alias of the agent to handle it (from the available list)." },
        task: { type: "string", description: "Complete, self-contained description of what to do, including every detail the user gave." }
      },
      required: ["agent", "task"]
    }
  }
}];

function routerSystemPrompt(cfg, roster) {
  const lines = roster.map((r) => `- ${r.alias}: ${r.role}`).join("\n");
  const preamble = cfg.llm.systemPrompt ||
    "You are the chat front desk for a company's AI agents. You are a router, not a worker.";
  return `${preamble}

For ANY actionable request (scheduling, email, research, code, infra, data, sending messages, content, or anything needing tools), call delegate_to_agent — pick the best-fit agent and write a complete task description that includes every detail the user gave. If a request is actionable but missing a detail you truly need, ask ONE short clarifying question instead of delegating. Only reply directly for greetings or small talk. Never claim you did the work yourself; the agent does it and reports back here.

Available agents:
${lines}`;
}

// Decide what to do with an inbound message. Returns one of:
//   { kind: "delegate", agent, task }  — caller should open an issue for `agent`
//   { kind: "reply" }                  — a direct reply was already sent (clarifying Q / small talk)
//   { kind: "reset" }                  — history cleared
export async function routeMessage(ctx, cfg, llmKey, tx, msg, prompt, roster) {
  const target = { chatId: msg.chatId, threadId: msg.threadId };
  const key = histKey(tx.platform, msg.chatId);

  if (RESET_RE.test(prompt)) {
    try { await ctx.state.set(key, []); } catch { /* non-fatal */ }
    await tx.sendText(target, "🧹 Started a fresh conversation.");
    return { kind: "reset" };
  }

  let history = [];
  try { const h = await ctx.state.get(key); if (Array.isArray(h)) history = h; } catch { /* ignore */ }
  const userMsg = { role: "user", content: prompt };
  const messages = [{ role: "system", content: routerSystemPrompt(cfg, roster) }, ...history, userMsg];

  try { await tx.typing?.(target); } catch { /* non-fatal */ }
  // tool_choice:auto + headroom — Kimi reasons in content before emitting the tool call.
  const m = await callLlm(ctx, cfg, llmKey, messages, {
    tools: DELEGATE_TOOL, toolChoice: "auto", maxTokens: Math.max(Number(cfg.llm.maxTokens) || 0, 700)
  });

  const saveHistory = async (assistantContent) => {
    const trimmed = [...history, userMsg, { role: "assistant", content: assistantContent }]
      .slice(-Math.max(2, cfg.llm.historyTurns * 2));
    try { await ctx.state.set(key, trimmed); } catch { /* non-fatal */ }
  };

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
    { role: "system", content: "Rewrite the assistant result as a concise, friendly chat reply to the user. Preserve key facts, links, and any question asked. No preamble, no meta commentary." },
    { role: "user", content: text }
  ], { maxTokens: Math.min(Number(cfg.llm.maxTokens) || 700, 700) });
  return (m?.content || "").trim() || text;
}
