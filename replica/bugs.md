# Bugs

Found by the axe scans and a visual check while testing PR #19 (`build/nexora-m0`). B-01..B-04 and B-06 were
introduced by the console restyle in that PR; B-05 predates it. All fixed on `test/e2e-nexora-m0`; every one is
covered by the "every console screen" scan (F01-E3), which failed before each fix.

| ID | sev | bug | steps | expected | actual | fix |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | S3 | Sidebar active/hover item and the environment pill filled with the brand colour | sign in, look at the sidebar | subtle hover surface, readable text | solid indigo with muted text; pill text failed AA. Cause: my mechanical variable rename turned the new hover surface into the primary colour | `.nav a:hover`, `.nav a[aria-current]`, `.env-pill` use `--accent` (hover surface) |
| B-02 | S3 | Text in warning/error/info notices failed AA | dashboard at plan limit; any notice | >= 4.5:1 | coloured text on a 14% tint | notices use foreground text with a coloured left edge |
| B-03 | S3 | Links and selected tabs in the brand colour failed AA in dark | dashboard, sidebar Account/Sign out link, editor tabs | >= 4.5:1 | #695def on the card colour ~3.9:1 | text uses `--link` (NEXORA's lighter link token) |
| B-04 | S3 | Status badges (tinted background) failed AA | capabilities list | >= 4.5:1 | 4 badges flagged | outline badges (transparent background, coloured border), as NEXORA's own badge |
| B-05 | S3 | Workflow graph exposed as an image while its nodes are focusable buttons | open a run detail, run axe | nodes reachable and named | axe `nested-interactive`: screen readers may hide the nodes | graph `role="group"` with its label (predates this PR) |
| B-06 | S4 | Environment pill ("DEVELOPMENT") clipped at the sidebar edge | any screen at ~800px | pill fits | text cut off | pill truncates with an ellipsis |

## To check (not reproduced as bugs)

- A member removed or demoted in NEXORA keeps their previous OmniFlow roles until the session (5 min) ends or they sign in again. This is the documented gap, not a regression.
- Contrast of text on screens with real data (approvals, change requests, insights) was not scanned.
