import type { Mailer } from '../../gateway/context.ts';

export interface Sent {
  to: string;
  subject: string;
  text: string;
}

/** A mailer that keeps what it was asked to send, so a test can read the link out of it. */
export function inbox(): { mailer: Mailer; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    mailer: {
      send(message) {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

/** The single-use token in the link of a `#/<fragment>?token=…` email. */
export const tokenOf = (mail: Sent, fragment: 'reset' | 'verify') =>
  new RegExp(`#/${fragment}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text)?.[1] ?? '';
