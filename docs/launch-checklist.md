# Launch checklist

What stands between the running system and a first paying customer, in order. Items marked **you** need a person with the right
accounts; none of them need code. The state of the code and the deployment is in [`project-status.md`](project-status.md).

## Already done

- The app runs at `https://omniflow.onenexora.com`, the product site at `https://www.omniflow.onenexora.com`, both behind the shared edge Caddy.
- Stripe **test mode** has two products (Pro $19 and Team $49 a month, USD) and a webhook destination for
  `https://omniflow.onenexora.com/v1/billing/webhook`. The code for billing, quotas and sign-up is deployed and switched off.

## 1. Back up the master key (you, 2 minutes)

Without `OMNIFLOW_MASTER_KEY`, stored secrets cannot be read again, and a restored backup is useless.

```bash
ssh -i ~/.ssh/nexora-prod.pem -o IdentitiesOnly=yes opc@<host> 'grep ^OMNIFLOW_MASTER_KEY= ~/omniflow/.env'
```

Save the value in a password manager, apart from the server. Then take a data backup and confirm it restores
([`operations.md`](operations.md): `deploy/backup.sh`, `omniflow admin backup`, `omniflow admin restore`).

## 2. Turn billing on in test mode (you, 5 minutes)

You need the sandbox's secret key (`sk_test_…`, Developers → API keys) and the webhook's signing secret (`whsec_…`, on the
`omniflow-billing-test` destination page). Paste them at the prompts; nothing is printed:

```bash
ssh -t -i ~/.ssh/nexora-prod.pem -o IdentitiesOnly=yes opc@<host> 'cd ~/omniflow && read -rsp "Stripe test secret key: " K && echo && read -rsp "Webhook signing secret: " W && echo && cp .env .env.bak && { grep -v -E "^OMNIFLOW_(BILLING_ENABLED|STRIPE_[A-Z_]+)=" .env.bak; printf "OMNIFLOW_BILLING_ENABLED=true\nOMNIFLOW_STRIPE_SECRET_KEY=%s\nOMNIFLOW_STRIPE_WEBHOOK_SECRET=%s\nOMNIFLOW_STRIPE_PRICE_PRO=price_1UUr5KDimAgl5dOBTF1uLZOI\nOMNIFLOW_STRIPE_PRICE_TEAM=price_1UUr5zDimAgl5dOBwy67dJvp\n" "$K" "$W"; } > .env && chmod 600 .env && docker compose up -d && sleep 8 && curl -s https://omniflow.onenexora.com/healthz'
```

If the key is not a test key the server refuses to start; `.env.bak` is the previous file. Then test it end to end
([`stripe-billing.md`](stripe-billing.md)): sign in, open **Plans & billing**, choose Pro, pay with the test card
`4242 4242 4242 4242`, and confirm the plan changes after the webhook arrives. Also try cancelling and a failed payment (card
`4000 0000 0000 0341`).

## 3. Decide the prices (you)

Free $0 / 25 runs, Pro $19 / 500, Team $49 / 2,500 are a proposal. A Stripe price cannot be edited: to change one, create a new
price, archive the old one, and update `OMNIFLOW_STRIPE_PRICE_*`. The pricing page on the product site still says "to be announced".

## 4. The name and the legal pages (you, with a lawyer)

Hand over [`lawyer-brief.md`](lawyer-brief.md). When counsel has cleared a name, a rename is one pass over the code (the earlier
rename to Constans, and its revert, are the playbook). When the privacy and terms pages are final, publish them, name the selling
company, and point sign-up at them so acceptance is required and recorded:

```
OMNIFLOW_SIGNUP_TERMS_URL=https://www.omniflow.onenexora.com/terms.html
OMNIFLOW_SIGNUP_PRIVACY_URL=https://www.omniflow.onenexora.com/privacy.html
```

## 5. Open sign-up (you, after 2 to 4)

Read the open sign-up notes in [`security.md`](security.md) first: set `OMNIFLOW_SMTP_URL` and `OMNIFLOW_SIGNUP_VERIFY_EMAIL=true` so emails are verified, and remember that new accounts use the host's compute.
Then set `OMNIFLOW_SIGNUP=true` (and keep `OMNIFLOW_SIGNUP_MAX_TENANTS` modest) and restart. Point the product site's call to
action at `https://omniflow.onenexora.com/#/signup`.

## 6. Going live with Stripe (you, and one code change)

Test mode is enforced in code: live keys are refused. Going live means (a) completing Stripe's go-live checklist and tax setup for
the jurisdictions you sell into, (b) creating the live products, prices and webhook, and (c) a reviewed change that lifts the
test-key restriction in `server/config.ts` and `billing/service.ts`. Do not paste live keys anywhere before then.

## 7. NEXORA mode (blocked on NEXORA)

NEXORA mode needs the real NEXORA Core and Clerk, and `nx_live_` keys, which do not exist yet. Until then NEXORA mode cannot run in
production (the fake Core is refused), and the standalone product is what is for sale.

## Smoke test after every change

```bash
curl -s https://omniflow.onenexora.com/healthz            # {"status":"ok"}
curl -sI https://www.omniflow.onenexora.com/ | head -1    # HTTP/2 200
```
