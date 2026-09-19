import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { session } from '../session.js';
import { button, card, errorBox, field, input, kv, notice, pageHeader, toast } from '../ui.js';

export default async function account() {
  const me = session.me;
  const current = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const again = input({ type: 'password', autocomplete: 'new-password' });
  const slot = h('div');
  const change = async (ev) => {
    ev?.preventDefault();
    clear(slot);
    if (next.value !== again.value) return clear(slot).append(notice('bad', 'The new passwords do not match.'));
    try {
      await api.post('/v1/auth/password', { current: current.value, next: next.value });
      toast('Password changed. Please sign in again.', 'good');
      location.reload();
    } catch (e) {
      clear(slot).append(errorBox(e));
    }
  };
  return h(
    'div',
    {},
    pageHeader('Account'),
    h(
      'div',
      { class: 'grid grid-2' },
      card(
        'You',
        kv([
          ['Name', me.user?.name ?? me.principal.name],
          ['Email', me.user?.email],
          ['Workspace', h('code', {}, me.principal.tenant)],
          ['Roles', me.principal.roles.join(', ')],
          ['Environment', me.environment],
        ]),
      ),
      card(
        'Change password',
        h(
          'form',
          { class: 'form', onSubmit: change },
          field('Current password', current),
          field('New password', next, 'At least 12 characters, not containing your email.'),
          field('Repeat new password', again),
          slot,
          button('Change password', { kind: 'primary', type: 'submit' }),
          h('p', { class: 'muted' }, 'You will be signed out everywhere and asked to sign in again.'),
        ),
      ),
    ),
  );
}
