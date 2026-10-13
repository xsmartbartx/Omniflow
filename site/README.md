# Constans product site

A standalone, build-less static site for Constans, the way Azure sits under Microsoft: its own site and identity, with a
"NEXORA" family strip linking back to the platform. Four pages (home, platform, security, pricing), one stylesheet, one
small script (theme toggle). No frameworks, no external requests, no inline scripts or styles, so a strict CSP works.

```bash
npm run site        # preview on http://127.0.0.1:18093
npx playwright test e2e/site.spec.ts   # accessibility (dark and light), one h1, mobile width, internal links
docker build -t constans-site site     # image: Caddy + headers
```

## Honesty rules (kept on purpose)

No testimonials, customer logos or user counts until real users agree to be quoted. Status says "in development".
Plan allowances are a proposal; prices read "to be announced". The "not built yet" lists must match `replica/parity.md`.

## Before this goes live (owner decisions)

1. **Domain** for the product site (for example `constans.<yours>`); set `SITE_ADDRESS` and add `sitemap.xml` / canonical URLs.
2. **Call to action:** every "Request early access" points at `https://onenexora.com` as a placeholder. Replace it with the
   real early-access or sign-up URL.
3. **Name:** the site uses *Constans* (the chosen name); run the trademark search first (see `replica/brand.md`).
4. **Legal pages** (terms, privacy) are NEXORA drafts awaiting a lawyer and are not generated here.

## Redirect from NEXORA (done in the NEXORA repo, not here)

`onenexora.com/products/constans` should send people to the product site, while the NEXORA product registry keeps its
entry (so the product still appears in "All products").

Next.js (`next.config.js` in the NEXORA marketing app):

```js
async redirects() {
  return [{ source: '/products/constans', destination: 'https://<product-domain>/', permanent: true }];
}
```

Caddy (if NEXORA is fronted by Caddy):

```caddy
redir /products/constans https://<product-domain>/ permanent
```

Use a 302 first and switch to 301 once the domain is final.
