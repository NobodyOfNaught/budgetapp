import type { AppEnv } from '../types/hono';

export interface MagicLinkEmail {
  to: string;
  confirmUrl: string;
}

/**
 * Vendor-agnostic seam for sending mail — src/index.ts wires the real
 * implementation, tests wire a capturing one (test/helpers.ts). `env` is
 * threaded through explicitly (rather than captured at construction time)
 * because it's only known per-request, not when the app is built at module
 * scope — see CloudflareEmailSender below.
 */
export interface EmailSender {
  sendMagicLink(email: MagicLinkEmail, env: AppEnv['Bindings']): Promise<void>;
}

/**
 * Logs the sign-in link instead of sending real mail. Still the only thing
 * that runs anywhere `EMAIL`/`EMAIL_FROM` aren't bound — local `wrangler
 * dev` (unscoped, top-level config) and every deployed environment except
 * `uat` today. Sign in during review/testing by reading the link out of
 * `wrangler tail` / the Workers Builds log rather than an inbox.
 */
export class ConsoleEmailSender implements EmailSender {
  async sendMagicLink({ to, confirmUrl }: MagicLinkEmail): Promise<void> {
    console.log(`[auth] magic link for ${to}: ${confirmUrl}`);
  }
}

/**
 * Real delivery via Cloudflare Email Service (the transactional sender,
 * not the older Email Routing send_email binding — that one only reaches
 * addresses pre-verified as a destination in the dashboard, which can't
 * work for arbitrary sign-up emails; Email Service can, once its sending
 * domain is onboarded — see docs/plan.md's PR 11 notes).
 *
 * Falls back to ConsoleEmailSender whenever the binding or the from
 * address isn't present on `env`, so this can be the one universal default
 * in src/index.ts with no per-environment branching there: it behaves
 * exactly like today everywhere except wrangler.jsonc's env.uat block,
 * which is the only one carrying both right now.
 *
 * Errors from the send call are logged and swallowed, never thrown — the
 * magic-link route has a hard invariant (always 200, identical response
 * whether or not the address has an account, to avoid enumeration) that a
 * provider hiccup must not break.
 */
export class CloudflareEmailSender implements EmailSender {
  async sendMagicLink(email: MagicLinkEmail, env: AppEnv['Bindings']): Promise<void> {
    if (!env.EMAIL || !env.EMAIL_FROM) {
      await new ConsoleEmailSender().sendMagicLink(email);
      return;
    }
    const { to, confirmUrl } = email;
    try {
      await env.EMAIL.send({
        from: env.EMAIL_FROM,
        to,
        subject: 'Sign in to budgetapp',
        text: `Click this link to sign in to budgetapp:\n\n${confirmUrl}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Click the link below to sign in to budgetapp:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
      });
    } catch (err) {
      console.error(`[auth] failed to send magic-link email to ${to}:`, err);
    }
  }
}
