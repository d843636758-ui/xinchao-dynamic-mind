import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PLACEHOLDER = /^replace-with/i;

function validateToken(value, source) {
  const token = String(value ?? '').trim();
  if (PLACEHOLDER.test(token)) {
    throw new Error(`${source} is still a placeholder — generate a real one: openssl rand -hex 32`);
  }
  if (token.length < 32) {
    throw new Error(`${source} must be at least 32 characters — generate one: openssl rand -hex 32`);
  }
  return token;
}

async function readToken(path) {
  try {
    return validateToken(await readFile(path, 'utf8'), 'generated SERVICE_TOKEN file');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Resolve the API bearer token without ever starting the service unprotected.
 *
 * An explicit SERVICE_TOKEN always wins.  Managed platforms may omit it for a
 * first boot; in that case a strong random token is created beside the state
 * file and reused on later boots when /app/state is a persistent volume.
 */
export async function resolveServiceToken(configuredToken, tokenFile) {
  if (String(configuredToken ?? '').trim()) {
    return {
      token: validateToken(configuredToken, 'SERVICE_TOKEN'),
      source: 'environment',
    };
  }

  const existing = await readToken(tokenFile);
  if (existing) return { token: existing, source: 'file' };

  await mkdir(dirname(tokenFile), { recursive: true });
  const generated = randomBytes(32).toString('hex');
  try {
    await writeFile(tokenFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(tokenFile, 0o600);
    return { token: generated, source: 'generated' };
  } catch (error) {
    // Two replicas may race during a rollout.  The winner's file is the source
    // of truth; never overwrite it with a second secret.
    if (error.code !== 'EEXIST') throw error;
    return { token: await readToken(tokenFile), source: 'file' };
  }
}

