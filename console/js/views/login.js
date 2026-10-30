import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { button, card, errorBox, field, input, notice, toast } from '../ui.js';

const loginShell = (...children) =>
  h('div', { class: 'login' }, h('div', { class: 'login-card' }, card(null, ...children)));

/** Sign-in screen. Returns a node; calls onSignedIn() after the session cookie is set. */
export default function login({ onSignedIn, signup = false, passwordReset = false, confirmLink = false }) {
  const email = input({
    type: 'email',
    name: 'email',
    autocomplete: 'username',
    required: true,
    autofocus: true,
    placeholder: 'you@company.com',
  });
  const password = input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    try {
      await api.post('/v1/auth/login', { email: email.value.trim(), password: password.value });
      password.value = '';
      await onSignedIn();
    } catch (e) {
      clear(slot).append(errorBox(e, { title: e.status === 401 ? 'Could not sign in' : undefined }));
    }
  };
  const form = h(
    'form',
    { class: 'form', onSubmit: submit },
    field('Email', email),
    field('Password', password),
    slot,
    button('Sign in', { kind: 'primary', type: 'submit' }),
    passwordReset ? h('p', { class: 'muted' }, h('a', { href: '#/forgot' }, 'Forgot your password?')) : null,
    confirmLink
      ? h('p', { class: 'muted' }, h('a', { href: '#/confirm' }, 'Did not get the confirmation email?'))
      : null,
    signup ? h('p', { class: 'muted' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account')) : null,
  );
  return loginShell(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'OmniFlow'),
      h('p', { class: 'muted' }, 'Sign in to run workflows you can explain.'),
      form,
    ),
  );
}

/** Sign-in screen for NEXORA mode: identity comes from NEXORA, so there is no password form. */
export function nexoraSignIn() {
  return loginShell(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'OmniFlow'),
      h(
        'p',
        { class: 'muted' },
        'OmniFlow uses your NEXORA account. Your session lasts a few minutes and renews when you continue.',
      ),
      h('a', { class: 'btn btn-primary', href: '/app' }, 'Continue with NEXORA'),
    ),
  );
}

/** Forced password change (first sign-in with a temporary password). */
export function changePassword({ onDone }) {
  const current = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const again = input({ type: 'password', autocomplete: 'new-password' });
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    if (next.value !== again.value) return clear(slot).append(notice('bad', 'The new passwords do not match.'));
    try {
      await api.post('/v1/auth/password', { current: current.value, next: next.value });
      // changing the password signs the user out everywhere: sign in again with the new one
      toast('Password changed. Sign in with your new password.', 'good');
      await onDone();
    } catch (e) {
      clear(slot).append(errorBox(e));
    }
  };
  return loginShell(
    h(
      'form',
      { class: 'form', onSubmit: submit },
      h('h2', {}, 'Choose a new password'),
      h(
        'p',
        { class: 'muted' },
        'You signed in with a temporary password. Pick a new one (at least 12 characters) to continue.',
      ),
      field('Temporary password', current),
      field('New password', next),
      field('Repeat new password', again),
      slot,
      button('Change password', { kind: 'primary', type: 'submit' }),
    ),
  );
}

/** The "I agree" line: a real checkbox whose label links to the pages the operator configured. */
function consent(checkbox, { termsUrl, privacyUrl }) {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const pages = [
    termsUrl ? link(termsUrl, 'terms') : null,
    privacyUrl ? link(privacyUrl, 'privacy policy') : null,
  ].filter(Boolean);
  return h(
    'label',
    { class: 'consent' },
    checkbox,
    h('span', {}, 'I accept the ', pages[0], pages[1] ? [' and the ', pages[1]] : null, '.'),
  );
}

/** Self-serve account creation (only offered when the operator turned it on). */
export function signUp({ onSignedIn, terms }) {
  const name = input({ type: 'text', name: 'name', autocomplete: 'name', placeholder: 'Your name' });
  const organization = input({
    type: 'text',
    name: 'organization',
    autocomplete: 'organization',
    placeholder: 'Company',
  });
  const email = input({
    type: 'email',
    name: 'email',
    autocomplete: 'username',
    required: true,
    placeholder: 'you@company.com',
  });
  const password = input({
    type: 'password',
    name: 'password',
    autocomplete: 'new-password',
    required: true,
    minlength: 12,
  });
  const accept = terms ? h('input', { type: 'checkbox', name: 'acceptTerms', required: true }) : null;
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    try {
      const res = await api.post('/v1/auth/signup', {
        ...(terms ? { acceptTerms: accept.checked } : {}),
        email: email.value.trim(),
        password: password.value,
        ...(name.value.trim() ? { name: name.value.trim() } : {}),
        ...(organization.value.trim() ? { organization: organization.value.trim() } : {}),
      });
      password.value = '';
      if (res?.verify) return clear(page).append(checkYourEmail(email.value.trim()));
      await onSignedIn();
    } catch (e) {
      clear(slot).append(errorBox(e, { title: 'Could not create the account' }));
    }
  };
  const page = h('div', { class: 'stack' });
  const form = h(
    'form',
    { class: 'form', onSubmit: submit },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'OmniFlow'),
    h('p', { class: 'muted' }, 'Create an account. You get a workspace of your own, and you are its administrator.'),
    field('Name', name),
    field('Company', organization),
    field('Email', email),
    field('Password (at least 12 characters)', password),
    terms ? consent(accept, terms) : null,
    slot,
    button('Create account', { kind: 'primary', type: 'submit' }),
    h('p', { class: 'muted' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')),
  );
  page.append(form);
  return loginShell(page);
}

