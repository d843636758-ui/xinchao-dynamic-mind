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
  assert.equal(captured.args.auto, true);
  assert.equal(captured.args.source, 'xinchao-dream');
  assert.equal(captured.args.importance, 7);
  assert.equal(captured.args.tags, 'dream');
});
