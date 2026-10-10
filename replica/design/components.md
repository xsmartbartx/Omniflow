# OmniFlow design system

Source: NEXORA `packages/ui` (`tokens.css`, `button`, `badge`, `card`, `alert`) read from the public repo, and the
current OmniFlow console (`console/styles.css`). Both are the owner's own, so values are reused, not re-invented.
No third-party logos, icons, fonts or copy are involved. Files: `tokens.json` (dark), `tokens.light.json`,
`tokens.css`, `tailwind-theme.css`, `primitives.css`, `preview.html`, `contrast.py`.
Check: `python3 replica/design/contrast.py replica/design/tokens.json` (and `tokens.light.json`): 15 pairs each, 0 AA failures.

## Scales (measured from NEXORA and the console)

| thing | value |
| --- | --- |
| type | xs 12/16 · sm 14/20 · base 16/24 · lg 20/28 (600) · xl 28/34 (700). Console body is 14px; NEXORA marketing uses base. Badges and eyebrows are mono 12px uppercase |
| font | sans = system UI stack (NEXORA: Geist when loaded); mono = JetBrains Mono, then system mono. Both open/OS fonts, nothing licensed |
| space | 4, 8, 12, 16, 24, 32, 48, 64 |
| radius | `--radius` 0.625rem (10px); sm 6, md 8, lg 10, xl 14, pill 999 |
| shadow | none on cards (NEXORA uses borders); popovers only: `0 12px 32px rgba(0,0,0,.35)` dark / `.16` light |
| motion | 120ms fast, 200ms base, `cubic-bezier(.2,.8,.2,1)`; all zeroed under `prefers-reduced-motion` |
| layout | console sidebar 236px, content max 1200px (inherits current), breakpoints 860 / 1000 / 1100 (current console); NEXORA pages max 960-1200 |
| theme | dark default (NEXORA), OS light preference respected, `.light` / `.dark` class overrides |

## Colour roles

`bg, surface, surface-muted, border, border-input, text, text-muted, accent (= NEXORA primary), on-accent, link, secondary,
on-secondary, danger (= destructive), on-danger, success, warning, ring`. Status in the product maps:
succeeded = success, failed = danger, running = secondary, awaiting approval = warning, killed/cancelled = neutral,
rolled-back = warning, compensation-failed = danger. Status is always a text label plus colour, never colour alone.

### Deviations from NEXORA tokens (found by the contrast check)

NEXORA's own values fail WCAG AA in four places. OmniFlow overrides them; recommend upstreaming to `packages/ui`:

| role | NEXORA value | problem | OmniFlow value |
| --- | --- | --- | --- |
| `input` (input border), both themes | = `border` (1.3-1.4:1 on bg) | below 3:1 for UI boundaries | dark `#6c7789` 4.4:1, light `#6a7181` 4.9:1 |
| `secondary` (light) | 199 89% 45% | white on it 3.1:1 | `#096c9a` 5.6:1 |
| `success` as text (light) | 152 60% 36% | 3.9:1 on white | `#1c6e48` 6.2:1 |
| `warning` as text (light) | 38 92% 45% | 2.6:1 on white | `#845606` 6.3:1 |

Dark `on-accent` on `accent` is 4.55:1: it passes, with almost no margin. Do not lighten the primary further.

## Compatibility with the current console

The console uses its own variable names. Mapping for the build step (usage counts are `var(--x)` occurrences in `console/`):

| legacy | new | note |
| --- | --- | --- |
| `--bg` (1) | `--background` | |
| `--panel` (6) / `--panel-2` (10) | `--card` / `--muted` | |
| `--line` (19) | `--border` | |
| `--text` (7) | `--foreground` | |
| `--muted` (27) | `--muted-foreground` | **name clash**: NEXORA `--muted` is a background |
| `--accent` (13) | `--primary` | **name clash**: NEXORA `--accent` is a hover background |
| `--accent-ink` (1) / `--accent-soft` (4) | `--primary-foreground` / `color-mix(in srgb, var(--primary) 14%, var(--background))` | |
| `--good` (9) `--good-bg` (4) | `--success` / color-mix 14% | |
| `--warn` (5) `--warn-bg` (3) | `--warning` / color-mix 14% | |
| `--bad` (14) `--bad-bg` (4) | `--destructive` / color-mix 14% | |
| `--info` (1) | `--secondary` | |
| `--side*` (6) | `--card`, `--muted-foreground`, `--accent` | sidebar becomes a card-coloured rail |
| `--radius` (1), `--shadow` (2), `--mono` (5), `--sans` (3) | `--radius`, drop shadow, `--font-mono`, `--font-sans` | |

Because of the two clashes this is a mechanical rename (~130 occurrences), not an alias file. It happens in `/replica-build`,
and `tests/console/static.test.ts` (CSP checks on the console) must stay green.

## Component specs

