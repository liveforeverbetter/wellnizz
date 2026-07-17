import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { AuthError, authenticate, loadAuthConfig, primaryAuthAudience } from '../src/auth.js';

const secret = 'audience-compatibility-test-secret';
const audiences = ['foreverbetter-api', 'longevity-api', 'health-api'];
const execFileAsync = promisify(execFile);

test('new API keys use the ForeverBetter API audience while legacy audiences remain valid', async () => {
  const config = loadAuthConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'service_account',
    AUTH_AUDIENCE: audiences.join(','),
    SERVICE_ACCOUNT_JWT_SECRET: secret,
    API_KEY_JWT_SECRET: secret,
  });

  assert.deepEqual(config.audience, audiences);
  assert.equal(primaryAuthAudience(config), 'foreverbetter-api');

  for (const audience of audiences) {
    const token = await new SignJWT({
      token_type: 'api_key',
      user_id: `user-${audience}`,
      organization_id: 'org-compatibility',
      scope: 'health:data:read',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience(audience)
      .setSubject(`subject-${audience}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

    const auth = await authenticate(requestWithToken(token), config);
    assert.equal(auth.mode, 'api_key');
    assert.equal(auth.claims.aud, audience);
  }

  const rejected = await new SignJWT({ token_type: 'api_key', scope: 'health:data:read' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience('wellness-api')
    .setSubject('unknown-audience')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

  await assert.rejects(authenticate(requestWithToken(rejected), config), (error: unknown) => (
    error instanceof AuthError && error.status === 401
  ));
});

test('the API-key mint script selects the canonical audience from a compatibility list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foreverbetter-mint-test-'));
  const tokenPath = join(directory, 'token.txt');

  try {
    await execFileAsync(process.execPath, [
      new URL('../scripts/mint-api-key.mjs', import.meta.url).pathname,
      '--out', tokenPath,
      '--days', '1',
    ], {
      env: {
        ...process.env,
        API_KEY_JWT_SECRET: secret,
        AUTH_AUDIENCE: audiences.join(','),
      },
    });

    const token = (await readFile(tokenPath, 'utf8')).trim();
    const config = loadAuthConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'service_account',
      AUTH_AUDIENCE: audiences.join(','),
      SERVICE_ACCOUNT_JWT_SECRET: secret,
      API_KEY_JWT_SECRET: secret,
    });
    const auth = await authenticate(requestWithToken(token), config);

    assert.equal(auth.claims.aud, 'foreverbetter-api');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function requestWithToken(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}
