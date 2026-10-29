import { describe, expect, it } from 'vitest';
import { smtpTransport } from '../../capabilities/adapters/notify/index.ts';

/** nodemailer keeps what it was given on `transporter.options`. */
const optionsOf = (smtp: string) =>
  (smtpTransport(smtp) as unknown as { transporter: { options: Record<string, unknown> } }).transporter.options;

describe('smtpTransport', () => {
  it('reads host, TLS port and decoded credentials from an smtps URL', () => {
    expect(optionsOf('smtps://we%40ird:p%3Ass@mail.example.com:2465')).toMatchObject({
      host: 'mail.example.com',
      port: 2465,
      secure: true,
      auth: { user: 'we@ird', pass: 'p:ss' },
    });
  });

  it('defaults to port 465 for smtps and 587 (STARTTLS) for smtp, and allows no credentials', () => {
    expect(optionsOf('smtps://mail.example.com')).toMatchObject({ port: 465, secure: true });
    const plain = optionsOf('smtp://relay.internal');
    expect(plain).toMatchObject({ host: 'relay.internal', port: 587, secure: false });
    expect(plain.auth).toBeUndefined();
  });

  it('keeps the json: development sink (accepts every recipient, sends nothing), and refuses anything else plainly', async () => {
    const info = await smtpTransport('json:').sendMail({ from: 'a@example.com', to: ['b@example.com'], subject: 's' });
    expect(info.accepted).toEqual(['b@example.com']);
    expect(() => smtpTransport('not a url')).toThrow(/OMNIFLOW_SMTP_URL/);
    expect(() => smtpTransport('http://mail.example.com')).toThrow(/smtps:\/\//);
  });
});
