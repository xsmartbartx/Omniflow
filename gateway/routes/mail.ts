import type { MailedToken } from '../auth.ts';
import type { RouteDef } from '../http.ts';

type App = Parameters<RouteDef['handler']>[0]['app'];

/** The wording of one kind of emailed link. */
export interface LinkMail {
  fragment: 'reset' | 'verify';
  subject: string;
  action: string;
  ignore: string;
}

export const RESET_MAIL: LinkMail = {
  fragment: 'reset',
  subject: 'Reset your OmniFlow password',
  action: 'choose a new password',
  ignore: 'your password has not changed',
};
export const VERIFY_MAIL: LinkMail = {
  fragment: 'verify',
  subject: 'Confirm your email address for OmniFlow',
  action: 'confirm your email address and finish creating your account',
  ignore: 'no account will be usable without it',
};
export const INVITE_MAIL: LinkMail = {
  fragment: 'reset',
  subject: 'You have been invited to OmniFlow',
  action: 'choose a password and join the workspace',
  ignore: 'nothing happens until you follow the link',
};

const lifetime = (minutes: number) =>
  minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : `${minutes} minutes`;

/** Email a single-use link. Not awaited: the answer must not reveal, by how long it takes, whether an address has an account. */
export function mailLink(app: App, ip: string, mailed: MailedToken, mail: LinkMail): void {
  if (!app.mailer) return;
  const base = app.config.publicUrl.endsWith('/') ? app.config.publicUrl.slice(0, -1) : app.config.publicUrl;
  const link = `${base}/#/${mail.fragment}?token=${mailed.token}`;
  void app.mailer
    .send({
      to: mailed.to,
      subject: mail.subject,
      text: `Hello ${mailed.name},\n\nUse this link to ${mail.action}. It works once and expires in ${lifetime(mailed.expiresInMinutes)}:\n\n${link}\n\nIf you did not ask for this, ignore this email: ${mail.ignore}.\n`,
    })
    .catch((error: unknown) => app.log.warn('could not send an email', { error, ip, subject: mail.subject }));
}
