/**
 * Tool Result Filter
 * Applied at the proxy layer to tool_result content blocks inside user messages.
 * Strips ANSI codes, removes blank lines, deduplicates repeated log lines,
 * and hard-truncates very long outputs.
 *
 * Includes RTK-style smart per-command-type compression: detects git-diff,
 * git-log, npm, cargo, test, and docker output and applies targeted filters.
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
   * @param {boolean} [options.dedupeLines=false]     collapse repeated adjacent log lines
   * @param {number}  [options.maxChars=0]            per tool_result cap; 0 disables truncation entirely
   * @param {boolean} [options.smartFilter=true]      enable RTK-style per-command-type compression
   */
  constructor(options = {}) {
    this.stripAnsi       = options.stripAnsi !== false;
    this.stripBlankLines = options.stripBlankLines === true;
    this.dedupeLines     = options.dedupeLines === true;
    this.maxChars        = Number(options.maxChars) || 0; // 0 = no truncation
    this.smartFilter     = options.smartFilter !== false;
  }

  /**
   * Detect the type of command output from content patterns.
   * Inspects first 1500 chars only for performance.
   * @param {string} text
   * @returns {'git-diff'|'git-log'|'npm'|'cargo'|'test'|'docker'|'generic'}
   */
  _detectCommandType(text) {
    const sample = text.slice(0, 1500);

    // git-diff: starts with diff header markers
    if (/^diff --git |^--- a\/|^\+\+\+ b\/|^@@ |^index [0-9a-f]/m.test(sample)) {
      return 'git-diff';
    }

    // git-log: multiple lines with commit hash patterns
    const commitMatches = sample.match(/^commit [0-9a-f]{7,40}$/gm) || [];
    const shortHashMatches = sample.match(/^[0-9a-f]{7,12} /gm) || [];
    if (commitMatches.length >= 2 || shortHashMatches.length >= 3) {
      return 'git-log';
    }

    // npm
    if (/npm warn|npm err|added \d+ packages|npm notice|audited|node_modules/i.test(sample)) {
      return 'npm';
    }

    // cargo
    if (/Compiling |Finished |error\[E|warning\[E|   Downloading/.test(sample)) {
      return 'cargo';
    }

    // test output
    if (/PASS |FAIL |Tests:|passed|failed|[✓✗]|● |describe\(/.test(sample)) {
      return 'test';
    }

    // docker
    if (/Step \d+\/\d+:|---> |Successfully built/.test(sample)) {
      return 'docker';
    }

    return 'generic';
  }

  /**
   * Apply RTK-style smart compression based on detected command type.
   * @param {string} text
   * @param {string} [toolName]
   * @returns {string}
   */
  _smartFilter(text, toolName) {
    const type = this._detectCommandType(text);
    if (type === 'generic') return text;

    const lines = text.split('\n');

    if (type === 'git-diff') {
      return this._filterGitDiff(lines);
    }
    if (type === 'git-log') {
      return this._filterGitLog(text, lines);
    }
    if (type === 'npm') {
      return this._filterNpm(lines);
    }
    if (type === 'cargo') {
      return this._filterCargo(lines);
    }
    if (type === 'test') {
      return this._filterTest(lines);
    }
    if (type === 'docker') {
      return this._filterDocker(lines);
    }

    return text;
  }

  _filterGitDiff(lines) {
    if (lines.length <= 60) return lines.join('\n');

    const kept = [];
    let omitCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isHeader = /^diff --git |^--- |^\+\+\+ |^@@ |^index [0-9a-f]/.test(line);
      const isChange = /^[+-]/.test(line) && !/^---/.test(line) && !/^\+\+\+/.test(line);

      if (i < 60) {
        kept.push(line);
        continue;
      }

      if (isHeader) {
        if (omitCount > 0) {
          kept.push(`… [${omitCount} lines of diff context omitted]`);
          omitCount = 0;
        }
        kept.push(line);
      } else if (isChange) {
        if (omitCount > 0) {
          kept.push(`… [${omitCount} lines of diff context omitted]`);
          omitCount = 0;
        }
        kept.push(line.length > 200 ? line.slice(0, 200) + '…' : line);
      } else {
        omitCount++;
      }
    }

    if (omitCount > 0) {
      kept.push(`… [${omitCount} lines of diff context omitted]`);
    }

    return kept.join('\n');
  }

  _filterGitLog(text, lines) {
    // Keep first 500 chars as-is for summary
    const prefix = text.slice(0, 500);

    // Find commit lines
    const commitLineRe = /^(commit [0-9a-f]{7,40}|[0-9a-f]{7,12} )/;
    const commitIndices = [];
    for (let i = 0; i < lines.length; i++) {
      if (commitLineRe.test(lines[i])) commitIndices.push(i);
    }

    if (commitIndices.length <= 15) {
      // Strip author emails and full timestamps, keep the rest
      return lines.map(line => {
        // Strip email from Author line: keep name only
        line = line.replace(/^(Author:\s+[^<]+)<[^>]+>/, '$1').trimEnd();
        // Shorten timestamp: keep date only (strip time and timezone)
        line = line.replace(/^(Date:\s+\w+ \w+ \d+ )\d+:\d+:\d+ \d+ [+-]\d+/, '$1');
        return line;
      }).join('\n');
    }

    // Too many commits — keep max 15
    const keptCommits = commitIndices.slice(0, 15);
    const lastKeptEnd = commitIndices[15] !== undefined ? commitIndices[15] : lines.length;
    const omitted = commitIndices.length - 15;

    const kept = [];
    for (let i = 0; i < lastKeptEnd; i++) {
      let line = lines[i];
      line = line.replace(/^(Author:\s+[^<]+)<[^>]+>/, '$1').trimEnd();
      line = line.replace(/^(Date:\s+\w+ \w+ \d+ )\d+:\d+:\d+ \d+ [+-]\d+/, '$1');
      kept.push(line);
    }
    kept.push(`… [${omitted} more commits]`);
    return kept.join('\n');
  }

  _filterNpm(lines) {
    const out = [];
    let deprecatedCount = 0;
    const spinnerRe = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    const treePackageRe = /^\s+[└├─│+\\]/;

    for (const line of lines) {
      // Always keep error lines
      if (/^npm ERR!/i.test(line)) { out.push(line); continue; }
      // Count deprecated warnings, strip them
      if (/^npm WARN deprecated/i.test(line)) { deprecatedCount++; continue; }
      // Strip notice lines
      if (/^npm notice/i.test(line)) continue;
      // Strip progress spinners
      if (spinnerRe.test(line)) continue;
      // Strip timing lines
      if (/^npm timing/i.test(line)) continue;
      // Strip http fetch lines
      if (/^npm http/i.test(line)) continue;
      // Strip tree-format package name-only lines
      if (treePackageRe.test(line)) continue;
      out.push(line);
    }

    if (deprecatedCount > 0) {
      out.push(`… [${deprecatedCount} npm WARN deprecated notices omitted]`);
    }

    return out.join('\n');
  }

  _filterCargo(lines) {
    const out = [];
    let compilingCount = 0;
    let downloadingCount = 0;

    for (const line of lines) {
      // Always keep errors, warnings, finished, arrows
      if (/^\s*(error\[E|warning\[|Finished |error:|-->)/.test(line)) {
        out.push(line);
        continue;
      }
      // Count and strip Compiling lines
      if (/^\s+Compiling /.test(line)) { compilingCount++; continue; }
      // Count and strip Downloading lines
      if (/^\s+Downloading/.test(line)) { downloadingCount++; continue; }
      out.push(line);
    }

    if (compilingCount > 0) {
      out.push(`… [compiled ${compilingCount} crates]`);
    }
    if (downloadingCount > 0) {
      out.push(`… [downloaded ${downloadingCount} crates]`);
    }

    return out.join('\n');
  }

  _filterTest(lines) {
    const out = [];
    let passCount = 0;

    for (const line of lines) {
      // Keep failures and errors
      if (/[✗]|FAIL|● |Error:|TypeError:|expected|received/.test(line)) {
        out.push(line); continue;
      }
      // Keep summary lines
      if (/^Tests:|^Test Suites:|^Time:|^Ran \d+ test/.test(line)) {
        out.push(line); continue;
      }
      // Strip individual pass lines
      if (/^\s+[✓]\s|^\s+✓ /.test(line)) {
        passCount++;
        continue;
      }
      out.push(line);
    }

    if (passCount > 0) {
      out.push(`… [${passCount} tests passed]`);
    }

    return out.join('\n');
  }

  _filterDocker(lines) {
    const out = [];

    for (const line of lines) {
      // Strip intermediate container lines
      if (/^---> Running in /.test(line)) continue;
      if (/^Removing intermediate container/.test(line)) continue;
      out.push(line);
    }

    // Limit to 50 lines total
    if (out.length > 50) {
      const trimmed = out.slice(0, 50);
      trimmed.push(`… [${out.length - 50} more docker lines omitted]`);
      return trimmed.join('\n');
    }

    return out.join('\n');
  }

  _filterText(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    if (this.stripAnsi)       out = out.replace(ANSI_RE, '');
    // Smart filter runs AFTER ANSI strip but BEFORE other operations
    if (this.smartFilter)     out = this._smartFilter(out);
    if (this.stripBlankLines) out = out.replace(BLANK_LINE_RE, '\n');
    if (this.dedupeLines)     out = this._dedupeAdjacentLines(out);
    if (this.maxChars > 0 && out.length > this.maxChars) {
      out = out.slice(0, this.maxChars) + `\n… [truncated — ${text.length - this.maxChars} chars omitted]`;
    }
    return out;
  }

  _dedupeAdjacentLines(text) {
    const lines = text.split('\n');
    const out = [];
    let last = null;
    let count = 0;
    const flush = () => {
      if (last === null) return;
      out.push(last);
      if (count > 1) out.push(`… [repeated ${count - 1} more times]`);
    };
    for (const line of lines) {
      if (line === last) { count++; continue; }
      flush();
      last = line;
      count = 1;
    }
    flush();
    return out.join('\n');
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
