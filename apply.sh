#!/usr/bin/env bash
# apply.sh — deploy + configure paperclip-plugin-chat-bots against a Paperclip instance.
#
# Provider-agnostic: it does NOT assume any particular secret manager. You write each bot's
# token to a file on the Paperclip volume first (see README "Bot tokens" — with or without a
# vault), then this script copies the plugin code, registers it, sets config, and restarts.
#
# Typical use (run where you can reach the Paperclip API + the container, e.g. on the host):
#   PLUGIN_SRC=./ \
#   BOARD_KEY="pcp_board_..." \
#   BOTS="support:tg-token-support eng:tg-token-eng" \
#   NOTIFY_CHAT_ID="123456789" \
#   bash apply.sh
#
# The API is usually loopback + hostname-gated, so HOST_HEADER must match the instance's
# public URL. Set BASE/HOST_HEADER for your deployment.
set -euo pipefail

CONTAINER="${CONTAINER:-paperclip}"                         # podman/docker container name
BASE="${BASE:-http://127.0.0.1:3100}"                       # Paperclip API base
HOST_HEADER="${HOST_HEADER:-paperclip.example.com}"         # must match the instance public host
PLUGIN_KEY="${PLUGIN_KEY:-paperclip-plugin-chat-bots}"
PLUGIN_SRC="${PLUGIN_SRC:-./}"                              # local dir holding this plugin package
PLUGIN_DST="${PLUGIN_DST:-/paperclip/.paperclip/plugins/paperclip-plugin-chat-bots}"  # in-container path
TOKEN_DIR="${TOKEN_DIR:-/paperclip/.paperclip/chat-bots}"   # in-container dir holding per-bot token files
BOARD_KEY="${BOARD_KEY:?set BOARD_KEY to a Paperclip board API key}"
# Space-separated "agent:tokenFilename" pairs. The token file must already exist in TOKEN_DIR
# (write it there first — see README). One bot per agent.
BOTS="${BOTS:-support:tg-token-support}"
NOTIFY_CHAT_ID="${NOTIFY_CHAT_ID:-}"                        # optional outbound-notify chat id
DEFAULT_AGENT="${DEFAULT_AGENT:-}"                          # optional; defaults to first bot's agent
# Optional: full rules.users JSON object. If empty, NO users are authorized (default-deny) and
# you must set it later via the config API. Example:
#   RULES_USERS_JSON='{"123":{"name":"Owner","agents":["*"]}}'
RULES_USERS_JSON="${RULES_USERS_JSON:-{}}"
# Container exec runner — override for docker (e.g. CEXEC="docker exec").
CEXEC="${CEXEC:-sudo podman exec}"
CCP="${CCP:-sudo podman cp}"

command -v jq >/dev/null || { echo "FATAL: jq required" >&2; exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl required" >&2; exit 1; }
[ -d "$PLUGIN_SRC" ] || { echo "FATAL: PLUGIN_SRC '$PLUGIN_SRC' not found" >&2; exit 1; }

api(){ local m="$1" p="$2" b="${3:-}"; local a=(-sS -X "$m" "$BASE$p" -H "Authorization: Bearer $BOARD_KEY" -H "Host: $HOST_HEADER"); [ -n "$b" ] && a+=(-H 'Content-Type: application/json' -d "$b"); curl "${a[@]}"; }
cexec(){ $CEXEC "$CONTAINER" sh -lc "$1"; }

CID="$(api GET /api/companies | jq -r '.[0].id')"
[ -n "$CID" ] && [ "$CID" != null ] || { echo "FATAL: could not resolve companyId (check BOARD_KEY/HOST_HEADER)" >&2; exit 1; }
echo "companyId=$CID"

# ── 1) verify per-bot token files exist on the volume ─────────────────────────────
echo "== check token files in $TOKEN_DIR =="
for spec in $BOTS; do
  fn="${spec##*:}"
  cexec "test -s '$TOKEN_DIR/$fn'" || { echo "FATAL: token file '$TOKEN_DIR/$fn' missing/empty — write it first (see README)" >&2; exit 1; }
done

# ── 2) (re)deploy the plugin code onto the volume ─────────────────────────────────
echo "== deploy plugin code =="
OLD="$(api GET /api/plugins | jq -r --arg k "$PLUGIN_KEY" '.[]|select(.pluginKey==$k)|.id' | head -1)"
if [ -n "$OLD" ] && [ "$OLD" != null ]; then api DELETE "/api/plugins/$OLD" >/dev/null 2>&1 || true; echo "  uninstalled old ($OLD)"; fi
cexec "rm -rf '$PLUGIN_DST'"
$CCP "$PLUGIN_SRC" "$CONTAINER:$PLUGIN_DST"

# ── 3) register via local-path install (bare path, no @version) ───────────────────
echo "== install =="
api POST /api/plugins/install "$(jq -n --arg p "$PLUGIN_DST" '{packageName:$p, isLocalPath:true}')" | jq -c '{status,error}' 2>/dev/null || true
PID="$(api GET /api/plugins | jq -r --arg k "$PLUGIN_KEY" '.[]|select(.pluginKey==$k)|.id' | head -1)"
[ -n "$PID" ] && [ "$PID" != null ] || { echo "FATAL: plugin not registered" >&2; exit 1; }
echo "  pluginId=$PID"

# ── 4) build + set config ─────────────────────────────────────────────────────────
echo "== set config =="
first_agent=""
bots_json="$(for spec in $BOTS; do ag="${spec%%:*}"; fn="${spec##*:}"; [ -z "$first_agent" ] && first_agent="$ag"; \
  jq -n --arg a "$ag" --arg f "$TOKEN_DIR/$fn" '{agent:$a, botTokenFile:$f}'; done | jq -s '.')"
[ -n "$DEFAULT_AGENT" ] || DEFAULT_AGENT="$first_agent"
CFG="$(jq -n \
  --argjson bots "$bots_json" \
  --argjson users "$RULES_USERS_JSON" \
  --arg da "$DEFAULT_AGENT" \
  --arg nc "$NOTIFY_CHAT_ID" \
  '{telegram:{enabled:true, bots:$bots},
    rules:{defaultDeny:true, defaultAgent:$da, users:$users},
    notify:({agent:$da, onApproval:true, onIssueCreated:false} + (if $nc=="" then {} else {defaultChatId:$nc} end))}')"
api POST "/api/plugins/$PID/config" "$(jq -n --argjson c "$CFG" '{configJson:$c}')" | jq -c '{id, ok:(.configJson!=null)}' 2>/dev/null || true

# ── 5) restart so the worker re-inits with the saved config ───────────────────────
echo "== restart (apply config) =="
echo "  Restart your Paperclip service now so the worker picks up the new config, e.g.:"
echo "    systemctl restart paperclip   # or: $CEXEC restart, or your orchestrator's restart"

echo
echo "DONE. Verify (after restart):"
echo "  - one 'chat-bots starting' log line with telegramBots=N"
echo "  - one 'telegram long-poll starting' per bot"
echo "  - DM each agent's bot (authorized users only; each user must /start a bot first)."
