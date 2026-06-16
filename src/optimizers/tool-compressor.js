/**
 * Tool Compressor
 * Trims verbose tool descriptions while preserving name and input_schema exactly.
 * Only modifies the "description" string field — never touches schema structure.
 */

// Patterns that tend to appear in long tool descriptions but add little signal.
const FLUFF_PATTERNS = [
  /\n+Examples?:[\s\S]*?(?=\n\n[A-Z]|\n+##|\n+Usage|\n+Note|\n+Important|$)/gi,
  /\n+Usage:[\s\S]*?(?=\n\n[A-Z]|\n+##|\n+Note|\n+Important|$)/gi,
  /\n+Note:[\s\S]*?(?=\n\n[A-Z]|\n+##|$)/gi,
  /\(default[s]? .*?\)/gi,
];

class ToolCompressor {
  /**
   * @param {Array} tools
   * @param {{ maxDescLength?: number, stripExamples?: boolean }} options
   * @returns {{ tools: Array, savedChars: number, originalChars: number }}
   */
  compress(tools, options = {}) {
    const maxDescLength = options.maxDescLength ?? 300;
    const stripExamples = options.stripExamples !== false;

    if (!Array.isArray(tools) || tools.length === 0) {
      return { tools, savedChars: 0, originalChars: 0 };
    }

    let savedChars = 0;
    let originalChars = 0;

    const compressed = tools.map(tool => {
      if (!tool || typeof tool !== 'object') return tool;
      if (typeof tool.description !== 'string') return tool;

      const original = tool.description;
      originalChars += original.length;
      let desc = original;

      if (stripExamples) {
        for (const pat of FLUFF_PATTERNS) {
          desc = desc.replace(pat, '');
        }
        desc = desc.replace(/\n{3,}/g, '\n\n').trim();
      }

      if (desc.length > maxDescLength) {
        // Prefer cutting at a sentence boundary
        const sentenceEnd = desc.lastIndexOf('.', maxDescLength);
        if (sentenceEnd > maxDescLength * 0.65) {
          desc = desc.slice(0, sentenceEnd + 1);
        } else {
          desc = desc.slice(0, maxDescLength).trimEnd() + '…';
        }
      }

      savedChars += Math.max(0, original.length - desc.length);
      return desc === original ? tool : { ...tool, description: desc };
    });

    return { tools: compressed, savedChars, originalChars };
  }
}

module.exports = ToolCompressor;
