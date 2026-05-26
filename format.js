// Output formatting helpers (platform-neutral).

// Split a long reply into <=max-char chunks, preferring to break on newlines.
export function chunkText(text, max = 3800) {
  const out = [];
  let s = String(text ?? "");
  while (s.length > max) {
    let cut = s.lastIndexOf("\n", max);
    if (cut < Math.floor(max * 0.5)) cut = max;
    out.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s.trim().length) out.push(s);
  return out.length ? out : [""];
}

export function truncate(s, n = 200) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// HTML-escape text content (Telegram parse_mode=HTML requires & < > escaped).
export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert common Markdown to Telegram's supported HTML subset
// (<b> <i> <code> <pre> <a>). Telegram does NOT support Markdown headers/lists,
// so headers -> bold and bullets -> "• ". Content is escaped first; tags added after.
export function mdToTelegramHtml(md) {
  let s = escapeHtml(String(md ?? ""));
  // fenced code blocks ```lang\n...```
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/\n+$/, "")}</pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold **text** / __text__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // headers (#..######) -> bold line
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // markdown links [text](url) -> <a href="url">text</a>
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // wiki links [[a/b]] -> a/b
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  // italics *text* / _text_ (avoid adjacency to word chars / other markers)
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>");
  s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<i>$1</i>");
  // bullets - / * at line start -> bullet
  s = s.replace(/^\s*[-*]\s+/gm, "• ");
  return s;
}

// Strip HTML tags + unescape entities (fallback when Telegram rejects HTML entities).
export function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
