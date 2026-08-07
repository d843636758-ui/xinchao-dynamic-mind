import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServiceToken } from '../src/service-token.js';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectDir, 'src', 'server.js');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test('explicit SERVICE_TOKEN remains the first choice', async () => {
  const value = 'explicit-service-token-0123456789abcdef';
  const result = await resolveServiceToken(value, '/unused/token');
  assert.deepEqual(result, { token: value, source: 'environment' });
});

test('missing SERVICE_TOKEN is generated once and reused from a private file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-service-token-'));
  const tokenFile = join(directory, 'state', '.service-token');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = await resolveServiceToken('', tokenFile);
  assert.equal(first.source, 'generated');
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), first.token);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);

  const second = await resolveServiceToken('', tokenFile);
  assert.deepEqual(second, { token: first.token, source: 'file' });
});

test('weak explicit or persisted tokens still fail closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-service-token-'));
  const tokenFile = join(directory, '.service-token');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(resolveServiceToken('short', tokenFile), /at least 32 characters/);
  await writeFile(tokenFile, 'replace-with-a-random-secret\n', { mode: 0o600 });
  await assert.rejects(resolveServiceToken('', tokenFile), /still a placeholder/);
});

test('the HTTP service boots safely without a SERVICE_TOKEN environment variable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-token-boot-'));
  const tokenFile = join(directory, '.service-token');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    STATE_PATH: join(directory, 'state.json'),
    SERVICE_TOKEN_FILE: tokenFile,
    TRANSITION_JOURNAL_PATH: join(directory, 'transitions.jsonl'),
    OAUTH_STATE_PATH: join(directory, 'oauth.json'),
    OMBRE_HEARTBEAT_FILE: join(directory, 'missing-heartbeat.json'),
    SETTLE_INTERVAL_MINUTES: '1440',
  };
  delete env.SERVICE_TOKEN;

  const output = { value: '' };
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`service exited early: ${output.value}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      // The process may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(response?.status, 200, output.value);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.serviceCredential, 'generated');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.match((await readFile(tokenFile, 'utf8')).trim(), /^[a-f0-9]{64}$/);
});
