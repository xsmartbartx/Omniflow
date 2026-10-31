# Briefing for a lawyer

Two things need a lawyer before OmniFlow is sold: an opinion on the **name**, and a review of the **legal pages**. This file gives
counsel the facts so the first meeting is not spent collecting them. It is a briefing, not legal advice, and none of the
screening below is legal clearance. Blanks in `[brackets]` are for the owner to fill in.

## What the product is

OmniFlow is software that runs business workflows durably, with approvals, an audit trail and exactly-once handling of side effects.
It is offered as a hosted service under the NEXORA brand (onenexora.com) and as self-hosted software under a proprietary
licence. It is in development; the website says so and shows no customers, testimonials or user counts.

Seller: `[legal entity name, place of business, registration number]`. Intended customers: businesses in `[regions]`.

## Part 1: the name (opinion requested)

**Question:** can the name OmniFlow be used and registered for workflow software and software-as-a-service in `[markets]`, and
what is the risk if it is used before a decision? If not, which of the alternatives below is safest?

Screening done on 2026-10-20 (public databases only; full notes in [`replica/brand.md`](../replica/brand.md)):

- **USPTO:** `OMNIFLOW`, serial 50063002, **live and pending in class 42** for "providing online non-downloadable workflow
  management" software and services, filed by Synergy Folks Inc (California). The same mark for the same kind of services.
- Other live US marks for `OMNIFLOW`: class 42 (Baker Hughes Holdings, registered) and classes 7 and 9 (a Portuguese company,
  US reg. 86524073).
- **WIPO:** 46 records, including a Portuguese smart-lighting-pole company holding `Omniflow` in classes 7, 9 and 42 (EU
  registration 2014, international registration 2022, Malaysia 2023).
- **Domains and handles:** `omniflow.com` and `.io` belong to unrelated businesses; the npm package `omniflow` belongs to someone
  else, so the code is never published under that name.
- **In use:** this product already runs under the name at `omniflow.onenexora.com`. Nothing has been sold.

Alternatives screened, all with their own problems (details in `replica/brand.md`): Constans (a UK class 9 and 42 registration, October
2026), Tenax (crowded, a pending class 42 security application), Perdura (clearest on trademarks, but in live use by a hosting
company in class 42 and its domains and handles are mostly taken), Anchora and Firmo (conflicts).

**Asks:** (1) an opinion on OmniFlow given the pending application, including whether to oppose it, seek consent or coexistence,
or rename; (2) clearance of one replacement name if you advise renaming; (3) whether to file, where and in which classes
(class 9 and 42); (4) the cost of renaming now compared with after the first customer.

## Part 2: the legal pages (review requested)

Drafts: [`site/privacy.html`](../site/privacy.html) and [`site/terms.html`](../site/terms.html). Each is labelled as a draft. These facts
are what the code actually does, so the text can be checked against them.

**Data the service handles**
- Accounts: email address, name, an optional company name, a password stored only as a salted scrypt hash.
- Workflow definitions, run history, secrets (encrypted at rest with a key held by the operator) and an append-only, hash-chained
  audit log. Each customer's data lives in a tenant of its own.
- Sign-up (when switched on) records, on the account's creation event, which terms and privacy pages the person accepted.
- With NEXORA mode on, usage counts and audit events (not step data or secrets) are sent to NEXORA.
- The marketing website sets no cookies and has no analytics; the theme choice sits in the visitor's browser. The web server keeps
  ordinary access logs (IP address, time, page).

**Processors and places**: the hosting provider (Oracle Cloud, region `[region]`), Squarespace (DNS only), Stripe if billing is turned on
(payment data never touches OmniFlow; Stripe Checkout and its portal hold it), and any AI model provider the customer chooses to
configure (off by default; prompts are sent to that provider).

**Points for counsel**
1. Controller and processor roles: for customers' workflow data, OmniFlow is probably a processor. A data processing agreement and a
   list of sub-processors are needed.
2. GDPR and UK GDPR basics: lawful bases, retention (run history and the audit log are kept until the customer archives them and the
   audit log is append-only by design, so what a deletion request can mean needs an answer: self-serve accounts can now delete
   themselves, which erases all their data except the audit events, and those include the sign-up email address), international
   transfers, breach notice.
3. Consumer and business terms: auto-renewing subscriptions, cancellation, refunds, withdrawal rights for consumers, price display and
   VAT or sales tax (billing does not collect tax yet).
4. Liability, warranty and acceptable use. The product can run shell and network steps, so misuse and security-testing rules matter.
5. Governing law, the venue, and the terms for the free tier and early access.
6. The sign-up consent box and its wording, and whether a cookie notice is needed given none are set.

When the pages are final, point sign-up at them and it will require and record acceptance (see the launch checklist).

## What to send counsel

This file; `replica/brand.md` (name research); the two draft pages; [`docs/security.md`](security.md) (what the product does and does
not guarantee); and the pricing page. Nothing else is needed, and no customer data exists yet.
