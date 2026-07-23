import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createId, type HealthStore } from '../store.js';
import { issueUserSession } from '../pricing.js';
import { emailEnabled, sendOtpEmail } from './email.js';
import type { AuthConfig } from '../auth.js';

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS ?? 10 * 60 * 1000);

// Carries a status/code so the HTTP layer can surface an actionable client error
// (rate limit, invalid code) rather than a generic 400.
export class OtpAuthError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'OtpAuthError';
  }
}

export interface AgentOtpStartRequest {
  email: string;
}

export interface AgentOtpVerifyRequest {
  email: string;
  token: string;
}

export interface OtpSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type: string;
  user: { id: string; email?: string };
}

interface ReviewLoginConfig {
  emails: string[];
  code?: string;
}

// REVIEW_LOGIN_EMAIL accepts one address or a comma-separated list, so multiple
// reviewer accounts (e.g. the Play and App Store review inboxes) can share the
// single fixed code.
function reviewLoginConfig(env: NodeJS.ProcessEnv = process.env): ReviewLoginConfig {
  return {
    emails: (env.REVIEW_LOGIN_EMAIL ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
    code: env.REVIEW_LOGIN_CODE?.trim() || undefined,
  };
}

// App-store review bypass: a fixed, documented code for a reviewer who cannot
// read an inbox. Disabled unless both env vars are set.
function isReviewLogin(email: string, token?: string): boolean {
  const review = reviewLoginConfig();
  if (review.emails.length === 0 || !review.code) return false;
  if (!review.emails.includes(email)) return false;
  if (token !== undefined && token.trim() !== review.code) return false;
  return true;
}

export async function startAgentOtp(input: AgentOtpStartRequest, store: HealthStore, config: AuthConfig): Promise<{ ok: true; delivery: 'email'; message: string }> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new OtpAuthError('A valid email address is required.', 400, 'invalid_email');
  if (!emailEnabled()) throw new OtpAuthError('Email sign-in is not enabled on this deployment.', 501, 'email_disabled');

  if (isReviewLogin(email)) {
    return { ok: true, delivery: 'email', message: 'Enter the review sign-in code to continue.' };
  }

  const code = generateCode();
  await store.createOtpChallenge({
    id: createId('otp'),
    email,
    code_hash: hashCode(email, code, config),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    created_at: new Date().toISOString(),
  });
  try {
    await sendOtpEmail(email, code);
  } catch (error) {
    throw new OtpAuthError(error instanceof Error ? error.message : 'Could not send the sign-in email.', 502, 'email_send_failed');
  }
  return {
    ok: true,
    delivery: 'email',
    message: 'If the address can receive mail, an 8-digit sign-in code has been emailed. Enter it to continue.',
  };
}

export async function verifyAgentOtp(input: AgentOtpVerifyRequest, store: HealthStore, config: AuthConfig): Promise<OtpSession> {
  const email = normalizeEmail(input.email);
  const token = (input.token ?? '').trim();
  if (!isEmail(email)) throw new OtpAuthError('A valid email address is required.', 400, 'invalid_email');
  if (!token) throw new OtpAuthError('A verification code is required.', 400, 'missing_code');

  if (isReviewLogin(email, token)) {
    return sessionFor(email, config);
  }

  const ok = await store.consumeOtpChallenge(email, hashCode(email, token, config));
  if (!ok) throw new OtpAuthError('That code is invalid or has expired. Request a new one.', 400, 'invalid_code');
  return sessionFor(email, config);
}

async function sessionFor(email: string, config: AuthConfig): Promise<OtpSession> {
  const session = await issueUserSession(email, config);
  return {
    access_token: session.access_token,
    expires_at: session.expires_at,
    token_type: session.token_type,
    user: session.user,
  };
}

function normalizeEmail(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function generateCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

// Hash the code with the deployment signing secret as a pepper and the email as
// a salt, so stored hashes are useless without the server secret and never
// collide across accounts. Compared with a timing-safe equal at verify time via
// the store's exact-match delete.
function hashCode(email: string, code: string, config: AuthConfig): string {
  const pepper = config.apiKeySecret ?? config.serviceAccountSecret ?? 'health-api-otp';
  return createHash('sha256').update(`${pepper}:${email}:${code}`).digest('hex');
}

// Exposed for tests that want to assert constant-time comparison semantics.
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
