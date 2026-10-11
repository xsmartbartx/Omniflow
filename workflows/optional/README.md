# Optional examples

These need something the default install does not have — an LLM key, a chat channel, a database.
They are **not** seeded automatically. Validate any of them without a server:

    constans validate workflows/optional

Then publish the ones you can support:

    constans publish workflows/optional/webhook-to-channel.yaml

| File | Needs |
|---|---|
| `webhook-to-channel.yaml` | a channel named `ops` in `CONSTANS_CHANNELS` |
| `nightly-row-count.yaml` | a datasource named `warehouse` in `CONSTANS_DATASOURCES` |
| `llm-ticket-triage.yaml` | `CONSTANS_LLM_API_KEY` |
