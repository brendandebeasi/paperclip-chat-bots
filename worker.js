// Chat Bots plugin worker entrypoint.
import { readFileSync } from "node:fs";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { createTelegramTransport } from "./transports/telegram.js";
import { createWhatsAppTransport } from "./transports/whatsapp.js";
import { makeInboundHandler, ISSUE_NS } from "./router.js";
import { aliasForAgent } from "./agents.js";
import { chunkText, mdToTelegramHtml, truncate } from "./format.js";

// Long-running worker: a stray rejection/exception must NOT kill the process
// (without these handlers the worker exits during init).
process.on("uncaughtException", (e) => console.error("[chat-bots] uncaughtException:", e?.stack || e));
process.on("unhandledRejection", (e) => console.error("[chat-bots] unhandledRejection:", e?.stack || e));

// Module-scoped so onShutdown (which receives no ctx) can stop the poll loops.
const ACTIVE_TRANSPORTS = [];

async function resolveToken(ctx, b) {
  try {
    if (b.botTokenFile) return readFileSync(b.botTokenFile, "utf8").trim();
    if (b.botTokenEnv && process.env[b.botTokenEnv]) return String(process.env[b.botTokenEnv]).trim();
    if (b.botTokenRef) return await ctx.secrets.resolve(b.botTokenRef);
  } catch (e) {
    ctx.logger.error("bot token resolution failed", { agent: b.agent, err: e?.message || String(e) });
  }
  return null;
}

