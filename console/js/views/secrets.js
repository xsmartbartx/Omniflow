import * as api from '../api.js';
import { h } from '../dom.js';
import { ago, timestamp } from '../format.js';
import { can } from '../session.js';
import { button, card, confirmDialog, dataTable, formDialog, notice, pageHeader, toast } from '../ui.js';

export default async function secrets(ctx) {
  const { items } = await api.get('/v1/secrets');
  const write = can('secret.write');
  const set = async (existing) => {
    const v = await formDialog({
      title: existing ? `Replace ${existing.name}` : 'New secret',
      intro: 'The value is encrypted at rest and can never be read back — only workflows that reference it as ${{ secrets.NAME }} can use it.',
      fields: [{ name: 'name', label: 'Name', required: true, value: existing?.name ?? '', placeholder: 'STRIPE_API_KEY', help: 'Letters, digits and underscores.' }, { name: 'value', label: 'Value', type: 'password', required: true }, { name: 'description', label: 'Description (optional)', value: existing?.description ?? '' }],
      submitLabel: 'Store',
    });
    if (!v) return;
    await api.put(`/v1/secrets/${api.enc(v.name)}`, { value: v.value, ...(v.description ? { description: v.description } : {}) });
    toast('Secret stored', 'good');
    ctx.navigate('/secrets');
  };
  return h('div', {}, pageHeader('Secrets', 'Credentials your workflows use. Values are write-only.', write ? button('New secret', { kind: 'primary', icon: 'plus', onClick: () => set() }) : null), h('div', { class: 'stack' }, notice('info', 'A workflow never sees a secret in its manifest: it references the name, and the value is leased to a single step for the duration of that step.'), card(null, dataTable({ rows: items, empty: 'No secrets stored yet.', columns: [{ label: 'Name', render: (s) => h('code', {}, s.name) }, { label: 'Description', render: (s) => s.description ?? '' }, { label: 'Updated', render: (s) => h('span', { title: timestamp(s.updatedAt) }, ago(s.updatedAt)) }, { label: 'By', render: (s) => s.createdBy }, { label: '', render: (s) => (write ? h('span', { class: 'row', style: { gap: '4px' } }, button('Replace', { small: true, onClick: () => set(s) }), button('Delete', { small: true, kind: 'danger', onClick: async () => { if (await confirmDialog({ title: `Delete ${s.name}?`, message: 'Workflows that reference it will fail until it is created again.', confirmLabel: 'Delete', danger: true })) { await api.del(`/v1/secrets/${api.enc(s.name)}`); toast('Deleted', 'good'); ctx.navigate('/secrets'); } } })) : '') }] }), { flush: true })));
}