```
Button
  variants  primary, secondary, outline, ghost, destructive
  sizes     sm 32px, md 40px, lg 48px (text 14/14/16)
  states    default, hover (primary/secondary 90% mix, destructive 96%, ghost/outline = hover surface), active,
            focus-visible (2px ring token, 2px offset in bg colour), disabled (50% opacity, no pointer events),
            loading (spinner + label kept; aria-busy="true"; stays disabled to clicks)
  tokens    radius md, font sm/500, border outline = border token
  a11y      real <button> or <a>; icon-only buttons need aria-label; destructive actions open a confirm dialog
  used on   S02-S16, S20-S24
```

```
Badge / status badge
  variants  neutral, brand, success, warning, danger, info
  states    static only
  tokens    pill, 1px border at 40% of the colour, mono 12px uppercase, text colour = the role colour
  a11y      the word is the meaning; never colour-only; contrast table above
  used on   S03, S04, S06, S07, S08, S09, S11, S21, S22
```

```
Card
  variants  static, interactive (border goes primary at 50% on hover, whole card is the link)
  parts     header (title 16/24 600, description 14 muted), content (mt 16)
  tokens    radius xl, 1px border, padding 24, bg card
  a11y      interactive card is one <a>, focus ring on the card, one link per card
  used on   S02, S03, S10, S21, S22
```

```
Alert / empty state
  variants  dashed notice (empty or info). Error and success banners use Card + badge colours, text always present
  states    empty, info; loading uses a skeleton row set (same height as final rows) not a spinner
  a11y      role="status" for passive messages, role="alert" for errors that block
  used on   every list screen (S03, S06, S08, S09, S12, S13, S14), S16
```

```
Input / field
  parts     label (500), control 40px, help text, error text (destructive, 12px, aria-describedby)
  states    default, hover (border to foreground at 60%), focus-visible (ring), invalid (destructive border + message),
            disabled, read-only
  tokens    border = `--input`, radius md
  a11y      visible label always; error is text, not only a red border; autocomplete attributes on login
  used on   S01, S05 (editor header), S12, S13, S15, S16
```

```
Table
  parts     header row (12px uppercase muted on muted bg), rows 40px min, numeric columns right-aligned mono
  states    loading (skeleton), empty (Alert), error (Alert + retry), row hover = hover surface, selected
  a11y      <table> with <th scope>; sortable headers are buttons with aria-sort; wrapper scrolls horizontally, never the page
  used on   S03, S06, S09, S11, S12, S13, S14, S15
```

```
Tabs / segmented control (workflow detail, run detail)
  states    default, hover, selected (underline in primary + aria-selected), focus-visible
  a11y      role=tablist/tab/tabpanel, arrow keys move, Home/End
  used on   S04, S07, S10
```

```
Dialog (confirm kill, decide approval, approve change)
  tokens    card bg, border, popover shadow, radius xl, max-width 480
  a11y      focus trap, Escape closes, focus returns to the trigger, title = aria-labelledby, destructive action not the default focus
  used on   S04, S08, S09, S15
```

```
Toast
  states    success, error (does not auto-dismiss), info (6s)
  a11y      aria-live polite (assertive for errors); never the only place an error appears
  used on   all
```

```
Code / YAML editor and diff
  tokens    mono, 13px, border, line numbers muted, added/removed lines use success/destructive at 14% bg with +/- glyphs
  a11y      diff colours always paired with +/- characters; issue list is keyboard-navigable and links to line
  used on   S05, S09
```

```
Graph (workflow DAG) and charts (run timeline, insights)
  tokens    nodes = card + border, edges = muted-foreground, status colours as above; chart series from success, secondary, warning, destructive with direct labels
  a11y      a text/table alternative for every graph (the explain view already exists); no colour-only series
  used on   S02, S04, S07, S10
```

```
App shell (console)
  parts     left rail 236px (nav groups Build / Operate / Configure / Govern), top bar, content
  NEXORA    top strip with product switcher + account menu (NEXORA mode only); NEXORA `packages/shell` is React,
            so in the vanilla console it is a small header island or a plain link strip until the owner decides (architecture R5)
  states    collapsed rail below 860px, skip-to-content link, focus order rail -> content
  used on   S02-S16
```

```
Usage meter (new, NEXORA mode)
  parts     bar (8px, pill) + text "1,180 of 1,500 runs this month · Pro plan" + upgrade link at >= 80%
  states    normal, >= 80% (warning badge), at limit (danger badge + disabled Run buttons with explanation)
  a11y      role="meter" with aria-valuenow/min/max and an accessible name; text always shown
  used on   S02, S03, S04
```

## Built and checked

`preview.html` + `primitives.css` render buttons (5 variants, 3 sizes, disabled, loading), badges (6), cards (static,
interactive), empty state, form (default and invalid), table, usage meter. Checked in dark and light in the Browser pane:
computed colours match the tokens, no console errors. Not built: tabs, dialog, toast, editor/diff, graph, app shell.
Those come with the screens in `/replica-build` (they need the real console DOM).

## Not done, on purpose

- No logo or icon work: use an open icon set (Lucide) when icons are needed; NEXORA's `logo-mark` belongs to NEXORA and is not copied here.
- The console itself is not restyled yet; that is the build step.
- Licensed fonts: none used.
