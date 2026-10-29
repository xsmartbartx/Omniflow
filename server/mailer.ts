import { smtpTransport } from '../capabilities/adapters/notify/index.ts';
import type { Config, Mailer } from '../gateway/context.ts';

/** The platform's own outgoing mail (password resets), over the same SMTP relay the `email-send` capability uses. */
export function createMailer(config: Pick<Config, 'adapters'>): Mailer | undefined {
  const smtp = config.adapters.email.smtpUrl;
  if (!smtp) return undefined;
  const transport = smtpTransport(smtp);
  const from = config.adapters.email.from ?? 'omniflow@localhost';
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
