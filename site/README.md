# OmniFlow product site

A standalone, build-less static site for OmniFlow, the way Azure sits under Microsoft: its own site and identity, with a
"NEXORA" family strip linking back to the platform. Four pages (home, platform, security, pricing), one stylesheet, one
small script (theme toggle). No frameworks, no external requests, no inline scripts or styles, so a strict CSP works.

```bash
npm run site        # preview on http://127.0.0.1:18093
npx playwright test e2e/site.spec.ts   # accessibility (dark and light), one h1, mobile width, internal links
docker build -t omniflow-site site     # image: Caddy + headers
```

## Honesty rules (kept on purpose)

No testimonials, customer logos or user counts until real users agree to be quoted. Status says "in development".
Plan allowances are a proposal; prices read "to be announced". The "not built yet" lists must match `replica/parity.md`.

## Deploying it

The site runs as the `site` service of the root `docker-compose.yml` (profile `site`): a hardened Caddy serving plain HTTP
on the compose network, no published port, TLS terminated by whatever sits in front.

```bash
docker compose --profile site up -d --build site
```

On the NEXORA host the shared edge Caddy proxies `www.omniflow.onenexora.com` to it (the block is in the NEXORA repo,
`infrastructure/edge/Caddyfile`). That hostname is a placeholder chosen so the app keeps `omniflow.onenexora.com`; swap it
for the real product domain when you pick one. The header's "Sign in" link goes to the app.

## Before this goes live (owner decisions)

1. **Domain** for the product site (for example `omniflow.<yours>`); set `SITE_ADDRESS` and add `sitemap.xml` / canonical URLs.
2. **Call to action:** every "Request early access" and "Contact NEXORA" button opens `https://onenexora.com/company#contact`,
   the contact section NEXORA's own "Get started" button uses (it says to email for partnership or early access).
   Replace it with a dedicated sign-up or form URL once there is one; it is the `EARLY` constant in the generator, and
   the same link appears in the four `.html` pages.
3. **Name:** the site uses *OmniFlow* (the chosen name); run the trademark search first (see `replica/brand.md`).
4. **Legal pages** (terms, privacy) are NEXORA drafts awaiting a lawyer and are not generated here.

## Redirect from NEXORA (done in the NEXORA repo, not here)

`onenexora.com/products/omniflow` should send people to the product site, while the NEXORA product registry keeps its
entry (so the product still appears in "All products").

Next.js (`next.config.js` in the NEXORA marketing app):

```js
async redirects() {
  return [{ source: '/products/omniflow', destination: 'https://<product-domain>/', permanent: true }];
}
```

Caddy (if NEXORA is fronted by Caddy):

```caddy
redir /products/omniflow https://<product-domain>/ permanent
```

Use a 302 first and switch to 301 once the domain is final.