/** After sign-up with email confirmation on: tell the person to look in their inbox. */
function checkYourEmail(address) {
  return h(
    'div',
    { class: 'stack' },
    h('h2', {}, 'Check your email'),
    notice(
      'info',
      `We sent a confirmation link to ${address}. Follow it to finish creating your account; it works once and expires in 30 minutes.`,
    ),
    h(
      'p',
      { class: 'muted' },
      h('a', { href: '#/confirm' }, 'Send the link again'),
      ' · ',
      h('a', { href: '#/login' }, 'Sign in'),
    ),
  );
}

/** A small card with one form, for the password-reset screens. */
function resetCard(title, intro, fields, slot, submitLabel, onSubmit) {
  return loginShell(
    h(
      'form',
      { class: 'form', onSubmit },
      h('h2', {}, title),
      h('p', { class: 'muted' }, intro),
      ...fields,
      slot,
      button(submitLabel, { kind: 'primary', type: 'submit' }),
      h('p', { class: 'muted' }, h('a', { href: '#/login' }, 'Back to sign in')),
    ),
  );
}

/** A screen that takes an email address and asks the server to mail a link; the answer never says whether the address has an account. */
function emailLinkScreen({ title, intro, endpoint, submitLabel, done }) {
  const email = input({
    type: 'email',
    name: 'email',
    autocomplete: 'username',
    required: true,
    autofocus: true,
    placeholder: 'you@company.com',
  });
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    try {
      await api.post(endpoint, { email: email.value.trim() });
      clear(slot).append(notice('info', done));
    } catch (e) {
      clear(slot).append(errorBox(e));
    }
  };
  return resetCard(title, intro, [field('Email', email)], slot, submitLabel, submit);
}

/** Ask for a password reset link. */
export const forgotPassword = () =>
  emailLinkScreen({
    title: 'Reset your password',
    intro: 'Enter your email and we will send you a link.',
    endpoint: '/v1/auth/forgot',
    submitLabel: 'Send reset link',
    done: 'If an account exists for that address, a reset link is on its way. It works once and expires in 30 minutes.',
  });

/** Ask for the sign-up confirmation link again. */
export const resendConfirmation = () =>
  emailLinkScreen({
    title: 'Confirm your email address',
    intro: 'Enter the address you signed up with and we will send the confirmation link again.',
    endpoint: '/v1/auth/resend-verification',
    submitLabel: 'Send confirmation link',
    done: 'If that address is waiting for confirmation, a new link is on its way. It works once and expires in 30 minutes.',
  });

/** Follow the confirmation link from the sign-up email: confirm straight away and say how it went. */
export function confirmEmail({ token }) {
  const result = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Confirming your email address…'));
  api
    .post('/v1/auth/verify', { token })
    .then(() => {
      clear(result).append(
        h('h2', {}, 'Email confirmed'),
        notice('good', 'Your account is ready.'),
        h('a', { class: 'btn btn-primary', href: '#/login' }, 'Sign in'),
      );
    })
    .catch((e) => {
      clear(result).append(
        h('h2', {}, 'Could not confirm'),
        errorBox(e),
        h('p', { class: 'muted' }, h('a', { href: '#/confirm' }, 'Send a new link')),
      );
    });
  return loginShell(result);
}

/** Choose a new password with the token from the emailed link. */
export function resetPassword({ token, onDone }) {
  const next = input({
    type: 'password',
    name: 'password',
    autocomplete: 'new-password',
    required: true,
    minlength: 12,
  });
  const again = input({ type: 'password', name: 'again', autocomplete: 'new-password', required: true, minlength: 12 });
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    if (next.value !== again.value) return clear(slot).append(notice('bad', 'The two passwords do not match.'));
    try {
      await api.post('/v1/auth/reset', { token, password: next.value });
      toast('Password changed. Sign in with your new password.', 'good');
      await onDone();
    } catch (e) {
      clear(slot).append(errorBox(e, { title: 'Could not reset the password' }));
    }
  };
  const fields = [field('New password (at least 12 characters)', next), field('Repeat the new password', again)];
  return resetCard(
    'Choose a new password',
    'The link you followed is valid once.',
    fields,
    slot,
    'Change password',
    submit,
  );
}
