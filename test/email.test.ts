import assert from 'node:assert/strict';
import test from 'node:test';
import { otpEmailHtml, sendOtpEmail } from '../src/connectors/email.js';

test('otpEmailHtml renders a branded, escaped sign-in code', () => {
  const html = otpEmailHtml('12<34&56', 'Forever & Better <Health>');

  assert.match(html, /Sign in to Forever &amp; Better &lt;Health&gt;/);
  assert.match(html, />12&lt;34&amp;56<\/span>/);
  assert.doesNotMatch(html, /Forever & Better <Health>/);
  assert.doesNotMatch(html, /12<34&56/);
  assert.match(html, /expires in 10 minutes/i);
});

test('otpEmailHtml falls back to Wellnizz for an empty brand', () => {
  const html = otpEmailHtml('12345678', '   ');

  assert.match(html, /Sign in to Wellnizz/);
  assert.match(html, />12345678<\/span>/);
});

test('Resend receives matching text and HTML when EMAIL_BRAND is empty', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (input, init) => {
    assert.equal(input, 'https://api.resend.com/emails');
    assert.equal(init?.method, 'POST');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'email_test' }), { status: 200 });
  }) as typeof fetch;

  try {
    await sendOtpEmail('person@example.com', '12345678', {
      EMAIL_DRIVER: 'resend',
      EMAIL_FROM: 'ForeverBetter <login@foreverbetter.xyz>',
      EMAIL_BRAND: '',
      RESEND_API_KEY: 're_test',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.from, 'ForeverBetter <login@foreverbetter.xyz>');
  assert.equal(requestBody?.to, 'person@example.com');
  assert.equal(requestBody?.subject, 'Your Wellnizz sign-in code');
  assert.match(String(requestBody?.text), /Your Wellnizz sign-in code is 12345678/);
  assert.match(String(requestBody?.html), /Sign in to Wellnizz/);
  assert.match(String(requestBody?.html), />12345678<\/span>/);
});
