/**
 * SQLite store — backed by Node's built-in `node:sqlite` (no native compile,
 * ships with Node 22.5+). Falls back to a JSON file if `node:sqlite` is missing
 * (older Node) so the app is always plug-and-play and startup can never break.
 *
 * Holds two things:
 *   • response_cache  — the lossless exact-match response cache (real table)
 *   • kv              — a key/value table the analytics engine persists into
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DATA_DIR      = path.join(os.homedir(), '.proxy-max');
const DB_FILE       = path.join(DATA_DIR, 'proxy-max.db');
const JSON_FALLBACK = path.join(DATA_DIR, 'store-fallback.json');
const FALLBACK_MAX_CACHE = 1000; // cap JSON-fallback cache entries

function loadNodeSqlite() {
  // Suppress only the one-line "SQLite is experimental" warning during require.
  const orig = process.emitWarning;
  process.emitWarning = (w, ...a) => {
    if (String(w).includes('SQLite')) return;
    return orig.call(process, w, ...a);
  };
  try {
    const mod = require('node:sqlite');
    return mod.DatabaseSync || null;
  } catch {
    return null;
  } finally {
    process.emitWarning = orig;
  }
}

class SqliteStore {
  constructor(opts = {}) {
    this.dbFile = opts.dbFile || DB_FILE;
    this.backend = 'none';
    this.db = null;
    this._mem = { kv: {}, cache: {} };

    try { fs.mkdirSync(path.dirname(this.dbFile), { recursive: true }); } catch {}

    const DatabaseSync = loadNodeSqlite();
    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(this.dbFile);
        this.db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;
          PRAGMA temp_store = MEMORY;
          PRAGMA mmap_size = 268435456;
          PRAGMA cache_size = -20000;
          CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
          CREATE TABLE IF NOT EXISTS response_cache (
            key          TEXT PRIMARY KEY,
            provider     TEXT,
            model        TEXT,
            body         BLOB,
            content_type TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            created_at   INTEGER,
            expires_at   INTEGER,
            hits         INTEGER DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
        `);
        for (const ddl of [
          'ALTER TABLE response_cache ADD COLUMN stream INTEGER DEFAULT 0',
          'ALTER TABLE response_cache ADD COLUMN bytes INTEGER DEFAULT 0',
          'ALTER TABLE response_cache ADD COLUMN last_hit_at INTEGER DEFAULT 0',
        ]) { try { this.db.exec(ddl); } catch {} }
        this._cacheGetStmt = this.db.prepare('SELECT body, content_type, input_tokens, output_tokens, provider, model, expires_at FROM response_cache WHERE key = ?');
        this._cacheHitStmt = this.db.prepare('UPDATE response_cache SET hits = hits + 1, last_hit_at = ? WHERE key = ?');
        this._cacheDeleteStmt = this.db.prepare('DELETE FROM response_cache WHERE key = ?');
        this._kvGetStmt = this.db.prepare('SELECT v FROM kv WHERE k = ?');
        this._kvSetStmt = this.db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
        this.backend = 'sqlite';
        return;
      } catch (e) {
        this.db = null;
      }
    }

    // JSON fallback
    try { this._mem = JSON.parse(fs.readFileSync(JSON_FALLBACK, 'utf8')); }
    catch { this._mem = { kv: {}, cache: {} }; }
    if (!this._mem.kv) this._mem.kv = {};
    if (!this._mem.cache) this._mem.cache = {};
    this.backend = 'json';
  }

  ready()    { return this.backend !== 'none'; }
  isSqlite() { return this.backend === 'sqlite'; }
  info()     { return { backend: this.backend, dbFile: this.backend === 'sqlite' ? this.dbFile : JSON_FALLBACK }; }

  _saveJson() {
    if (this._jsonSaveTimer) return;
    this._jsonSaveTimer = setTimeout(() => {
      this._jsonSaveTimer = null;
      try { fs.writeFile(JSON_FALLBACK, JSON.stringify(this._mem), () => {}); } catch {}
    }, 100);
  }

  // ---- generic key/value (analytics persistence) ----
  kvGet(key) {
    if (this.backend === 'sqlite') {
      try {
        const row = this._kvGetStmt.get(key);
        return row ? JSON.parse(row.v) : null;
      } catch { return null; }
    }
    return this._mem.kv[key] ?? null;
  }
  kvSet(key, value) {
    const s = JSON.stringify(value);
    if (this.backend === 'sqlite') {
      try {
        this._kvSetStmt.run(key, s);
      } catch {}
    } else {
      this._mem.kv[key] = value;
      this._saveJson();
    }
  }

  // ---- response cache ----
  cacheGet(key) {
    const now = Date.now();
    if (this.backend === 'sqlite') {
      try {
        const row = this._cacheGetStmt.get(key);
        if (!row) return null;
        if (row.expires_at && row.expires_at < now) {
          this._cacheDeleteStmt.run(key);
          return null;
        }
        this._cacheHitStmt.run(now, key);
        return {
          body: Buffer.from(row.body),
          contentType: row.content_type,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          provider: row.provider,
          model: row.model,
        };
      } catch { return null; }
    }
    const e = this._mem.cache[key];
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < now) { delete this._mem.cache[key]; this._saveJson(); return null; }
    e.hits = (e.hits || 0) + 1; this._saveJson();
    return {
      body: Buffer.from(e.bodyB64, 'base64'),
      contentType: e.contentType,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      provider: e.provider,
      model: e.model,
    };
  }

  cacheSet(key, { body, contentType, inputTokens = 0, outputTokens = 0, ttlMs = 0, provider = '', model = '', stream = false }) {
    const now = Date.now();
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (this.backend === 'sqlite') {
      try {
        this.db.prepare(`INSERT INTO response_cache(key, provider, model, body, content_type, input_tokens, output_tokens, created_at, expires_at, hits, stream, bytes, last_hit_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
          ON CONFLICT(key) DO UPDATE SET body = excluded.body, content_type = excluded.content_type, created_at = excluded.created_at, expires_at = excluded.expires_at, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, stream = excluded.stream, bytes = excluded.bytes`)
          .run(key, provider, model, buf, contentType || '', inputTokens, outputTokens, now, expiresAt, stream ? 1 : 0, buf.length);
      } catch {}
    } else {
      this._mem.cache[key] = { bodyB64: buf.toString('base64'), contentType, inputTokens, outputTokens, provider, model, stream: !!stream, bytes: buf.length, createdAt: now, expiresAt, hits: 0, lastHitAt: 0 };
      const keys = Object.keys(this._mem.cache);
      if (keys.length > FALLBACK_MAX_CACHE) delete this._mem.cache[keys[0]];
      this._saveJson();
    }
  }

  cacheStats() {
    if (this.backend === 'sqlite') {
      try {
        const r = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(hits),0) hits, COALESCE(SUM(input_tokens + output_tokens),0) toks, COALESCE(SUM((input_tokens + output_tokens) * hits),0) served, COALESCE(SUM(CASE WHEN hits = 0 THEN input_tokens + output_tokens ELSE 0 END),0) stored_unserved FROM response_cache').get();
        return { entries: r.n, hits: r.hits, cachedTokens: r.toks, servedTokens: r.served, storedUnservedTokens: r.stored_unserved };
      } catch { return { entries: 0, hits: 0, cachedTokens: 0, servedTokens: 0, storedUnservedTokens: 0 }; }
    }
    const vals = Object.values(this._mem.cache);
    return {
      entries: vals.length,
      hits: vals.reduce((s, e) => s + (e.hits || 0), 0),
      cachedTokens: vals.reduce((s, e) => s + ((e.inputTokens || 0) + (e.outputTokens || 0)), 0),
      servedTokens: vals.reduce((s, e) => s + (((e.inputTokens || 0) + (e.outputTokens || 0)) * (e.hits || 0)), 0),
      storedUnservedTokens: vals.reduce((s, e) => s + ((e.hits || 0) === 0 ? ((e.inputTokens || 0) + (e.outputTokens || 0)) : 0), 0),
    };
  }

  cacheBackfillTokens({ inputTokens = 0, outputTokens = 0, provider = '', model = '' } = {}) {
    inputTokens = Math.max(0, Number(inputTokens) || 0);
    outputTokens = Math.max(0, Number(outputTokens) || 0);
    if (inputTokens + outputTokens <= 0) return 0;
    if (this.backend === 'sqlite') {
      try {
        const r = this.db.prepare(`UPDATE response_cache
          SET input_tokens = ?, output_tokens = ?, provider = COALESCE(NULLIF(provider, ''), ?), model = COALESCE(NULLIF(model, ''), ?)
          WHERE COALESCE(input_tokens,0) + COALESCE(output_tokens,0) = 0`).run(inputTokens, outputTokens, provider, model);
        return r.changes || 0;
      } catch { return 0; }
    }
    let n = 0;
    for (const e of Object.values(this._mem.cache)) {
      if (((e.inputTokens || 0) + (e.outputTokens || 0)) === 0) {
        e.inputTokens = inputTokens;
        e.outputTokens = outputTokens;
        if (!e.provider) e.provider = provider;
        if (!e.model) e.model = model;
        n++;
      }
    }
    if (n) this._saveJson();
    return n;
  }

  cachePrune() {
    const now = Date.now();
    if (this.backend === 'sqlite') {
      try { this.db.prepare('DELETE FROM response_cache WHERE expires_at > 0 AND expires_at < ?').run(now); } catch {}
    } else {
      for (const [k, e] of Object.entries(this._mem.cache)) if (e.expiresAt && e.expiresAt < now) delete this._mem.cache[k];
      this._saveJson();
    }
  }

  cacheClear() {
    if (this.backend === 'sqlite') {
      try { this.db.prepare('DELETE FROM response_cache').run(); } catch {}
    } else { this._mem.cache = {}; this._saveJson(); }
  }
}

module.exports = { SqliteStore, DB_FILE };
