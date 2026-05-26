# paperclip-plugin-chat-bots

A **platform-agnostic chat-bot plugin for [Paperclip](https://github.com/paperclipai/paperclip)**.
Bridges chat platforms (**Telegram** today; **WhatsApp** next, via Baileys) to Paperclip agents,
with a **per-user → per-agent routing / access-control engine**.

Authored as plain ESM JavaScript (no build step) — the host loads `worker.js` directly and resolves
`@paperclipai/plugin-sdk` from the sibling `node_modules`.

Built because the off-the-shelf one-bot-per-company Telegram connectors use a flat allowlist with
**no per-user/per-agent scoping** — they can't express rules like "user A → the support agent only;
admins → any agent".

## How it works

- **Inbound:** a chat message is turned into a Paperclip **issue** assigned to the target agent. The
  agent's clean completion summary is forwarded back to the originating chat. (Issues are used rather
  than raw session streaming because a native agent's session stream is raw run stdout — tool calls and
  system noise — whereas the completion summary is the intelligible answer.)
- **One bot per agent:** DM an agent's own bot to talk to that agent directly — no in-message `@mention`
  needed. An explicit `@agent` can still redirect within a chat if the sender is allowed that agent.
- **Outbound:** post to **DM / group / group+thread** (Telegram forum topic = `message_thread_id`) and
  `@mention` people. Optional issue/approval notifications to a configured chat.
- **Rules:** default-deny. `rules.users[<platformUserId>] = { name, agents: ["*"] | ["support", ...] }`.
- **Delegation watchdog:** if a chat-originated task is delegated to an agent the original requester
  isn't allowed to use, the child issue is cancelled and the requester is notified — so access scoping
  survives multi-agent delegation chains.

## Transport model

`transports/<platform>.js` each export `createXTransport(ctx, cfg, ...)` returning
`{ platform, start(onInbound), stop(), sendText(target, text, opts), typing(target) }`, where
`target = { chatId, threadId? }`. **Telegram** is implemented (getUpdates short-poll + Bot API).
**WhatsApp** is a stub (Phase 2 — will wrap [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys)).

## Install

The plugin is loaded from a local path on the Paperclip volume (not npm). High level:

1. Copy this directory to the Paperclip data volume, e.g.
   `/paperclip/.paperclip/plugins/paperclip-plugin-chat-bots/`.
2. Provide each bot's token (see **Bot tokens** below).
3. Register it: `POST /api/plugins/install { "packageName": "<that path>", "isLocalPath": true }`.
4. Set config: `POST /api/plugins/:id/config { "configJson": { ... } }` (see `config.example.jsonc`).
5. Restart Paperclip so the worker re-initialises with the saved config.

`apply.sh` automates steps 1–5 against a Paperclip instance. It is intentionally generic — set the
env vars at the top (`PLUGIN_SRC`, `BOTS`, `BOARD_KEY`, …) for your deployment. It supports providing
tokens **with or without** a secret manager (see below).

> **Only one `getUpdates` consumer may run per bot.** If another Telegram plugin/process is already
> polling the same bot, Telegram returns HTTP 409 — disable/uninstall the other consumer first.

## Bot tokens

Tokens are **never** stored in the plugin config, the app DB, the repo, or any log. The worker resolves
each bot's token at runtime in this order:

1. **`botTokenFile`** — path to a file on the volume containing just the token. **Recommended**, and
   currently the most reliable route (see note below).
2. **`botTokenEnv`** — name of an environment variable holding the token.
3. **`botTokenRef`** — a Paperclip secret-ref resolved via `ctx.secrets.resolve()`.

### Without a secret manager (simplest)

Get a bot token from [@BotFather](https://t.me/BotFather), then just write it to a file on the volume:

```sh
# inside the container / on the volume
mkdir -p /paperclip/.paperclip/chat-bots
printf '%s' '123456789:your-bot-token-here' > /paperclip/.paperclip/chat-bots/tg-token-support
chmod 600 /paperclip/.paperclip/chat-bots/tg-token-support
```

Then point the bot's `botTokenFile` at it. That's the whole setup — no vault required.

### With a secret manager (e.g. 1Password)

Keep the token in your vault and render it to the same on-volume file at deploy time, so the plaintext
never enters the repo, config, or DB. Example with the 1Password CLI:

```sh
op read "op://<vault>/<item>/<field>" \
  > /paperclip/.paperclip/chat-bots/tg-token-support
chmod 600 /paperclip/.paperclip/chat-bots/tg-token-support
```

Rotation = update the vault item, re-render the file, restart Paperclip.

> **Why the file route?** On current Paperclip images, plugin **secret-refs are gated** (they can fail
> closed at config-save and runtime until company-scoped plugin config lands), and the plugin worker is
> forked with a **stripped environment** (only `PATH`/`NODE_PATH`/`NODE_ENV`/`TZ`), so an injected
> container env var won't necessarily reach the worker. A file on the volume sidesteps both. `botTokenEnv`
> and `botTokenRef` are supported as fallbacks for when those constraints don't apply.

## Configuration

See [`config.example.jsonc`](./config.example.jsonc) for a fully commented example. The shape:

- `telegram.enabled` + `telegram.bots[]` — one entry per bot: `{ agent, botTokenFile | botTokenEnv | botTokenRef }`.
- `agentAliases` — optional map of alias → Paperclip `agentId` (otherwise aliases resolve by agent
  `urlKey`/`name`).
- `rules` — `{ defaultDeny, defaultAgent, users: { "<telegramUserId>": { name, agents } } }`.
  `agents: ["*"]` allows all; `agents: ["support"]` restricts to one.
- `notify` — optional outbound notifications: `{ defaultChatId, approvalsChatId?, agent, onApproval, onIssueCreated }`.
- `paperclipPublicUrl` — optional; used to build "open full reply in Paperclip" links on truncated messages.

### Finding Telegram IDs

A user's numeric ID is the `from.id` Telegram sends with their messages; in a private chat the `chat_id`
equals the user's ID. The plugin logs the sender ID on an unauthorized message, so you can DM a freshly
created bot once and read the ID from the logs, or use a bot like `@userinfobot`.

## License

MIT — see [LICENSE](./LICENSE).
