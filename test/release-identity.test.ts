import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SERVICE_VERSION } from '../src/version.js';

test('package, container workflow, and Compose defaults share one release identity', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const publishWorkflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const selfHosting = await readFile(new URL('../SELF_HOSTING.md', import.meta.url), 'utf8');
  const openApi = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.name, '@foreverbetter/api');
  assert.equal(packageJson.version, '0.5.0');
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(SERVICE_VERSION, packageJson.version);
  assert.equal(openApi.info.version, packageJson.version);
  assert.match(publishWorkflow, /IMAGE_NAME: \$\{\{ github\.repository \}\}/);
  assert.match(publishWorkflow, /images: \$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}/);
  assert.doesNotMatch(publishWorkflow, /foreverbetter-api/);
  assert.equal((compose.match(/ghcr\.io\/liveforeverbetter\/foreverbetter/g) ?? []).length, 3);
  assert.match(selfHosting, /IMAGE=ghcr\.io\/liveforeverbetter\/foreverbetter/);
  assert.match(selfHosting, /IMAGE_TAG=1\.2\.3/);
});
