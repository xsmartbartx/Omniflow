# Brand: the workflow product inside NEXORA

Decisions made by the owner: **find a NEXORA-family name**; **licence: proprietary** (done, see the end). **Name chosen 2026-10-11: Constans** (rename done in the code and docs; the GitHub repository name is unchanged).
Nothing here renames the repo yet. A rename touches the `omniflow` CLI, `OMNIFLOW_*` variables, the `omf_` key prefix, the
package name, the image name and every doc, so it waits for your pick.

Angle (from `fixes.md`, recommended): durable workflows without the cluster; exactly-once and explainable as the proof.

## Name

The NEXORA family uses single, plain words (Sentinel, Gateway) and Latin-flavoured ones (Vigilo). A product lives at
`<product>.onenexora.com` under the platform, so a spare `.com` is not required; the name still needs to be clear to use
as a product, a package and a handle.

**Pool of 20** (style): Constans, Tenax, Fidus (Latin: steady, holding fast, faithful) · Halyard, Weir, Sluice, Cairn,
Orrery, Lockstep (metaphor) · Keelson, Tessel, Vigor (invented/short) · plus seven cut by the filters before any check
(too close to Nextflow or Cadence, which are workflow engines; Conductor, Courier, Dispatch, Relay: taken names in the category).

**Checked on 2026-10-10** (screening only; DNS lookups, GitHub and npm public APIs, one web search each):

