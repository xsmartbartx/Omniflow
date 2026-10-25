import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { button, card, errorBox, field, input, notice, toast } from '../ui.js';

/** Sign-in screen. Returns a node; calls onSignedIn() after the session cookie is set. */
export default function login({ onSignedIn, signup = false }) {
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
    signup ? h('p', { class: 'muted' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account')) : null,
  );
  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      card(
        null,
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'OmniFlow'),
          h('p', { class: 'muted' }, 'Sign in to run workflows you can explain.'),
          form,
        ),
      ),
    ),
  );
}

/** Sign-in screen for NEXORA mode: identity comes from NEXORA, so there is no password form. */
export function nexoraSignIn() {
  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      card(
        null,
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
      ),
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
  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      card(
        null,
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
      ),
    ),
  );
}

/** Self-serve account creation (only offered when the operator turned it on). */
export function signUp({ onSignedIn }) {
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
  const slot = h('div');
  const submit = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    try {
      await api.post('/v1/auth/signup', {
        email: email.value.trim(),
        password: password.value,
        ...(name.value.trim() ? { name: name.value.trim() } : {}),
        ...(organization.value.trim() ? { organization: organization.value.trim() } : {}),
      });
      password.value = '';
      await onSignedIn();
    } catch (e) {
      clear(slot).append(errorBox(e, { title: 'Could not create the account' }));
    }
  };
  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      card(
        null,
        h(
          'form',
          { class: 'form', onSubmit: submit },
          h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'OmniFlow'),
          h(
            'p',
            { class: 'muted' },
            'Create an account. You get a workspace of your own, and you are its administrator.',
          ),
          field('Name', name),
          field('Company', organization),
          field('Email', email),
          field('Password (at least 12 characters)', password),
          slot,
          button('Create account', { kind: 'primary', type: 'submit' }),
          h('p', { class: 'muted' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')),
        ),
      ),
    ),
  );
}
