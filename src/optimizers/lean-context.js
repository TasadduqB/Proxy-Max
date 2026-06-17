/**
 * Middle context compaction layer
 *
 * A conservative middle-history compactor for Claude Code style transcripts.
 * It never touches system prompts, tool schemas, tool_use/tool_result messages, or
 * the newest turns. Older plain-text chat turns are summarized as local excerpts so
 * long sessions keep useful anchors without carrying every token forward.
 */

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').filter(Boolean).join('\n');
}

function hasToolBlocks(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some(b => b && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'server_tool_use'));
}

function approxTokens(value) {
  if (!value) return 0;
  try { return Math.ceil(JSON.stringify(value).length / 4); }
  catch { return Math.ceil(String(value).length / 4); }
}

function summarizeText(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, Math.floor(maxChars * 0.72)).trim();
  const tail = clean.slice(-Math.floor(maxChars * 0.22)).trim();
  return `${head}\n… [Middle context compacted ${clean.length - head.length - tail.length} chars from middle]\n${tail}`;
}

class MiddleContextCompactor {
  compact(messages, options = {}) {
    if (!Array.isArray(messages)) return { messages, savedChars: 0, compacted: 0 };
    const keepFirstN = Math.max(0, Number(options.keepFirstN) || 4);
    const keepLastN = Math.max(2, Number(options.keepLastN) || 24);
    const minChars = Math.max(200, Number(options.minChars) || 1200);
    const summaryChars = Math.max(120, Number(options.summaryChars) || 700);
    const minSavingsTokens = Math.max(0, Number(options.minSavingsTokens) || 512);

    const lastStart = Math.max(0, messages.length - keepLastN);
    let savedChars = 0;
    let compacted = 0;

    const out = messages.map((msg, i) => {
      if (!msg || i < keepFirstN || i >= lastStart || hasToolBlocks(msg)) return msg;
      const text = textFromContent(msg.content);
      if (text.length < minChars) return msg;
      const summary = summarizeText(text, summaryChars);
      if (approxTokens(text) - approxTokens(summary) < minSavingsTokens) return msg;
      savedChars += text.length - summary.length;
      compacted++;
      const prefix = `[Middle context summary of older ${msg.role || 'message'} turn; preserve recent/tool history for exact execution]\n`;
      if (typeof msg.content === 'string') return { ...msg, content: prefix + summary };
      return { ...msg, content: [{ type: 'text', text: prefix + summary }] };
    });

    return { messages: compacted ? out : messages, savedChars, compacted };
  }
}

module.exports = MiddleContextCompactor;
