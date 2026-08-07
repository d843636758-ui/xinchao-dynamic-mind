function parseMcpBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('data:')) return JSON.parse(trimmed);
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  return data ? JSON.parse(data) : null;
}

function resultData(message) {
  const result = message?.result ?? message;
  if (result?.isError) {
    const detail = (result.content ?? []).map((part) => part?.text).filter(Boolean).join('\n');
    throw new Error(detail || 'peer MCP tool returned an error');
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = (result?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

export class PeerMcpClient {
  constructor({ name, url, token, tool, args = {}, timeoutMs = 15000 }) {
    this.name = name;
    this.url = url;
    this.token = token;
    this.tool = tool;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.initializePromise = null;
  }

  async post(payload, expectBody = true) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
      'X-Xinchao-Caller': 'peer-sync',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`${this.name} MCP HTTP ${response.status}`);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (!expectBody) return null;
    return parseMcpBody(await response.text());
  }

  async initialize() {
    if (this.sessionId) return;
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.post({
          jsonrpc: '2.0',
          id: `${this.name}-initialize`,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'xinchao-dynamic-mind', version: '2.7.0' },
          },
        });
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
      })().finally(() => { this.initializePromise = null; });
    }
    return this.initializePromise;
  }

  async read() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.initialize();
      try {
        const message = await this.post({
          jsonrpc: '2.0',
          id: `${this.name}-${Date.now()}`,
          method: 'tools/call',
          params: { name: this.tool, arguments: this.args },
        });
        return resultData(message);
      } catch (error) {
        if (attempt || !/HTTP (400|404)/.test(error.message)) throw error;
        this.sessionId = null;
      }
    }
    throw new Error(`${this.name} MCP read failed after session refresh`);
  }
}

