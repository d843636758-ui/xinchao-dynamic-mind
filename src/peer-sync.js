import { createHash } from 'node:crypto';
import { PeerMcpClient } from './peer-mcp-client.js';

function safeError(error) {
  return String(error?.message || 'peer MCP unavailable')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function bounded(value, maxChars = 24000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxChars) return value ?? null;
  return { truncated: true, preview: text.slice(0, maxChars) };
}

export class PeerSync {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.cache = new Map();
    this.inflight = null;
    this.clients = new Map(
      Object.entries(config.sources ?? {})
        .filter(([, source]) => source.url && source.token)
        .map(([name, source]) => [name, new PeerMcpClient({
          name,
          ...source,
          timeoutMs: config.timeoutMs,
        })]),
    );
  }

  configuredSources() {
    return [...this.clients.keys()];
  }

  async readSource(name, client, force, now) {
    const previous = this.cache.get(name);
    if (!force && previous?.ok && Date.parse(previous.checkedAt) + this.config.ttlSeconds * 1000 > now.getTime()) {
      return previous;
    }
    try {
      const data = bounded(await client.read());
      const result = {
        ok: true,
        stale: false,
        source: name,
        tool: client.tool,
        checkedAt: now.toISOString(),
        data,
        digest: createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16),
      };
      this.cache.set(name, result);
      return result;
    } catch (error) {
      const message = safeError(error);
      this.log('peer_sync_failed', { source: name, message });
      if (previous?.ok) return { ...previous, stale: true, error: message };
      const result = { ok: false, stale: false, source: name, tool: client.tool, checkedAt: now.toISOString(), error: message };
      this.cache.set(name, result);
      return result;
    }
  }

  async snapshot({ force = false, now = new Date() } = {}) {
    if (!this.config.enabled) {
      return { version: 1, enabled: false, generatedAt: now.toISOString(), sources: {} };
    }
    if (this.inflight && !force) return this.inflight;
    const run = async () => {
      const entries = await Promise.all(
        [...this.clients.entries()].map(async ([name, client]) => [name, await this.readSource(name, client, force, now)]),
      );
      return { version: 1, enabled: true, generatedAt: now.toISOString(), sources: Object.fromEntries(entries) };
    };
    this.inflight = run().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

