// Telegram transport — ONE INSTANCE PER BOT, each bound to an agent.
// Inbound via getUpdates short-poll; outbound via the Bot API.
// Surface: { platform, boundAgent, botKey, start(onInbound), stop(), sendText(target,text,opts), typing(target) }
//   onInbound is called as onInbound(msg, thisTransport) so the router replies on the same bot.
//   target = { chatId, threadId? }   (threadId = forum topic for group+thread)
//
// IMPORTANT: start() returns immediately and does ALL network (offset read, drain,
// polling) inside a background loop — it must NOT block setup() (the host enforces an
// init deadline; blocking there kills the worker).

import { stripHtml } from "../format.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTelegramTransport(ctx, cfg, { token, boundAgent, botKey }) {
  const base = `https://api.telegram.org/bot${token}`;
  const offsetKey = { scopeKind: "instance", namespace: "chat-bots", stateKey: `tg-offset:${botKey}` };
  let running = false;
  let offset = 0;

  async function tg(method, body) {
    const res = await ctx.http.fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({ ok: false }));
    if (!json.ok) ctx.logger.warn("telegram api not ok", { botKey, method, code: json.error_code, desc: json.description });
    return json;
  }

  async function fetchUpdates() {
    const res = await ctx.http.fetch(`${base}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: cfg.telegram.pollTimeoutSec, allowed_updates: ["message"] })
    });
    return res.json();
  }

  function toInbound(update) {
    const m = update.message || update.edited_message;
    if (!m || (!m.text && !m.caption)) return null;
    const chat = m.chat || {};
    const from = m.from || {};
    return {
      platform: "telegram",
      botKey,
      boundAgent,
      updateId: update.update_id,
      chatId: String(chat.id),
      chatType: chat.type === "private" ? "dm" : "group",
      threadId: m.message_thread_id ?? null,
      senderId: String(from.id),
      senderName:
        from.username || [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id),
      text: m.text || m.caption || ""
    };
  }

  const transport = {
    platform: "telegram",
    boundAgent,
    botKey,

    async sendText(target, text, opts = {}) {
      const body = { chat_id: target.chatId, text: String(text ?? ""), disable_notification: !!opts.silent };
      if (target.threadId != null) body.message_thread_id = target.threadId;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
      // Manual entities (e.g. text_mention) can't combine with parse_mode.
      if (!opts.parseMode && Array.isArray(opts.mentions) && opts.mentions.length) {
        const entities = [];
        for (const mref of opts.mentions) {
          if (!mref?.name || !mref?.id) continue;
          const at = body.text.indexOf(mref.name);
          if (at >= 0) entities.push({ type: "text_mention", offset: at, length: mref.name.length, user: { id: Number(mref.id) } });
        }
        if (entities.length) body.entities = entities;
      }
      const res = await tg("sendMessage", body);
      // If Telegram rejects the HTML entities (malformed), resend as plain text so it still lands.
      if (res && res.ok === false && opts.parseMode) {
        const plain = { chat_id: target.chatId, text: stripHtml(body.text), disable_notification: !!opts.silent };
        if (target.threadId != null) plain.message_thread_id = target.threadId;
        return tg("sendMessage", plain);
      }
      return res;
    },

    async typing(target) {
      const body = { chat_id: target.chatId, action: "typing" };
      if (target.threadId != null) body.message_thread_id = target.threadId;
      return tg("sendChatAction", body);
    },

    // Returns immediately; all network happens in the background loop.
    start(onInbound) {
      running = true;
      (async function loop() {
        try { offset = Number(await ctx.state.get(offsetKey)) || 0; } catch { offset = 0; }

        // Drain stale backlog on first run (no persisted offset).
        if (offset === 0 && cfg.telegram.drainOnStart) {
          try {
            const json = await fetchUpdates();
            const ups = (json && json.ok && json.result) || [];
            if (ups.length) {
              offset = ups[ups.length - 1].update_id + 1;
              try { await ctx.state.set(offsetKey, offset); } catch { /* non-fatal */ }
              ctx.logger.info("telegram drained backlog on first start", { botKey, drained: ups.length, offset });
            }
          } catch (e) { ctx.logger.warn("drain failed", { botKey, err: e?.message || String(e) }); }
        }

        ctx.logger.info("telegram long-poll starting", { botKey, boundAgent, offset });
        while (running) {
          try {
            const json = await fetchUpdates();
            if (!json || !json.ok) {
              ctx.logger.warn("getUpdates not ok", { botKey, code: json?.error_code, desc: json?.description });
              await sleep(3000);
              continue;
            }
            const updates = json.result || [];
            for (const upd of updates) {
              offset = upd.update_id + 1;
              const msg = toInbound(upd);
              if (msg) {
                Promise.resolve(onInbound(msg, transport)).catch((e) =>
                  ctx.logger.error("inbound handler error", { botKey, err: e?.message || String(e) })
                );
              }
            }
            if (updates.length) {
              try { await ctx.state.set(offsetKey, offset); } catch { /* non-fatal */ }
            }
            await sleep(updates.length ? 200 : cfg.telegram.pollIntervalMs);
          } catch (e) {
            ctx.logger.error("getUpdates error", { botKey, err: e?.message || String(e) });
            await sleep(3000);
          }
        }
        ctx.logger.info("telegram long-poll stopped", { botKey });
      })();
    },

    stop() { running = false; }
  };

  return transport;
}
