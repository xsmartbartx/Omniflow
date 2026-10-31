import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { session } from '../session.js';
import { button, card, confirmDialog, errorBox, field, input, kv, notice, pageHeader, toast } from '../ui.js';

export default async function account() {
  const me = session.me;
  if (!me) throw new Error('Sign in first');
  const current = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const again = input({ type: 'password', autocomplete: 'new-password' });
  const slot = h('div');
  const confirm = input({ type: 'password', autocomplete: 'current-password' });
  const erased = h('div');
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
  const remove = async (ev) => {
    ev?.preventDefault();
    clear(erased);
    const ok = await confirmDialog({
      title: 'Delete this account?',
      message: 'Every workflow, run, secret and person in this workspace is erased for good. This cannot be undone.',
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post('/v1/auth/delete-account', { password: confirm.value });
      toast('Your account was deleted.', 'good');
      location.reload();
    } catch (e) {
      clear(erased).append(errorBox(e));
    }
  };
  // only the administrator of a workspace made by sign-up can delete it
  const deletable = me.principal.tenant.startsWith('acct-') && me.principal.roles.includes('admin');
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
      deletable &&
        card(
          'Delete account',
          h(
            'form',
            { class: 'form', onSubmit: remove },
            h(
              'p',
              { class: 'muted' },
              'Erases this workspace and everything in it. The audit log is append-only, so it keeps its record of events, including your email address.',
            ),
            field('Password', confirm),
            erased,
            button('Delete account', { kind: 'danger', type: 'submit' }),
          ),
        ),
    ),
  );
}
