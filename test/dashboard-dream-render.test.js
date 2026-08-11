import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('dashboard browser script is syntactically valid', () => {
  const scriptPath = fileURLToPath(new URL('../public/dashboard.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('private dream cards render every private field instead of choosing only one', async () => {
  const source = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');

  assert.match(source, /\['梦境正文', dream\.dream\]/);
  assert.match(source, /\['梦境余韵', dream\.residue\]/);
  assert.match(source, /\['醒后意识', dream\.awareness\]/);
  assert.match(source, /for \(const \[label, value\] of fields\)/);
  assert.doesNotMatch(
    source,
    /dream\.summary \|\| dream\.awareness \|\| dream\.residue \|\| dream\.dream/,
  );
  assert.match(source, /OB 精准记忆/);
  assert.match(source, /OB 记忆超出预算/);
  assert.match(source, /OB 记忆避重复/);
  assert.match(source, /已回存 OB/);
});

test('private dream copy has readable mobile-safe styling', async () => {
  const source = await readFile(new URL('../public/dashboard.css', import.meta.url), 'utf8');

  assert.match(source, /\.dream-copy-list/);
  assert.match(source, /\.dream-copy-label/);
  assert.match(source, /white-space:\s*pre-wrap/);
  assert.match(source, /overflow-wrap:\s*anywhere/);
});
