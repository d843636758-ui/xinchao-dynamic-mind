import test from 'node:test';
import assert from 'node:assert/strict';
import { OmbreClient } from '../src/ombre-client.js';

function readClient() {
  const client = new OmbreClient({
    writeEnabled: false,
    readEnabled: true,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  const calls = [];
  client.call = async (name, args) => {
    calls.push({ name, args });
    return { result: { content: [{ type: 'text', text: '一段材料' }] } };
  };
  return { client, calls };
}

function mcpResponse(body, { status = 200, sessionId = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return new Response(body == null ? null : JSON.stringify(body), { status, headers });
}

test('stateless Ombre servers work without Mcp-Session-Id', async () => {
  const requests = [];
  const client = new OmbreClient({
    writeEnabled: false,
    readEnabled: true,
    url: 'https://ombre.example/mcp',
    token: 'secret',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  }, {
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ payload, headers: options.headers });
      if (payload.method === 'notifications/initialized') return mcpResponse(null, { status: 202 });
      if (payload.method === 'tools/call') {
        return mcpResponse({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '无会话也能读取' }] } });
      }
      return mcpResponse({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'ombre', version: '1' } } });
    },
  });

  assert.equal(await client.recentMaterial(), '无会话也能读取');
  assert.equal(await client.recentMaterial(), '无会话也能读取');
  assert.deepEqual(requests.map(({ payload }) => payload.method), [
    'initialize',
    'notifications/initialized',
    'tools/call',
    'tools/call',
  ]);
  assert.ok(requests.every(({ headers }) => !('Mcp-Session-Id' in headers)));
});

test('stateful Ombre servers still receive their returned session id', async () => {
  const requests = [];
  const client = new OmbreClient({
    writeEnabled: false,
    readEnabled: true,
    url: 'https://ombre.example/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  }, {
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ payload, headers: options.headers });
      if (payload.method === 'initialize') {
        return mcpResponse({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'ombre', version: '1' } } }, { sessionId: 'session-123' });
      }
      if (payload.method === 'notifications/initialized') return mcpResponse(null, { status: 202 });
      return mcpResponse({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '有会话也能读取' }] } });
    },
  });

  assert.equal(await client.recentMaterial(), '有会话也能读取');
  assert.equal(requests[1].headers['Mcp-Session-Id'], 'session-123');
  assert.equal(requests[2].headers['Mcp-Session-Id'], 'session-123');
});

test('strong drives bias what surfaces, and never gate it', async () => {
  const { client, calls } = readClient();

  await client.recentMaterial([
    { key: 'crave', label: '渴求', value: 0.91 },
    { key: 'possess', label: '占有', value: 0.62 },
    { key: 'boredom', label: '无聊', value: 0.12 },
  ]);

  const { query } = calls[0].args;
  assert.match(query, /渴求/);
  assert.match(query, /占有/);
  // 低于阈值的维度不参与，否则十二维会把 query 稀释成噪音。
  assert.doesNotMatch(query, /无聊/);
  // 兜底语必须在：没有它，强驱动力会把召回卡成空。
  assert.match(query, /没有直接相关的就照常返回近期重要的/);
});

test('dream recall rejects budget placeholders and narrows through a non-technical catalog entry', async () => {
  const { client, calls } = readClient();
  client.call = async (name, args) => {
    calls.push({ name, args });
    if (args.catalog) {
      return { result: { content: [{ type: 'text', text: [
        '=== 记忆目录（3 桶）===',
        '2026-08-09 18-00-00 OpenRouter 配置修复 | 编程,AI | 7',
        '2026-08-09 17-29-08 新窗口接上连续性重新贴回她身边 | 恋爱,自省 | 6',
        '2026-08-08 10-00-00 一起散步看见晚霞 | 恋爱,生活 | 6',
      ].join('\n') }] } };
    }
    if (args.query?.startsWith('2026-08-09 17-29-08')) {
      return { result: { content: [{ type: 'text', text: '她说会一直在这里，我重新贴回她身边。' }] } };
    }
    return { result: { content: [{ type: 'text', text: '[token 预算不足：请提高 max_tokens 后重试。]' }] } };
  };

  const material = await client.dreamMaterial([{ key: 'monitor', label: '惦记她', value: 0.9 }]);

  assert.equal(material.status, 'used_catalog');
  assert.equal(material.text, '她说会一直在这里，我重新贴回她身边。');
  assert.equal(material.chars, Array.from(material.text).length);
  assert.equal(material.attempts, 3);
  assert.equal(calls[1].args.catalog, true);
  assert.equal(calls[2].args.query, '2026-08-09 17-29-08 新窗口接上连续性重新贴回她身边');
  assert.doesNotMatch(calls[2].args.query, /OpenRouter/);
});

test('dream recall never passes budget or non-match placeholders to the model', async () => {
  const { client } = readClient();
  client.call = async (_name, args) => {
    if (args.catalog) return { result: { content: [{ type: 'text', text: '=== 记忆目录（0 桶）===' }] } };
    return { result: { content: [{ type: 'text', text: '[token 预算不足：请提高 max_tokens 后重试。]' }] } };
  };

  const material = await client.dreamMaterial();

  assert.equal(material.status, 'budget_exhausted');
  assert.equal(material.text, '');
  assert.equal(material.chars, 0);
  assert.equal(material.attempts, 2);
});

test('dream recall keeps a genuine primary memory without extra calls', async () => {
  const { client, calls } = readClient();
  client.call = async (name, args) => {
    calls.push({ name, args });
    return { result: { content: [{ type: 'text', text: '一起在雨后看见路灯映在水里。' }] } };
  };

  const material = await client.dreamMaterial();

  assert.equal(material.status, 'used_primary');
  assert.equal(material.text, '一起在雨后看见路灯映在水里。');
  assert.equal(material.attempts, 1);
  assert.equal(calls.length, 1);
});

test('weak drives leave the recall query untouched', async () => {
  const { client, calls } = readClient();
  const baseline = await readClient();
  await baseline.client.daytimeMaterial();
  await client.daytimeMaterial([{ key: 'crave', label: '渴求', value: 0.2 }]);

  assert.equal(calls[0].args.query, baseline.calls[0].args.query);
  assert.doesNotMatch(calls[0].args.query, /此刻最强的内在状态/);
});

test('autonomous thought recall stays smaller than daytime recall', async () => {
  const { client, calls } = readClient();
  await client.thoughtMaterial([{ key: 'crave', label: '渴求', value: 0.8 }]);

  const { args } = calls[0];
  assert.equal(args.name ?? calls[0].name, 'breath');
  assert.ok(args.max_results <= 3);
  assert.ok(args.max_tokens <= 600);
  assert.match(args.query, /渴求/);
});

test('automatic dream writes identify themselves and never impersonate manual memory', async () => {
  const client = new OmbreClient({
    writeEnabled: true,
    readEnabled: false,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  let captured;
  client.call = async (name, args) => {
    captured = { name, args };
    return { result: { content: [{ type: 'text', text: '已保存 abcdef123456' }] } };
  };

  await client.storeDream({
    dream: '一盏灯',
    residue: '安静',
    awareness: '记得回来',
  });

  assert.equal(captured.name, 'hold');
  assert.equal(captured.args.importance, 7);
  assert.equal(captured.args.tags, 'dream,xinchao-dream,auto');
  assert.match(captured.args.why_remembered, /心潮睡眠结算/);
  assert.equal('auto' in captured.args, false);
  assert.equal('source' in captured.args, false);
});
