// Direct LLM chat backend (OpenAI-compatible Chat Completions, e.g. Fireworks/Kimi).
//
// This is the CHEAP conversational path: an inbound message is answered by a direct model
// call — NO Paperclip issue is created and NO agent run is spawned. Per-chat conversation
// history lives in ctx.state; the bound agent's persona is injected as the system prompt so
// the bot still "sounds like" that agent. Use the escalation command (see router.js) when you
// want real, tracked agent work with tools/skills.
import { chunkText, mdToTelegramHtml } from "./format.js";

const HIST_NS = "chat-bots-llm-history"; // ctx.state ns: `${platform}:${chatId}:${alias}` -> message[]
const RESET_RE = /^\/(reset|new|clear)\b/i;

function histKey(platform, chatId, alias) {
  return { scopeKind: "instance", namespace: HIST_NS, stateKey: `${platform}:${chatId}:${alias}` };
}

// True if a direct-chat backend is usable (configured + a key resolved).
export function llmConfigured(cfg, llmKey) {
  return !!(cfg.llm && cfg.llm.enabled && cfg.llm.model && llmKey);
}

function systemPromptFor(cfg, alias) {
  const personas = cfg.llm.personas || {};
  return personas[alias] || cfg.llm.systemPrompt || `You are ${alias}, a helpful assistant. Be concise.`;
}

// Answer `prompt` from `alias` via a direct model call. Sends the reply on `tx`. No issue created.
export async function chatReply(ctx, cfg, llmKey, tx, msg, alias, prompt) {
  const target = { chatId: msg.chatId, threadId: msg.threadId };
  const key = histKey(tx.platform, msg.chatId, alias);

  if (RESET_RE.test(prompt)) {
    try { await ctx.state.set(key, []); } catch { /* non-fatal */ }
    await tx.sendText(target, "🧹 Started a fresh conversation.");
    return;
  }

  let history = [];
  try { const h = await ctx.state.get(key); if (Array.isArray(h)) history = h; } catch { /* ignore */ }

  const userMsg = { role: "user", content: prompt };
  const messages = [{ role: "system", content: systemPromptFor(cfg, alias) }, ...history, userMsg];

  try { await tx.typing?.(target); } catch { /* non-fatal */ }

  let reply = "";
  try {
    const res = await ctx.http.fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmKey}` },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages,
        max_tokens: cfg.llm.maxTokens,
        temperature: cfg.llm.temperature
      })
    });
    const json = await res.json().catch(() => null);
    reply = json?.choices?.[0]?.message?.content?.trim() || "";
    if (!reply) ctx.logger.error("llm: empty/failed reply", { status: res?.status, model: cfg.llm.model });
  } catch (e) {
    ctx.logger.error("llm: call threw", { err: e?.message || String(e) });
  }

  if (!reply) {
    await tx.sendText(target, "⚠️ I couldn't reach the model just now — try again in a moment.");
    return;
  }

  // Persist trimmed history (cap to historyTurns round-trips; never store null — value_json is NOT NULL).
  const trimmed = [...history, userMsg, { role: "assistant", content: reply }].slice(-Math.max(2, cfg.llm.historyTurns * 2));
  try { await ctx.state.set(key, trimmed); } catch { /* non-fatal */ }

  for (const part of chunkText(reply)) {
    await tx.sendText(target, mdToTelegramHtml(part), { parseMode: "HTML" });
  }
}