| name | result |
| --- | --- |
| Halyard | **out**: Spinnaker's deployment tool is called Halyard (developer tooling, same buyer) |
| Lockstep | **out**: Lockstep is an accounting-automation company (Sage deal, 2022) |
| Sluice | **out**: Sluice is an existing workflow app (InMotion Software) and an older workflow engine |
| Orrery | **out**: Orrery is an existing workflow orchestrator for AI coding agents |
| Weir | **out**: a large industrial company with a global mark |
| Cairn | **out**: npm name and GitHub org taken; crowded name |
| Fidus | **weak**: warehouse-automation software company (Fidus Global, "workflow automation" services from Fidus Srl) |
| Tenax | **possible**: no workflow product found; Tenax Solutions is a cybersecurity firm (adjacent to NEXORA's security products); npm free |
| **Constans** | **best of the pool**: no software product by that name found (the search drifted to "Constellation Software"); npm name free; GitHub name held by an individual; .com parked, .io and .dev have records |

Per candidate, the full check matrix. "to run" means nobody has run it; nothing is marked available without a check.

| check | Constans | Tenax |
| --- | --- | --- |
| US trademark (USPTO, classes 9, 42) | to run | to run |
| EU trademark (EUIPO / TMview) | to run | to run |
| Poland / Canada / WIPO | to run | to run |
| .com / .io / .dev | all have DNS records (parked or in use); not needed under `onenexora.com` | all have DNS records |
| npm package name | free (2026-10-10) | free (2026-10-10) |
| GitHub handle | user exists | user exists |
| App Store / Play | to run | to run |
| X / Instagram / TikTok | to run | to run |
| web search "name + workflow" | no conflict found (2026-10-10) | no workflow product; adjacent security firm |

**Recommendation: Constans**, ahead of Tenax. Cautions: people may read it as "Constance" or "constants", so the tagline and
the logo should carry the meaning ("steady"); a proper trademark search by a lawyer must happen before the rename and
before any money goes into it. These are screening checks, not legal clearance.

**Screening update, 2026-10-16** (WIPO Global Brand Database and USPTO, read-only; screening, not legal clearance):

- **Constans: a direct conflict.** `CONSTANS` was registered in the **UK on 9 October 2026** by Constans Ltd (UK00004400791) in
  Nice classes **9 and 42** (software and software-as-a-service), the classes this product sits in. WIPO shows 33 records
  for the word; the rest are in unrelated fields (a Korean hotel, a Brazilian clinic, an EU machinery mark, expired French wine
  marks) and USPTO has 6 results, none in classes 9 or 42 (one live mark, a restaurant, class 43). Not searched: EUIPO's own
  search, Poland, Canada, and similar names such as Constance or Constant.
- **Tenax: crowded.** WIPO shows 651 records, including 49 in class 9 and 8 in class 42 (most are chemicals, materials and machinery;
  Tenax SpA is the largest owner). USPTO (first 50 of 73 results) shows, in or near the classes that matter:
  **TENAX SECUREOPS**, a live pending application in class 42 for computer and network security services (IP Pathways, LLC,
  Iowa), which is close to NEXORA's security family; **TENAX**, live in classes 37 and 42 for oil and gas technical advice
  (Tenax Energy Systems, LLC); and **TENAX**, live in class 9 among others for chromatography materials (Buchem B.V.) and
  pending for hardware (Tenax Corporation, Maryland). A cancelled class 42 software mark (an individual) is also listed.
- **Recommendation:** do not spend money on Constans until a trademark lawyer has looked at the UK registration. Tenax is not
  a clean fallback either: the pending SECUREOPS class 42 application sits next to the security products NEXORA sells.
  Screen a third candidate from the pool (the rest of the Latin-flavoured names: Fidus is weak; the metaphor names were mostly
  cut) or send a new name; run the same WIPO and USPTO check before choosing.

**Third-round candidates, screened 2026-10-17** (WIPO Global Brand Database, word contained in the mark, all offices, expired
marks included; USPTO for Perdura; screening, not legal clearance):

| name | WIPO records | class 9 | class 42 | what the class 9 and 42 records are |
| --- | --- | --- | --- | --- |
| **Perdura** | 316 | 8 | 8 | In the first 30 by relevance only one: PERDURA, EU, RWA Raiffeisen Ware Austria, classes 6, 19, 20, 37, 42, ended 2013. USPTO: 5 results, none in 9 or 42 (classes 16, 19, 30). **Clearest.** |
| Anchora | 37 | 6 | 5 | **Conflict:** identical ANCHORA registered in the UK on 4 Sep 2026 in classes 9 and 42 (an individual). Out. |
| Firmo | 66 | 4 | 10 | **Conflict:** identical FIRMO in class 42 (with 35, 36): a Swiss registration (DIMEA Digital M&A GmbH, 2023) and an Estonian application (Firmoportaal OÜ, pending); also a Japanese class 9 mark (2007). Out. |
| Stabilis | 67 | 14 | 12 | Counts only; records not read. |
| Serva | 152 | 14 | 20 | Counts only; records not read. |
| Ballast | 347 | 81 | 23 | Counts only; too crowded. |

Only the first ~25 of each result list were read (the page loads lazily), so a class 9 or 42 record deeper in a list can be
missing. Not searched: EUIPO's own database, Poland, Canada, similar spellings, and domain or handle availability.

**Recommendation:** Perdura is the strongest candidate so far. Before any rename, read the remaining Perdura records, check
domains and handles, and have a trademark lawyer look. Do not rename on this screening alone.

Decision needed: pick **Perdura**, **Constans**, **Tenax**, or send me a name. Then I rename in one pass with the sweep as the check.

## Palette

**No change.** The "new palette" step exists to keep a clone away from the original's colours. Here the family look is the
asset: the console already uses NEXORA's indigo tokens (`replica/design/tokens.json`), contrast checked: 15 pairs per
theme, 0 AA failures (re-run 2026-10-10). A product with its own colours would look like a stranger inside the NEXORA shell.
If you later want a product accent, change `accent` and `link` only and re-run `contrast.py`.

## Logo brief

- **Idea:** a mark that says "holds steady while things flow": a line that passes through a fixed point without breaking.
- **Type:** symbol plus wordmark; the symbol alone must work as the favicon.
- **Sizes:** legible at 16 px; 1024x1024 app icon with no transparency (iOS); social image 1200x630.
- **Deliverables:** SVG (light and dark), favicon set, app icon, social image.
- **Must not resemble:** NEXORA's `logo-mark` (keep the family distinct but related, e.g. shared stroke weight, not shared shape), nor any workflow tool's mark (n8n's node graph, Temporal's, Airflow's pinwheel). Put the drafts next to those before approving.
- Open icon sets (Lucide) for UI icons; no logo is drawn here.

## Voice

Three words: **plain, exact, calm.**
- *Plain*, not casual: no jokes in errors, no exclamation marks.
- *Exact*, not technical for its own sake: say what happened and what is true now ("0 of 3 steps ran").
- *Calm*, not reassuring: no "don't worry"; say what is safe and what to do next.

| do | don't |
| --- | --- |
| "The run stopped at step 2. Nothing after it ran." | "Oops! Something went wrong." |
| "Plan limit reached. Dry runs still work." | "You've hit your limit!" |
| "Approve or deny. The run waits and costs nothing." | "Action required!!" |
| "Retried 3 times, then stopped: the server kept answering 503." | "Failed after multiple attempts." |
| "No runs yet. Start one from a workflow page." | "Nothing to see here." |

Ten most-seen strings, rewritten. **Applied 2026-10-11** (name chosen): sign-in subtitle, NEXORA sign-in text, session-ended toast, empty run list and the low-quota notice. The plan-limit text already matched. Not applied because those screens have no such string yet or already read well: run started toast, run-failed text, approvals empty.

| where | now | proposed |
| --- | --- | --- |
| sign-in subtitle | Sign in to build, run and govern workflows. | Sign in to run workflows you can explain. |
| NEXORA sign-in | OmniFlow uses your NEXORA account. Sessions last a few minutes and renew when you continue. | This product uses your NEXORA account. Your session lasts a few minutes and renews when you continue. |
| sign-in button (NEXORA) | Continue with NEXORA | Continue with NEXORA |
| plan card, over 80% | Running low | N runs left this month |
| plan card, at limit | Plan limit reached. New runs are refused until the next period or an upgrade. Dry runs still work. | Plan limit reached. New runs wait for the next period or an upgrade. Dry runs still work. |
| empty run list | (existing) | No runs yet. Start one from a workflow page. |
| run started toast | Run started | Run started |
| run failed | (existing error text) | name the step and the reason, then what is safe |
| approval inbox empty | (existing) | Nothing waiting for you. |
| session ended toast | Your session has ended. Please sign in again. | Your session ended. Continue with NEXORA to pick up where you were. |

## Sweep

`python3 …/sweep.py . --config replica/brand.json` looks for n8n, Zapier, Temporal, Airflow, Camunda and their domains:
**clean** (2026-10-10). There is no original's logo, copy or palette in this repo to leave behind; the check is for future
copy pasted from competitors' docs.

## Licence (done)

`LICENSE` is proprietary, so everything else now says so: `package.json` (`SEE LICENSE IN LICENSE`), `README.md`,
`CONTRIBUTING.md` (contact the holder before contributing), the Dockerfile image label (`LicenseRef-Proprietary`),
`scripts/third-party.mjs`, and the regenerated `THIRD_PARTY_NOTICES.md` and lockfile. Have a lawyer read the contribution
wording and decide whether a contributor agreement is needed. `npm run verify` passes (823 tests).