const plugin = definePlugin({
  async setup(ctx) {
    const cfg = parseConfig(await ctx.config.get());
    ctx.logger.info("chat-bots starting", {
      telegram: cfg.telegram.enabled,
      telegramBots: cfg.telegram.bots.length,
      whatsapp: cfg.whatsapp.enabled
    });

    let companyId = cfg.companyId || null;
    const getCompanyId = async () => {
      if (companyId) return companyId;
      try {
        const cs = await ctx.companies.list();
        companyId = cs?.[0]?.id || null;
      } catch (e) {
        ctx.logger.error("companies.list failed", { err: e?.message || String(e) });
      }
      return companyId;
    };
    let issuePrefix = null;
    let issuePrefixResolved = false;
    const getIssuePrefix = async (cid) => {
      if (issuePrefixResolved) return issuePrefix;
      try { const co = await ctx.companies.get(cid); issuePrefix = co?.issuePrefix || ""; } catch { issuePrefix = ""; }
      issuePrefixResolved = true;
      return issuePrefix;
    };
    await getCompanyId(); // resolve within the initialize scope (companies.list is denied from the loop)

    const onInbound = makeInboundHandler(ctx, cfg, getCompanyId);
    const started = [];

    // ----- Telegram: one bot per agent -----
    if (cfg.telegram.enabled) {
      let i = 0;
      for (const b of cfg.telegram.bots) {
        i += 1;
        const token = await resolveToken(ctx, b);
        if (!token) {
          ctx.logger.error("telegram bot has no resolvable token; skipping", { agent: b.agent });
          continue;
        }
        const botKey = b.agent || `bot${i}`;
        const tx = createTelegramTransport(ctx, cfg, { token, boundAgent: b.agent, botKey });
        try {
          tx.start(onInbound); // returns immediately; loop runs in background
          started.push(tx);
          ACTIVE_TRANSPORTS.push(tx);
        } catch (e) {
          ctx.logger.error("telegram bot start failed", { botKey, err: e?.message || String(e) });
        }
      }
    }

    // ----- WhatsApp (stub) -----
    if (cfg.whatsapp.enabled) {
      const tx = createWhatsAppTransport(ctx, cfg);
      try { await tx.start(onInbound); started.push(tx); ACTIVE_TRANSPORTS.push(tx); } catch { /* stub */ }
    }

    // ----- Outbound notifications (sent via one chosen bot) -----
    const notifyTx =
      started.find((t) => t.boundAgent && t.boundAgent === (cfg.notify.agent || cfg.rules.defaultAgent)) ||
      started[0];
    if (notifyTx && cfg.notify.onApproval) {
      ctx.events.on("approval.created", async (event) => {
        if (!cfg.notify.approvalsChatId) return;
        const p = event.payload || {};
        await notifyTx.sendText({ chatId: cfg.notify.approvalsChatId }, `🔔 Approval needed: ${p.title || event.entityId || "(item)"}`);
      });
    }
    if (notifyTx && cfg.notify.onIssueCreated) {
      ctx.events.on("issue.created", async (event) => {
        if (!cfg.notify.defaultChatId) return;
        const p = event.payload || {};
        await notifyTx.sendText({ chatId: cfg.notify.defaultChatId }, `🆕 Issue: ${p.title || event.entityId}`, { silent: true });
      });
    }

    // Forward an agent's clean completion reply back to the originating chat.
    // When an issue we created completes, issue.updated(status=done) carries the
    // agent's summary in payload.comment.
    ctx.events.on("issue.updated", async (event) => {
      try {
        const p = event.payload || {};
        if (p.status !== "done") return;
        const issueId = event.entityId;
        if (!issueId) return;
        const key = { scopeKind: "instance", namespace: ISSUE_NS, stateKey: issueId };
        const map = await ctx.state.get(key);
        if (!map || map.replied) return; // not ours, or already answered
        const tx = started.find((t) => t.botKey === map.botKey) || started[0];
        if (!tx) return;

        // The agent's answer is posted as an issue COMMENT, which may land just AFTER the
        // done event — retry briefly. Take the latest non-empty comment.
        let reply = "";
        for (let i = 0; i < 5 && !reply; i++) {
          try {
            const cs = await ctx.issues.listComments(issueId, event.companyId);
            if (Array.isArray(cs)) {
              for (let j = cs.length - 1; j >= 0; j--) {
                const b = cs[j]?.body || cs[j]?.content;
                if (b && b.trim()) { reply = b.trim(); break; }
              }
            }
          } catch { /* ignore */ }
          if (!reply) await new Promise((r) => setTimeout(r, 1500));
        }
        if (!reply && p.comment) reply = String(p.comment);
        if (!reply) reply = "✅ Done.";

        // Keep TG concise: truncate verbose replies and link to the full Paperclip thread.
        let out = reply;
        if (reply.length > cfg.maxReplyChars) {
          out = truncate(reply, cfg.maxReplyChars);
          let link = "";
          try {
            const prefix = await getIssuePrefix(event.companyId);
            const ident = p.identifier || issueId;
            if (cfg.paperclipPublicUrl && ident) {
              link = `${cfg.paperclipPublicUrl}${prefix ? "/" + prefix : ""}/issues/${ident}`;
            }
          } catch { /* ignore */ }
          if (link) out += `\n\n📋 [Open full reply in Paperclip](${link})`;
        }
        for (const part of chunkText(out)) {
          await tx.sendText({ chatId: map.chatId, threadId: map.threadId }, mdToTelegramHtml(part), { parseMode: "HTML" });
        }
        // Mark replied (dedupe future done events); never store null — value_json is NOT NULL.
        try { await ctx.state.set(key, { ...map, replied: true }); } catch { /* non-fatal */ }
      } catch (e) {
        ctx.logger.error("reply-forward error", { err: e?.message || String(e) });
      }
    });

    // Delegation watchdog: a chat-originated task must not be delegated to an agent the
    // original requester isn't allowed to use (e.g. a user restricted to @support must
    // never have their request reach @engineering via delegation).
    // Allowed delegations propagate the scope down so deeper chains stay gated.
    ctx.events.on("issue.created", async (event) => {
      try {
        const issueId = event.entityId;
        if (!issueId) return;
        const cid = event.companyId || (await getCompanyId());
        if (!cid) return;
        let iss = event.payload || {};
        if (iss.parentId === undefined || iss.assigneeAgentId === undefined) {
          try { const full = await ctx.issues.get(issueId, cid); if (full) iss = full; } catch { /* ignore */ }
        }
        const parentId = iss.parentId;
        if (!parentId) return; // top-level issue (incl. our own root) — nothing to gate
        const parentMap = await ctx.state.get({ scopeKind: "instance", namespace: ISSUE_NS, stateKey: parentId });
        if (!parentMap) return; // parent isn't a TG-originated (tracked) issue
        const allowed = Array.isArray(parentMap.allowedAgents) ? parentMap.allowedAgents.map((a) => String(a).toLowerCase()) : [];
        const propagate = async () => {
          try { await ctx.state.set({ scopeKind: "instance", namespace: ISSUE_NS, stateKey: issueId }, { ...parentMap, root: false }); } catch { /* non-fatal */ }
        };
        if (allowed.includes("*")) return propagate(); // unrestricted requester
        const assigneeId = iss.assigneeAgentId;
        if (!assigneeId) return; // unassigned / human-assigned
        let alias = null;
        try { const ag = await ctx.agents.get(assigneeId, cid); alias = ag ? aliasForAgent(ag) : null; } catch { /* ignore */ }
        if (alias && allowed.includes(alias.toLowerCase())) return propagate(); // allowed delegation

        // Disallowed delegation -> cancel the child issue + notify the requester.
        ctx.logger.warn("chat-bots watchdog: blocking disallowed delegation", { issueId, parentId, assignee: alias || assigneeId, allowed });
        try { await ctx.issues.update(issueId, { status: "cancelled" }, cid); } catch (e) { ctx.logger.error("watchdog cancel failed", { err: e?.message || String(e) }); }
        const tx = started.find((t) => t.botKey === parentMap.botKey) || started[0];
        if (tx && parentMap.chatId) {
          await tx.sendText(
            { chatId: parentMap.chatId, threadId: parentMap.threadId },
            `⚠️ Blocked an attempt to delegate your request to @${alias || "another agent"} — that's outside your allowed agents. Keeping it within your access.`
          );
        }
      } catch (e) {
        ctx.logger.error("watchdog error", { err: e?.message || String(e) });
      }
    });

    ctx.logger.info("chat-bots setup complete", {
      bots: started.filter((t) => t.platform === "telegram").map((t) => t.botKey)
    });
  },

  async onValidateConfig(config) {
    const cfg = parseConfig(config);
    const warnings = [];
    const errors = [];
    if (cfg.telegram.enabled && !cfg.telegram.bots.length) errors.push("telegram.enabled but no telegram.bots configured");
    for (const b of cfg.telegram.bots) {
      if (!b.agent) warnings.push("a telegram bot has no bound agent");
      if (!b.botTokenFile && !b.botTokenEnv && !b.botTokenRef) errors.push(`telegram bot for "${b.agent}" has no token source`);
    }
    if (!Object.keys(cfg.rules.users).length) warnings.push("rules.users is empty — no one is authorized");
    return { ok: errors.length === 0, warnings, errors };
  },

  async onShutdown() {
    for (const t of ACTIVE_TRANSPORTS) {
      try { t.stop(); } catch { /* ignore */ }
    }
    ACTIVE_TRANSPORTS.length = 0;
  }
});

export default plugin;

// Start the worker RPC host so the process stays alive and the host can drive it.
runWorker(plugin, import.meta.url);
