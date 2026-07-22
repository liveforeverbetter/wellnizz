import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOAuthRedirectUri } from '../src/auth.js';

test('keeps an explicit redirect URI whose origin matches PUBLIC_BASE_URL', () => {
  assert.equal(
    resolveOAuthRedirectUri('https://app.wellnizz.com/dashboard', 'https://app.wellnizz.com', 'WHOOP_REDIRECT_URI'),
    'https://app.wellnizz.com/dashboard',
  );
  // A trailing slash on the base URL still matches by origin.
  assert.equal(
    resolveOAuthRedirectUri('https://app.wellnizz.com/dashboard', 'https://app.wellnizz.com/', 'WHOOP_REDIRECT_URI'),
    'https://app.wellnizz.com/dashboard',
  );
});

test('drops a stale redirect URI from a previous domain so it derives from PUBLIC_BASE_URL', () => {
  // The exact bug: app moved to app.wellnizz.com but the secret still points at
  // the old foreverbetter.xyz origin, which WHOOP rejects.
  assert.equal(
    resolveOAuthRedirectUri('https://api.foreverbetter.xyz/dashboard', 'https://app.wellnizz.com', 'WHOOP_REDIRECT_URI'),
    undefined,
  );
});

test('returns undefined when no explicit redirect URI is configured', () => {
  assert.equal(resolveOAuthRedirectUri(undefined, 'https://app.wellnizz.com', 'WHOOP_REDIRECT_URI'), undefined);
  assert.equal(resolveOAuthRedirectUri('   ', 'https://app.wellnizz.com', 'WHOOP_REDIRECT_URI'), undefined);
});

test('honors the explicit redirect URI when PUBLIC_BASE_URL is not set (self-hosted, no canonical origin)', () => {
  assert.equal(
    resolveOAuthRedirectUri('https://my-host.example/dashboard', undefined, 'WHOOP_REDIRECT_URI'),
    'https://my-host.example/dashboard',
  );
});

test('leaves an unparseable redirect URI untouched for the provider to reject', () => {
  assert.equal(
    resolveOAuthRedirectUri('not a url', 'https://app.wellnizz.com', 'WHOOP_REDIRECT_URI'),
    'not a url',
  );
});
