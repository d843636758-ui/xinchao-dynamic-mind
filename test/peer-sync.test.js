import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PeerSync } from '../src/peer-sync.js';

async function mockMcp(t) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.headers.authorization, 'Bearer peer-secret');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Mcp-Session-Id', 'peer-session');
    if (body.method === 'notifications/initialized') {
      response.writeHead(202); response.end(); return;
    }
    if (body.method === 'initialize') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    calls += 1;
    assert.equal(body.params.name, 'get_current_mood');
    response.end(JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: '{"mood":"warm"}' }], isError: false },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls: () => calls };
}

test('peer sync reads allowlisted tools and reuses its short cache', async (t) => {
  const mock = await mockMcp(t);
  const sync = new PeerSync({
    enabled: true, ttlSeconds: 60, timeoutMs: 2000,
    sources: { emotion: { url: mock.url, token: 'peer-secret', tool: 'get_current_mood', args: {} } },
  });
  const first = await sync.snapshot();
  const second = await sync.snapshot();
  assert.equal(first.sources.emotion.ok, true);
  assert.deepEqual(first.sources.emotion.data, { mood: 'warm' });
  assert.equal(second.sources.emotion.digest, first.sources.emotion.digest);
  assert.equal(mock.calls(), 1);
});

test('disabled peer sync performs no network work', async () => {
  const sync = new PeerSync({ enabled: false, ttlSeconds: 60, timeoutMs: 1000, sources: {} });
  assert.deepEqual((await sync.snapshot()).sources, {});
  assert.deepEqual(sync.status().sources, {});
});

test('a failed refresh keeps the last successful snapshot and marks it stale', async () => {
  const sync = new PeerSync({ enabled: true, ttlSeconds: 60, timeoutMs: 1000, sources: {} });
  let fail = false;
  sync.clients.set('eventide', {
    tool: 'get_full_state',
    read: async () => {
      if (fail) throw new Error('temporary outage');
      return { body: { energy: 0.7 } };
    },
  });
  const first = await sync.snapshot({ force: true });
  fail = true;
  const second = await sync.snapshot({ force: true });
  assert.equal(first.sources.eventide.stale, false);
  assert.equal(second.sources.eventide.ok, true);
  assert.equal(second.sources.eventide.stale, true);
  assert.deepEqual(second.sources.eventide.data, first.sources.eventide.data);
  assert.match(second.sources.eventide.error, /temporary outage/);
});

test('peer sync status exposes health metadata but never URL, token or raw data', async () => {
  const sync = new PeerSync({
    enabled: true,
    ttlSeconds: 60,
    timeoutMs: 1000,
    sources: {
      emotion: {
        url: 'https://emotion.example.com/mcp',
        token: 'never-return-this-token',
        tool: 'current_mood',
        args: {},
      },
    },
  });
  sync.cache.set('emotion', {
    ok: true,
    stale: false,
    source: 'emotion',
    tool: 'current_mood',
    checkedAt: '2026-08-08T00:00:00.000Z',
    data: { private: 'never-return-this-state' },
    digest: 'abc123',
  });
  const raw = JSON.stringify(sync.status());
  assert.match(raw, /current_mood/);
  assert.match(raw, /abc123/);
  assert.doesNotMatch(raw, /emotion\.example\.com|never-return-this-token|never-return-this-state/);
});
