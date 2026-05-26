// WhatsApp transport (Baileys / WhatsApp-Web, QR-pair, NO Meta business account).
// STUB — same interface as the Telegram transport. Implementation deferred to Phase 2;
// will wrap @whiskeysockets/baileys (multi-file auth state on the /paperclip volume),
// reusing the logic from ~/git/hermes-agent/scripts/whatsapp-bridge/{bridge.js,allowlist.js}.
//
// Note: WhatsApp has no forum "threads"; target.threadId is ignored on WA.
export function createWhatsAppTransport(ctx, _cfg /*, deps */) {
  ctx.logger.info("chat-bots: WhatsApp transport is a stub (not yet implemented)");
  return {
    platform: "whatsapp",
    async sendText(_target, _text, _opts) {
      ctx.logger.warn("WA sendText called but transport is a stub");
    },
    async typing() {},
    async start(_onInbound) {
      ctx.logger.warn("WA transport start() is a no-op stub");
    },
    stop() {}
  };
}
