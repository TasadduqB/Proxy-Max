/**
 * Tool Result Filter
 * Applied at the proxy layer to tool_result content blocks inside user messages.
 * Strips ANSI codes, removes blank lines, and hard-truncates very long outputs.
 *
 * This is the proxy-transparent equivalent of the dashboard "Output Filters" tab —
 * no manual copy-paste required; every tool result is filtered automatically.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const BLANK_LINE_RE = /(\n[ \t]*){2,}/g;

class ToolResultFilter {
  /**
   * @param {object} options
   * @param {boolean} [options.stripAnsi=true]       strip ANSI escape codes (display-only; content-preserving)
   * @param {boolean} [options.stripBlankLines=false] collapse blank runs (lossy on whitespace-sensitive content)
   * @param {number}  [options.maxChars=0]            per tool_result cap; 0 disables truncation entirely
   */
  constructor(options = {}) {
    this.stripAnsi       = options.stripAnsi !== false;
    this.stripBlankLines = options.stripBlankLines === true;
    this.maxChars        = Number(options.maxChars) || 0; // 0 = no truncation
  }

  _filterText(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    if (this.stripAnsi)       out = out.replace(ANSI_RE, '');
    if (this.stripBlankLines) out = out.replace(BLANK_LINE_RE, '\n');
    if (this.maxChars > 0 && out.length > this.maxChars) {
      out = out.slice(0, this.maxChars) + `\n… [truncated — ${text.length - this.maxChars} chars omitted]`;
    }
    return out;
  }

  /**
   * Filter tool_result content blocks in the messages array.
   * Returns { messages, savedChars, filteredCount }.
   */
  filterMessages(messages) {
    if (!Array.isArray(messages)) return { messages, savedChars: 0, filteredCount: 0 };

    let savedChars    = 0;
    let filteredCount = 0;

    const out = messages.map(msg => {
      if (!msg || !Array.isArray(msg.content)) return msg;

      const newContent = msg.content.map(block => {
        if (!block || block.type !== 'tool_result') return block;

        // content can be a string or an array of blocks
        if (typeof block.content === 'string') {
          const filtered = this._filterText(block.content);
          if (filtered !== block.content) {
            savedChars += block.content.length - filtered.length;
            filteredCount++;
            return { ...block, content: filtered };
          }
          return block;
        }

        if (Array.isArray(block.content)) {
          let changed = false;
          const newBlocks = block.content.map(inner => {
            if (!inner || inner.type !== 'text' || typeof inner.text !== 'string') return inner;
            const filtered = this._filterText(inner.text);
            if (filtered !== inner.text) {
              savedChars += inner.text.length - filtered.length;
              filteredCount++;
              changed = true;
              return { ...inner, text: filtered };
            }
            return inner;
          });
          return changed ? { ...block, content: newBlocks } : block;
        }

        return block;
      });

      const contentChanged = newContent.some((b, i) => b !== msg.content[i]);
      return contentChanged ? { ...msg, content: newContent } : msg;
    });

    return { messages: out, savedChars, filteredCount };
  }
}

module.exports = ToolResultFilter;
