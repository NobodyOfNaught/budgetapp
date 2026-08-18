export interface MagicLinkEmail {
  to: string;
  confirmUrl: string;
}

/**
 * Vendor-agnostic seam for sending mail. Swapping in a real provider later
 * (Cloudflare Email Service, once its binding shape is settled and the
 * account's sending domain is verified — see docs/plan.md's auth flow
 * section) is a new implementation of this interface plus one line in
 * wherever it's constructed, not a rewrite of the auth routes that call it.
 */
export interface EmailSender {
  sendMagicLink(email: MagicLinkEmail): Promise<void>;
}

/**
 * The only implementation wired up right now. Logs the sign-in link instead
 * of sending real mail, so local dev and every deployed environment
 * (including production) work end-to-end without any Cloudflare email
 * configuration, domain verification, or dashboard work. Sign in during
 * review/testing by reading the link out of `wrangler tail` / the Workers
 * Builds log rather than an inbox.
 */
export class ConsoleEmailSender implements EmailSender {
  async sendMagicLink({ to, confirmUrl }: MagicLinkEmail): Promise<void> {
    console.log(`[auth] magic link for ${to}: ${confirmUrl}`);
  }
}
