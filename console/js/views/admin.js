import * as api from '../api.js';
import { h } from '../dom.js';
import { ago, timestamp } from '../format.js';
import { can, session } from '../session.js';
import {
  badge,
  button,
  card,
  confirmDialog,
  dataTable,
  formDialog,
  notice,
  pageHeader,
  showSecretDialog,
  tabs,
  toast,
} from '../ui.js';

const ROLES = ['admin', 'author', 'operator', 'approver', 'viewer'];
const ROLE_HELP =
  'admin: everything · author: write and publish workflows · operator: run and cancel · approver: decide approvals · viewer: read only';
const roleFields = (value = []) =>
  ROLES.map((r) => ({ name: `role_${r}`, type: 'checkbox', label: r, value: value.includes(r) }));
const pickRoles = (v) => ROLES.filter((r) => v[`role_${r}`]);

export default async function admin(ctx) {
  const reload = (tab) => ctx.navigate('/admin', { tab });

  const users = async () => {
    const { items } = await api.get('/v1/users');
    return card(
      null,
      dataTable({
        rows: items,
        columns: [
          {
            label: 'User',
            render: (u) => h('div', {}, h('strong', {}, u.name), h('div', { class: 'muted' }, u.email)),
          },
          { label: 'Roles', render: (u) => u.roles.map((r) => badge(r, r === 'admin' ? 'accent' : 'neutral')) },
          {
            label: 'State',
            render: (u) =>
              u.disabled
                ? badge('disabled', 'bad')
                : u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()
                  ? badge('locked', 'warn')
                  : u.mustChangePassword
                    ? badge('must change password', 'warn')
                    : badge('active', 'good'),
          },
          {
            label: 'Last sign-in',
            render: (u) =>
              u.lastLoginAt ? h('span', { title: timestamp(u.lastLoginAt) }, ago(u.lastLoginAt)) : 'never',
          },
          {
            label: '',
            render: (u) =>
              h(
                'span',
                { class: 'row', style: { gap: '4px' } },
                button('Roles', {
                  small: true,
                  onClick: async () => {
                    const v = await formDialog({
                      title: `Roles for ${u.email}`,
                      intro: ROLE_HELP,
                      fields: roleFields(u.roles),
                      submitLabel: 'Save',
                    });
                    if (!v) return;
                    const roles = pickRoles(v);
                    if (!roles.length) return toast('Pick at least one role', 'bad');
                    await api.patch(`/v1/users/${api.enc(u.id)}`, { roles });
                    toast('Roles updated', 'good');
                    reload('users');
                  },
                }),
                u.id !== session.me.principal.id
                  ? button(u.disabled ? 'Enable' : 'Disable', {
                      small: true,
                      kind: u.disabled ? 'secondary' : 'danger',
                      onClick: async () => {
                        if (
                          !u.disabled &&
                          !(await confirmDialog({
                            title: `Disable ${u.email}?`,
                            message: 'They are signed out immediately and cannot sign in again until re-enabled.',
                            confirmLabel: 'Disable',
                            danger: true,
                          }))
                        )
                          return;
                        await api.patch(`/v1/users/${api.enc(u.id)}`, { disabled: !u.disabled });
                        toast(u.disabled ? 'User enabled' : 'User disabled', 'good');
                        reload('users');
                      },
                    })
                  : null,
              ),
          },
        ],
      }),
      {
        flush: true,
        actions: button('Add user', {
          kind: 'primary',
          small: true,
          icon: 'plus',
          onClick: async () => {
            const v = await formDialog({
              title: 'Add a user',
              intro: 'They sign in with this temporary password and choose their own.',
              fields: [
                { name: 'email', label: 'Email', type: 'email', required: true },
                { name: 'name', label: 'Name' },
                {
                  name: 'password',
                  label: 'Temporary password',
                  type: 'password',
                  required: true,
                  help: 'At least 12 characters.',
                },
                ...roleFields(['viewer']),
              ],
              submitLabel: 'Create user',
              wide: true,
            });
            if (!v) return;
            const roles = pickRoles(v);
            if (!roles.length) return toast('Pick at least one role', 'bad');
            await api.post('/v1/users', {
              email: v.email.trim(),
              ...(v.name ? { name: v.name } : {}),
              password: v.password,
              roles,
            });
            toast('User created', 'good');
            reload('users');
          },
        }),
      },
    );
  };

  const keys = async () => {
    const { items } = await api.get('/v1/api-keys');
    return card(
      null,
      dataTable({
        rows: items,
        empty: 'No API keys yet.',
        columns: [
          { label: 'Name', render: (k) => h('strong', {}, k.name) },
          { label: 'Key', render: (k) => h('code', { class: 'muted' }, `omf_${k.prefix}_…`) },
          { label: 'Roles', render: (k) => k.roles.map((r) => badge(r, 'neutral')) },
          { label: 'Last used', render: (k) => (k.lastUsedAt ? ago(k.lastUsedAt) : 'never') },
          { label: 'Expires', render: (k) => (k.expiresAt ? timestamp(k.expiresAt) : 'never') },
          {
            label: '',
            render: (k) =>
              k.revokedAt
                ? badge('revoked', 'bad')
                : button('Revoke', {
                    small: true,
                    kind: 'danger',
                    onClick: async () => {
                      if (
                        await confirmDialog({
                          title: `Revoke “${k.name}”?`,
                          message: 'Anything using this key stops working immediately.',
                          confirmLabel: 'Revoke',
                          danger: true,
                        })
                      ) {
                        await api.del(`/v1/api-keys/${api.enc(k.id)}`);
                        toast('Key revoked', 'good');
                        reload('keys');
                      }
                    },
                  }),
          },
        ],
      }),
      {
        flush: true,
        actions: button('Create key', {
          kind: 'primary',
          small: true,
          icon: 'plus',
          onClick: async () => {
            const v = await formDialog({
              title: 'Create an API key',
              intro: 'For scripts, CI and integrations. Give it only the roles it needs.',
              fields: [
                { name: 'name', label: 'Name', required: true, placeholder: 'ci-deploy' },
                ...roleFields(['operator']),
              ],
              submitLabel: 'Create key',
              wide: true,
            });
            if (!v) return;
            const roles = pickRoles(v);
            if (!roles.length) return toast('Pick at least one role', 'bad');
            const r = await api.post('/v1/api-keys', { name: v.name, roles });
            await showSecretDialog({
              title: 'API key created',
              intro: 'Copy the key now. It is shown only once and cannot be recovered.',
              secret: r.key,
            });
            reload('keys');
          },
        }),
      },
    );
  };

  const tenants = async () => {
    const { items } = await api.get('/v1/tenants');
    return card(
      null,
      dataTable({
        rows: items,
        columns: [
          { label: 'Tenant', render: (t) => h('code', {}, t.id) },
          { label: 'Name', render: (t) => t.name },
          { label: 'Created', render: (t) => timestamp(t.createdAt) },
          { label: 'State', render: (t) => (t.disabled ? badge('disabled', 'bad') : badge('active', 'good')) },
        ],
      }),
      {
        flush: true,
        actions: button('Add tenant', {
          kind: 'primary',
          small: true,
          icon: 'plus',
          onClick: async () => {
            const v = await formDialog({
              title: 'Add a tenant',
              intro: 'An isolated workspace: its own workflows, runs, secrets, users and audit log.',
              fields: [
                {
                  name: 'id',
                  label: 'Id',
                  required: true,
                  placeholder: 'acme',
                  help: 'Lowercase letters, digits and dashes.',
                },
                { name: 'name', label: 'Name', required: true },
              ],
              submitLabel: 'Create',
            });
            if (!v) return;
            await api.post('/v1/tenants', v);
            toast('Tenant created. Add its first admin from the command line: omniflow admin create-user', 'good');
            reload('tenants');
          },
        }),
      },
    );
  };

  const channels = async () => {
    const { items } = await api.get('/v1/channels');
    return h(
      'div',
      { class: 'stack' },
      notice(
        'info',
        'Notification channels are configured by whoever runs the server (OMNIFLOW_CHANNELS) so webhook URLs never pass through the browser. Workflows use them with the notify-channel capability; alerts use OMNIFLOW_ALERT_CHANNELS.',
      ),
      card(
        null,
        dataTable({
          rows: items,
          empty: 'No channels are configured.',
          columns: [
            { label: 'Name', render: (c) => h('code', {}, c.name) },
            { label: 'Format', render: (c) => c.format },
          ],
        }),
        { flush: true },
      ),
    );
  };

  const items = [
    { id: 'users', label: 'Users', render: users },
    { id: 'keys', label: 'API keys', render: keys },
  ];
  if (can('tenant.manage')) items.push({ id: 'tenants', label: 'Tenants', render: tenants });
  items.push({ id: 'channels', label: 'Channels', render: channels });
  return h(
    'div',
    {},
    pageHeader('Users & keys', `Signed in to workspace “${session.me.principal.tenant}”.`),
    tabs(items, ctx.query.tab),
  );
}
