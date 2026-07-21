// Email delivery for sign-in codes, chosen by EMAIL_DRIVER:
//   console           - log the code to stdout for local development only.
//   resend            - send via the Resend HTTP API (set RESEND_API_KEY).
//   smtp              - send via any SMTP server (nodemailer). Point it at your
//                       provider or a local Mailpit for testing.
//   none              - disable email delivery entirely (OTP login turns off).

export type EmailDriver = 'console' | 'resend' | 'smtp' | 'none';

const OTP_TTL_MINUTES = 10;

export function emailDriver(env: NodeJS.ProcessEnv = process.env): EmailDriver {
  const driver = (env.EMAIL_DRIVER ?? (env.NODE_ENV === 'production' ? 'none' : 'console')).toLowerCase();
  if (driver === 'smtp' || driver === 'none' || driver === 'console' || driver === 'resend') return driver;
  throw new Error(`Unsupported EMAIL_DRIVER "${driver}". Use "console", "resend", "smtp", or "none".`);
}

export function validateEmailConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && emailDriver(env) === 'console') {
    throw new Error('EMAIL_DRIVER=console is not allowed in production because it exposes live sign-in codes in logs. Use resend, smtp, or none.');
  }
}

export function emailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailDriver(env) !== 'none';
}

export async function sendOtpEmail(to: string, code: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const driver = emailDriver(env);
  const from = env.EMAIL_FROM ?? 'Wellnizz <login@localhost>';
  const brand = normalizeEmailBrand(env.EMAIL_BRAND);
  const subject = `Your ${brand} sign-in code`;
  // A multipart message (plain text + HTML) renders everywhere and scores better
  // with spam filters than a bare text body.
  const text = `Your ${brand} sign-in code is ${code}\n\nEnter it to finish signing in. It expires in ${OTP_TTL_MINUTES} minutes.\nIf you did not request this, you can ignore this email.`;
  const html = otpEmailHtml(code, brand);

  if (driver === 'none') {
    throw new Error('Email delivery is disabled (EMAIL_DRIVER=none).');
  }
  if (driver === 'console') {
    validateEmailConfig(env);
    // Local development convenience. Production rejects this driver.
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'otp_email', driver: 'console', to, code, subject }));
    return;
  }
  if (driver === 'resend') {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is required when EMAIL_DRIVER=resend.');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!response.ok) {
      throw new Error(`Resend send failed: ${response.status} ${await response.text().catch(() => '')}`);
    }
    return;
  }

  const nodemailer = (await import('nodemailer')).default;
  const transport = env.SMTP_URL
    ? nodemailer.createTransport(env.SMTP_URL)
    : nodemailer.createTransport({
        host: env.SMTP_HOST ?? 'localhost',
        port: Number(env.SMTP_PORT ?? '587'),
        secure: (env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
        auth: env.SMTP_USER && env.SMTP_PASSWORD
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
      });
  await transport.sendMail({ from, to, subject, text, html });
}

// Minimal, email-client-safe HTML: table layout, inline styles, no external
// images, with a hidden preheader for the inbox preview.
export function otpEmailHtml(code: string, brand = 'Wellnizz'): string {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace";
  const safeBrand = escapeHtml(normalizeEmailBrand(brand));
  const safeCode = escapeHtml(code);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background-color:#f6f3ee;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your ${safeBrand} sign-in code is ${safeCode}. It expires in ${OTP_TTL_MINUTES} minutes.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f3ee;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="440" cellpadding="0" cellspacing="0" border="0" style="width:440px;max-width:100%;background-color:#ffffff;border:1px solid #e7e2d8;border-radius:14px;">
            <tr><td style="padding:28px 32px 0;font-family:${font};">
              <p style="margin:0;font-size:15px;font-weight:700;color:#173b34;letter-spacing:-0.01em;">${safeBrand}</p>
            </td></tr>
            <tr><td style="padding:18px 32px 0;font-family:${font};">
              <h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#1a1a1a;font-weight:600;">Sign in to ${safeBrand}</h1>
              <p style="margin:0;font-size:14px;line-height:1.55;color:#5c5c5c;">Enter this code to finish signing in. It expires in ${OTP_TTL_MINUTES} minutes.</p>
            </td></tr>
            <tr><td style="padding:20px 32px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td align="center" style="background-color:#f1ece3;border:1px solid #e7e2d8;border-radius:10px;padding:18px 12px;">
                  <span style="font-family:${mono};font-size:30px;font-weight:700;letter-spacing:10px;color:#173b34;padding-left:10px;">${safeCode}</span>
                </td></tr>
              </table>
            </td></tr>
            <tr><td style="padding:20px 32px 28px;font-family:${font};">
              <p style="margin:0;font-size:13px;line-height:1.55;color:#8f8a80;">If you did not request this, you can safely ignore this email. No changes will be made to your account.</p>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#a5a099;font-family:${font};">${safeBrand}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function normalizeEmailBrand(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'Wellnizz';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}
