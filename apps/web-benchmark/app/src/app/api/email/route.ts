import { randomBytes, randomInt } from "node:crypto";
import nodemailer from "nodemailer";

/**
 * The Email Verification scenario's mail: every message goes out over SMTP to
 * whatever server `MAIL_SMTP_PORT` names, which the benchmark's config starts
 * as MailDev, so tests read it back through `email.inbox()`. Codes and sign-in
 * tokens live in this process only; a restart forgets them, as a real app's
 * expiry would.
 */
export const dynamic = "force-dynamic";

const SENDER = "Benchmark <noreply@benchmark.test>";
const codes = new Map<string, string>();
const tokens = new Map<string, string>();

const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT ?? 4281);
const transport = nodemailer.createTransport({
  host: process.env.MAIL_SMTP_HOST ?? "127.0.0.1",
  port: SMTP_PORT,
  secure: false,
  ignoreTLS: true,
});

type EmailAction =
  | { action: "signup" | "resend"; email: string }
  | { action: "verify"; email: string; code: string }
  | { action: "magic-link"; email: string }
  | { action: "redeem"; token: string }
  | { action: "invite"; from: string; to: string };

/** Mails a fresh verification code, replacing the one sent before it. */
async function sendCode(email: string): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  codes.set(email.toLowerCase(), code);
  await transport.sendMail({
    from: SENDER,
    to: email,
    subject: "Verify your email",
    text: `Your verification code is ${code}.\n\nBenchmark Inc, 2026`,
    html: `<div style="display:none">Preheader ${randomInt(100_000, 1_000_000)}</div><p>Your verification code is <b>${code}</b>.</p><p style="color:#999">Benchmark Inc, 2026</p>`,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch (cause) {
    // Without MailDev on the SMTP port (a plain `pnpm dev`), say so rather than failing silently.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return Response.json({ error: `Could not send mail: ${reason}. Start MailDev (the suite does) on SMTP port ${SMTP_PORT}.` }, { status: 503 });
  }
}

/** Runs one action against the mail endpoint. */
async function handle(request: Request): Promise<Response> {
  const body = (await request.json()) as EmailAction;
  switch (body.action) {
    case "signup":
    case "resend":
      await sendCode(body.email);
      return Response.json({ sent: true });
    case "verify":
      return Response.json({ verified: codes.get(body.email.toLowerCase()) === body.code.trim() });
    case "magic-link": {
      const token = randomBytes(12).toString("hex");
      tokens.set(token, body.email);
      const link = `${new URL(request.url).origin}/e/email-verification?token=${token}`;
      // An HTML-only message, as many transactional templates are: no plain-text part.
      await transport.sendMail({
        from: SENDER,
        to: body.email,
        subject: "Your sign-in link",
        html: `<!--[if mso]><p>Outlook preview</p><![endif]--><p>Hi,</p><p><a href="${link}">Sign in to Benchmark</a></p><p style="color:#999">Didn't ask for this? Ignore it. <a href="${new URL(request.url).origin}/">Unsubscribe</a></p>`,
      });
      return Response.json({ sent: true });
    }
    case "redeem":
      return Response.json({ email: tokens.get(body.token) ?? null });
    case "invite":
      // The inviter's copy goes by Bcc, so nothing in its headers names them.
      await transport.sendMail({
        from: SENDER,
        to: body.to,
        bcc: body.from,
        subject: `${body.from} invited you to Benchmark`,
        text: `${body.from} invited you to join their Benchmark workspace.`,
      });
      return Response.json({ sent: true });
    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
