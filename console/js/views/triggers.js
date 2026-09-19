import * as api from '../api.js';
import { h } from '../dom.js';
import { timestamp, until } from '../format.js';
import { can } from '../session.js';
import { badge, button, card, codeBlock, dataTable, kv, pageHeader, showSecretDialog } from '../ui.js';
import { wfLink } from './common.js';

export default async function triggers() {
  const { items, hookUrl } = await api.get('/v1/triggers');
  const detail = (t) =>
    t.config?.cron ??
    t.config?.event ??
    t.config?.workflow ??
    (t.type === 'webhook' ? `${hookUrl}/${t.workflowName}/${t.name}` : '');
  return h(
    'div',
    {},
    pageHeader('Triggers', 'What starts workflows automatically.'),
    card(
      null,
      dataTable({
        rows: items,
        empty: 'No automatic triggers are registered. Workflows can still be run by hand or through the API.',
        columns: [
          { label: 'Workflow', render: (t) => wfLink(t.workflowName) },
          { label: 'Trigger', render: (t) => t.name },
          { label: 'Type', render: (t) => badge(t.type, 'neutral') },
          { label: 'Detail', render: (t) => h('code', { class: 'muted' }, detail(t)) },
          {
            label: 'Next fire',
            class: 'nowrap',
            render: (t) => (t.nextFireAt ? h('span', { title: timestamp(t.nextFireAt) }, until(t.nextFireAt)) : '—'),
          },
          { label: 'Enabled', render: (t) => (t.enabled ? badge('yes', 'good') : badge('no', 'neutral')) },
          {
            label: '',
            render: (t) =>
              t.type === 'webhook' && can('trigger.manage')
                ? button('Signing secret', {
                    small: true,
                    onClick: async () => {
                      const r = await api.post(
                        `/v1/workflows/${api.enc(t.workflowName)}/triggers/${api.enc(t.name)}/rotate-secret`,
                        {},
                      );
                      await showSecretDialog({
                        title: `Webhook secret for ${t.workflowName}/${t.name}`,
                        intro:
                          'Copy the secret now — it is not shown again. Anything already using the old secret stops working.',
                        secret: r.secret,
                        extra: h(
                          'div',
                          { class: 'stack' },
                          kv([['URL', h('code', {}, r.url)]]),
                          h('p', { class: 'muted' }, r.signing),
                          codeBlock(
                            `ts=$(date +%s)\nbody='{"hello":"world"}'\nsig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')\ncurl -X POST '${r.url}' \\\n  -H "X-OmniFlow-Timestamp: $ts" -H "X-OmniFlow-Signature: v1=$sig" \\\n  -H 'content-type: application/json' -d "$body"`,
                            { label: 'Example delivery' },
                          ),
                        ),
                      });
                    },
                  })
                : '',
          },
        ],
      }),
      { flush: true },
    ),
  );
}
