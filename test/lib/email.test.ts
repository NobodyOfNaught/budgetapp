import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareEmailSender, ConsoleEmailSender } from '../../src/lib/email';
import type { AppEnv } from '../../src/types/hono';

const MAGIC_LINK = { to: 'user@example.com', confirmUrl: 'https://budget-uat.naught.ca/auth/confirm?token=abc' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CloudflareEmailSender', () => {
  it('sends for real through the EMAIL binding when EMAIL/EMAIL_FROM are both present', async () => {
    // The real Miniflare-simulated binding wrangler.jsonc's env.uat block
    // provides — vitest.config.ts points the whole suite at that
    // environment. Proves the binding is wired and callable end to end;
    // see the next test for asserting exactly what gets sent.
    await expect(new CloudflareEmailSender().sendMagicLink(MAGIC_LINK, env as AppEnv['Bindings'])).resolves.toBeUndefined();
  });

  it('sends the expected from/to/subject/link', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'test-message-id' });
    const fakeEnv = { ...env, EMAIL: { send }, EMAIL_FROM: 'noreply@budget-uat.naught.ca' } as unknown as AppEnv['Bindings'];

    await new CloudflareEmailSender().sendMagicLink(MAGIC_LINK, fakeEnv);

    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0]!;
    expect(message.from).toBe('noreply@budget-uat.naught.ca');
    expect(message.to).toBe(MAGIC_LINK.to);
    expect(message.subject).toBe('Sign in to budgetapp');
    expect(message.text).toContain(MAGIC_LINK.confirmUrl);
    expect(message.html).toContain(MAGIC_LINK.confirmUrl);
  });

  it('falls back to console logging when EMAIL is not bound', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeEnv = { ...env, EMAIL: undefined, EMAIL_FROM: 'noreply@budget-uat.naught.ca' } as unknown as AppEnv['Bindings'];

    await new CloudflareEmailSender().sendMagicLink(MAGIC_LINK, fakeEnv);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(MAGIC_LINK.confirmUrl));
  });

  it('falls back to console logging when EMAIL_FROM is not set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeEnv = { ...env, EMAIL: { send: vi.fn() }, EMAIL_FROM: undefined } as unknown as AppEnv['Bindings'];

    await new CloudflareEmailSender().sendMagicLink(MAGIC_LINK, fakeEnv);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(MAGIC_LINK.confirmUrl));
  });

  it('swallows a send failure rather than throwing — the magic-link route must always return 200', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeEnv = {
      ...env,
      EMAIL: { send: vi.fn().mockRejectedValue(new Error('Email Service is down')) },
      EMAIL_FROM: 'noreply@budget-uat.naught.ca',
    } as unknown as AppEnv['Bindings'];

    await expect(new CloudflareEmailSender().sendMagicLink(MAGIC_LINK, fakeEnv)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('ConsoleEmailSender', () => {
  it('logs the confirm URL', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new ConsoleEmailSender().sendMagicLink(MAGIC_LINK);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(MAGIC_LINK.confirmUrl));
  });
});
