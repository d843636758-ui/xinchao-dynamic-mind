import { createHash } from 'node:crypto';

export class OmbreClient {
  constructor(config, { fetchImpl = globalThis.fetch, sleepImpl = sleep } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.sessionId = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  async post(payload, expectBody = true) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Ombre-Caller': 'dynamic-mind',
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await this.fetch(this.config.url, {
      method: 'POST', headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Ombre MCP failed: HTTP ${response.status}`);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (!expectBody) return null;
    const text = await response.text();
    return text ? parseMcp(text, payload.id) : null;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.post({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'xinchao-dynamic-mind', version: '2.9.1' },
          },
        });
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
        // Mcp-Session-Id is optional in Streamable HTTP. Stateful servers
        // return one and post() reuses it; stateless servers intentionally do
        // not, so a successful initialization must still be remembered.
        this.initialized = true;
      })().finally(() => { this.initializePromise = null; });
    }
    return this.initializePromise;
  }

  async call(name, args = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.initialize();
      try {
        const response = await this.post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
        if (response?.error) throw new Error(`Ombre MCP error: ${mcpErrorMessage(response.error)}`);
        return response;
      } catch (error) {
        if (attempt || !/HTTP (400|404)/.test(error.message)) throw error;
        this.sessionId = null;
        this.initialized = false;
      }
    }
    throw new Error('Ombre MCP call failed after session refresh');
  }

  async recentMaterial(drives = []) {
    const result = await this.call('breath', {
      query: withDriveHint('近期重要记忆、情绪、关系变化和未完成事项', drives),
      max_results: this.config.breathMaxResults,
      max_tokens: this.config.breathMaxTokens
    });
    return extractText(result).slice(0, 10000);
  }

  async dreamMaterial(drives = [], options = {}) {
    const cooldown = dreamMemoryCooldown(options);
    const primaryRaw = extractText(await this.call('breath', {
      query: withDriveHint('近期重要记忆、情绪、关系变化和未完成事项', drives),
      max_results: this.config.breathMaxResults,
      max_tokens: this.config.breathMaxTokens,
    })).slice(0, 10000);
    const primary = cleanDreamMaterial(primaryRaw);
    const primaryKey = primary ? memoryTextKey(primary) : null;

    if (usableDreamMaterial(primary) && !cooldown.keys.has(primaryKey)) {
      return dreamMaterialResult(primary, 'used_primary', 1, { memoryKey: primaryKey });
    }

    const catalog = extractText(await this.call('breath', {
      catalog: true,
      // Pinned buckets are listed first. Fetch the server maximum so a full
      // pinned section cannot hide every recent dynamic memory.
      max_results: 50,
      max_tokens: 3000,
    })).slice(0, 16000);
    const selection = selectDreamCatalogEntry(catalog, cooldown);
    if (!selection.entry) {
      const repeatedPrimary = usableDreamMaterial(primary) && cooldown.keys.has(primaryKey);
      const status = repeatedPrimary || selection.cooledOut
        ? 'repeat_avoided'
        : recallFailureStatus(primaryRaw);
      return dreamMaterialResult('', status, 2);
    }

    const focusedRaw = extractText(await this.call('breath', {
      query: selection.entry.title,
      max_results: 1,
      max_tokens: 3000,
    })).slice(0, 10000);
    const focused = cleanDreamMaterial(focusedRaw);
    if (usableDreamMaterial(focused)) {
      return dreamMaterialResult(focused, 'used_catalog', 3, {
        memoryKey: selection.entry.key,
        memoryTitle: selection.entry.title,
      });
    }
    return dreamMaterialResult('', recallFailureStatus(focusedRaw || primaryRaw), 3);
  }

  async daytimeMaterial(drives = []) {
    const result = await this.call('breath', {
      query: withDriveHint('白天自然浮现的近期记忆、具体细节、未说完的话和当下牵挂；不要返回系统配置或技术信息', drives),
      max_results: this.config.breathMaxResults,
      max_tokens: this.config.breathMaxTokens
    });
    return extractText(result).slice(0, 10000);
  }

  // 自主念头用的材料：比日间浮现更短，只要能让念头落到具体的事上。
  async thoughtMaterial(drives = []) {
    const result = await this.call('breath', {
      query: withDriveHint('此刻自然想起的一件具体的事：最近的共同经历、说过的话或还惦记着的东西；不要返回系统配置、部署或技术信息', drives),
      max_results: Math.max(1, Math.min(3, Number(this.config.breathMaxResults) || 2)),
      max_tokens: Math.max(200, Math.min(600, Number(this.config.breathMaxTokens) || 400))
    });
    return extractText(result).slice(0, 4000);
  }

  async recentContinuityMaterial(maxTokens = this.config.breathMaxTokens) {
    const result = await this.call('breath', {
      query: [
        '新窗口近期连续性：只返回最近发生了什么，以及仍直接影响现在的人物与关系变化、生活重点和未完成约定。',
        '不要返回核心准则、自我基岩或长期画像；这些由客户端从自己的核心指令和长期记忆单独完整读取。',
        '不要返回部署、代码、接口、密钥、系统日志或已经过期的技术待办。',
      ].join(''),
      max_results: Math.max(3, Math.min(8, Number(this.config.breathMaxResults) || 3)),
      max_tokens: Math.max(200, Math.min(3000, Number(maxTokens) || 1600)),
    });
    return extractText(result).slice(0, 16000);
  }

  // Compatibility alias for older callers.  It intentionally returns only
  // recent continuity; it is not a replacement for repository bedrock.
  async handoffMaterial(maxTokens = this.config.breathMaxTokens) {
    return this.recentContinuityMaterial(maxTokens);
  }

  async storeDream(dream) {
    if (!this.config.writeEnabled) return null;
    const dreamId = String(dream?.id ?? '').trim();
    const marker = dreamId ? `心潮梦境ID：${dreamId}` : '';
    const content = [
      marker,
      `梦境：${dream.dream}`,
      `梦境余韵：${dream.residue}`,
      `醒后意识：${dream.awareness}`,
      '说明：这是睡眠结算产生的梦境，不是现实事件；调用外部记忆服务不等于醒来。'
    ].filter(Boolean).join('\n');
    try {
      const result = await this.call('hold', {
        content,
        tags: 'dream,xinchao-dream,auto',
        importance: 7,
        why_remembered: '由心潮睡眠结算自动生成并回存的梦境记录',
      });
      return dreamStorageResult(extractBucketId(extractText(result)));
    } catch (error) {
      // A write may commit before its HTTP/SSE acknowledgement is lost. Never
      // retry hold blindly: verify the unique marker so recovery cannot create
      // a duplicate dream bucket.
      if (!dreamId) throw error;
      const verified = await this.verifyStoredDream(dreamId);
      if (!verified.found) throw error;
      return {
        ...dreamStorageResult(verified.bucketId),
        recovered: true,
        verificationAttempts: verified.attempts,
      };
    }
  }

  async verifyStoredDream(dreamId) {
    const marker = `心潮梦境ID：${String(dreamId ?? '').trim()}`;
    if (marker === '心潮梦境ID：') return { found: false, bucketId: null, attempts: 0 };

    for (let attempt = 1; attempt <= DREAM_WRITE_VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await this.sleep(DREAM_WRITE_VERIFY_DELAYS_MS[attempt - 2]);
      try {
        const result = await this.call('breath', {
          query: marker,
          tags: 'dream,xinchao-dream,auto',
          max_results: 1,
          max_tokens: 3000,
        });
        const text = extractText(result);
        if (text.includes(marker)) {
          return { found: true, bucketId: extractBucketId(text), attempts: attempt };
        }
      } catch {
        // A verification read is safe to retry; the original write is not.
      }
    }
    return { found: false, bucketId: null, attempts: DREAM_WRITE_VERIFY_ATTEMPTS };
  }
}

// 把当前最强的几个驱动力拼进 breath 的 query，让"此刻想什么"影响"想起什么"。
//
// 这里只改排序，不改准入：能不能返回仍然由 Ombre 的 admission gate 判定
// （要有原句、词锚或高语义证据）。所以驱动力高不会凭空造出记忆，只会让
// 本来就有证据的那几条里，跟当下状态相关的先浮上来。末尾那句兜底很重要，
// 没有它的话强驱动力会把召回卡死成空。
function withDriveHint(base, drives) {
  const labels = (Array.isArray(drives) ? drives : [])
    .filter((item) => Number(item?.value) >= DRIVE_HINT_MIN)
    .slice(0, DRIVE_HINT_MAX_LABELS)
    .map((item) => String(item?.label ?? '').trim())
    .filter(Boolean);
  if (!labels.length) return base;
  return `${base}。此刻最强的内在状态是${labels.join('、')}，优先浮现与之真正相关的具体记忆；没有直接相关的就照常返回近期重要的`;
}

const DRIVE_HINT_MIN = 0.5;
const DRIVE_HINT_MAX_LABELS = 3;
const DREAM_MEMORY_FRAGMENT_MIN = 4;
const DREAM_WRITE_VERIFY_ATTEMPTS = 3;
const DREAM_WRITE_VERIFY_DELAYS_MS = [300, 900];
const DREAM_MEMORY_PLACEHOLDER = /token\s*预算不足|预算不足[^\n]*max_tokens|非检索命中/i;
const TECHNICAL_MEMORY = /心潮|dashboard|openrouter|mcp|oauth|token|部署|代码|编程|接口|配置|修复|测试|日志|zeabur/i;
const STORED_DREAM_MEMORY = /梦境|xinchao-dream|心潮梦境id/i;
const MEMORY_ENVELOPE_LINE = /^\[bucket_id:[^\]]+\](?:\s+\[[^\]]+\])+\s*$/i;
const MEMORY_FOOTPRINT_LINE = /^👣\s*Footprint[：:].*$/i;

// Ombre may return a budget warning for the next oversized bucket and still
// include one or more complete buckets that fit. The warning describes only
// the omitted bucket, so remove transport annotations while preserving every
// complete memory body already delivered.
function cleanDreamMaterial(value) {
  return String(value ?? '').split('\n')
    .filter((line) => !DREAM_MEMORY_PLACEHOLDER.test(line))
    .filter((line) => !MEMORY_ENVELOPE_LINE.test(line.trim()))
    .filter((line) => !MEMORY_FOOTPRINT_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function usableDreamMaterial(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !DREAM_MEMORY_PLACEHOLDER.test(text);
}

function recallFailureStatus(value) {
  return /token\s*预算不足|预算不足[^\n]*max_tokens/i.test(String(value ?? ''))
    ? 'budget_exhausted'
    : 'empty';
}

function dreamMaterialResult(text, status, attempts, memory = {}) {
  const clean = String(text ?? '').trim();
  return {
    text: clean,
    status,
    chars: Array.from(clean).length,
    attempts,
    memoryKey: String(memory.memoryKey ?? '').trim() || null,
    memoryTitle: String(memory.memoryTitle ?? '').trim() || null,
  };
}

function selectDreamCatalogEntry(value, cooldown) {
  const candidates = String(value ?? '').split('\n').flatMap((line) => {
    // Current Ombre prefixes pinned rows with a pin glyph. Older versions
    // emitted the same row without it. ID-only rows intentionally do not
    // match because they provide no useful query title.
    const match = line.match(/^[^\d]*(\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2})\s+(.+?)\s+\|\s+(.+?)\s+\|\s+\d+\s*$/u);
    if (!match) return [];
    const title = `${match[1]} ${match[2]}`.trim();
    const classification = `${match[2]} ${match[3]}`;
    if (!match[2].trim() || TECHNICAL_MEMORY.test(classification) || STORED_DREAM_MEMORY.test(classification)) return [];
    return [{
      timestamp: match[1],
      name: match[2].trim(),
      title,
      key: `catalog:${title}`,
    }];
  });
  candidates.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const eligible = candidates.filter((candidate) => (
    !cooldown.keys.has(candidate.key)
    && !cooldown.texts.some((text) => sharesMeaningfulFragment(candidate.name, text))
  ));
  if (!eligible.length) return { entry: null, cooledOut: candidates.length > 0 };
  const index = positiveModulo(cooldown.rotationSeed, eligible.length);
  return { entry: eligible[index], cooledOut: false };
}

function dreamMemoryCooldown(options = {}) {
  const keys = new Set((Array.isArray(options.excludeMemoryKeys) ? options.excludeMemoryKeys : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean));
  const texts = (Array.isArray(options.excludeMemoryTexts) ? options.excludeMemoryTexts : [])
    .map((value) => normalizeMemoryText(value))
    .filter(Boolean);
  const seed = Number(options.rotationSeed);
  return {
    keys,
    texts,
    rotationSeed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
  };
}

function memoryTextKey(value) {
  return `text:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 20)}`;
}

function sharesMeaningfulFragment(title, normalizedRecentText) {
  const normalizedTitle = normalizeMemoryText(title);
  if (!normalizedTitle || !normalizedRecentText) return false;
  if (Math.min(normalizedTitle.length, normalizedRecentText.length) < DREAM_MEMORY_FRAGMENT_MIN) return false;
  if (normalizedRecentText.includes(normalizedTitle) || normalizedTitle.includes(normalizedRecentText)) return true;
  for (let index = 0; index <= normalizedTitle.length - DREAM_MEMORY_FRAGMENT_MIN; index += 1) {
    if (normalizedRecentText.includes(normalizedTitle.slice(index, index + DREAM_MEMORY_FRAGMENT_MIN))) return true;
  }
  return false;
}

function normalizeMemoryText(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function parseMcp(text, expectedId = null) {
  const dataEvents = String(text).split(/\r?\n\r?\n+/).flatMap((block) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });
  if (!dataEvents.length) return JSON.parse(text);
  const matching = expectedId == null ? null : dataEvents.findLast((event) => (
    event?.id === expectedId && ('result' in event || 'error' in event)
  ));
  return matching
    ?? dataEvents.findLast((event) => event && ('result' in event || 'error' in event))
    ?? dataEvents.at(-1);
}

function extractText(result) {
  const content = result?.result?.content ?? result?.content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function extractBucketId(value) {
  const text = String(value ?? '');
  return text.match(/\[bucket_id:([a-f0-9]{12,})\]/i)?.[1]
    ?? text.match(/\b([a-f0-9]{12,})\b/i)?.[1]
    ?? null;
}

function dreamStorageResult(bucketId) {
  return {
    bucketId: bucketId ?? null,
    status: bucketId ? 'stored' : 'accepted',
    recovered: false,
    verificationAttempts: 0,
  };
}

function mcpErrorMessage(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'unknown JSON-RPC error';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
