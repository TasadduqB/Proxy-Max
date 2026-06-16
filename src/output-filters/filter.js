/**
 * Output Filters - TOML DSL pipeline
 * 8-stage filter pipeline: strip_ansi → replace → match_output → strip/keep_lines →
 * truncate_lines_at → head/tail_lines → max_lines → on_empty
 */

const fs = require('fs');
const path = require('path');

class OutputFilter {
  constructor(tomlConfig = {}) {
    this.config = tomlConfig;
    this.ansiRegex = /\x1b\[[0-9;]*m/g; // ANSI color codes
  }

  /**
   * Apply filter pipeline to output
   */
  apply(output) {
    let result = output;

    // Stage 1: Strip ANSI codes
    if (this.config.strip_ansi !== false) {
      result = result.replace(this.ansiRegex, '');
    }

    // Stage 2: Replace patterns
    if (this.config.replace && Array.isArray(this.config.replace)) {
      this.config.replace.forEach(({ pattern, replacement }) => {
        try {
          const regex = new RegExp(pattern, 'g');
          result = result.replace(regex, replacement);
        } catch (e) {
          // Skip invalid regex
        }
      });
    }

    // Stage 3: Match output (keep only matching lines)
    if (this.config.match_output) {
      const regex = new RegExp(this.config.match_output, 'gm');
      const matches = result.match(regex) || [];
      result = matches.join('\n');
    }

    // Stage 4: Strip or keep lines matching pattern
    if (this.config.strip_lines_matching) {
      const patterns = Array.isArray(this.config.strip_lines_matching)
        ? this.config.strip_lines_matching
        : [this.config.strip_lines_matching];
      
      const lines = result.split('\n');
      result = lines
        .filter(line => !patterns.some(p => new RegExp(p).test(line)))
        .join('\n');
    }

    if (this.config.keep_lines_matching) {
      const patterns = Array.isArray(this.config.keep_lines_matching)
        ? this.config.keep_lines_matching
        : [this.config.keep_lines_matching];
      
      const lines = result.split('\n');
      result = lines
        .filter(line => patterns.some(p => new RegExp(p).test(line)))
        .join('\n');
    }

    // Stage 5: Truncate lines at character count
    if (this.config.truncate_lines_at) {
      const lines = result.split('\n');
      result = lines
        .map(line => line.length > this.config.truncate_lines_at
          ? line.substring(0, this.config.truncate_lines_at) + '...'
          : line)
        .join('\n');
    }

    // Stage 6: Head/tail lines
    let lines = result.split('\n');
    
    if (this.config.head_lines) {
      lines = lines.slice(0, this.config.head_lines);
    }
    
    if (this.config.tail_lines) {
      lines = lines.slice(-this.config.tail_lines);
    }
    
    result = lines.join('\n');

    // Stage 7: Max total lines
    if (this.config.max_lines) {
      lines = result.split('\n');
      if (lines.length > this.config.max_lines) {
        lines = lines.slice(0, this.config.max_lines);
        lines.push(`... [${result.split('\n').length - this.config.max_lines} more lines]`);
      }
      result = lines.join('\n');
    }

    // Stage 8: On empty (if result is empty, show message)
    if (!result.trim() && this.config.on_empty) {
      result = this.config.on_empty;
    }

    return result;
  }

  /**
   * Load filter from TOML config
   */
  static fromTOML(tomlPath) {
    try {
      // Simple TOML parsing (minimal, just for our use case)
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const config = parseSimpleTOML(content);
      return new OutputFilter(config);
    } catch (e) {
      console.error(`Failed to load filter from ${tomlPath}:`, e.message);
      return new OutputFilter();
    }
  }
}

/**
 * Built-in filters for common commands
 */
const BUILTIN_FILTERS = {
  'cargo-test': {
    strip_ansi: true,
    strip_lines_matching: ['^\\s*$', '^running \\d+ test', '^test .* ok$', '^   Compiling'],
    keep_lines_matching: ['^test .* FAILED', '^thread .* panicked', '^error:'],
    max_lines: 30,
    on_empty: 'OK: all tests passed',
  },

  'cargo-build': {
    strip_ansi: true,
    strip_lines_matching: ['^   Compiling', '^    Finished', '^Blocking waiting'],
    keep_lines_matching: ['^error', '^warning'],
    max_lines: 20,
    on_empty: 'OK: build successful',
  },

  'git-status': {
    strip_ansi: true,
    strip_lines_matching: ['^On branch', '^Your branch', '^nothing to commit'],
    keep_lines_matching: ['modified:', 'new file:', 'deleted:', 'Untracked files:'],
    max_lines: 50,
  },

  'npm-test': {
    strip_ansi: true,
    strip_lines_matching: ['^$', 'passing', 'pending', '✓'],
    keep_lines_matching: ['failing', '✗', 'Error'],
    max_lines: 25,
  },

  'pytest': {
    strip_ansi: true,
    strip_lines_matching: ['^collecting', 'collected', 'PASSED'],
    keep_lines_matching: ['FAILED', 'ERROR', 'assert'],
    max_lines: 30,
  },

  'docker-ps': {
    strip_ansi: true,
    truncate_lines_at: 100,
    max_lines: 50,
  },

  'ls': {
    strip_ansi: true,
    head_lines: 100,
  },

  'grep': {
    strip_ansi: true,
    max_lines: 50,
  },
};

/**
 * Simple TOML parser (minimal, for our config format)
 */
function parseSimpleTOML(content) {
  const result = {};
  const lines = content.split('\n');
  let currentSection = null;

  lines.forEach(line => {
    line = line.trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) return;

    // Section header
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      result[currentSection] = result[currentSection] || {};
      return;
    }

    // Key-value pair
    const [key, ...valueParts] = line.split('=');
    if (valueParts.length === 0) return;

    const keyTrimmed = key.trim();
    const valueTrimmed = valueParts.join('=').trim();
    const target = currentSection ? (result[currentSection] ||= {}) : result;

    // Parse value
    if (valueTrimmed === 'true' || valueTrimmed === 'false') {
      target[keyTrimmed] = valueTrimmed === 'true';
    } else if (/^\d+$/.test(valueTrimmed)) {
      target[keyTrimmed] = parseInt(valueTrimmed);
    } else if (valueTrimmed.startsWith('[') && valueTrimmed.endsWith(']')) {
      // Array
      target[keyTrimmed] = JSON.parse(valueTrimmed);
    } else {
      // String
      target[keyTrimmed] = valueTrimmed.replace(/^["']|["']$/g, '');
    }
  });

  return result;
}

module.exports = {
  OutputFilter,
  BUILTIN_FILTERS,
  parseSimpleTOML,
};
