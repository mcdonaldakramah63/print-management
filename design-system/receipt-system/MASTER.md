# Receipt System — design system (master)

Written with the project's design skills (`.claude/skills/`): frontend-design
for direction and restraint, ui-ux-pro-max for UX rules and the checklist,
and the animation-principles skills for motion. Page-specific overrides go in
`pages/<page>.md`; without one, this file applies.

## Brief

- **Subject**: the till and back office of a print and copy shop in Ghana
  (cedi prices, MoMo payments): sales, print jobs and photocopies, and the
  printers themselves.
- **Audience**: cashiers standing at a counter, often on a touch screen, in
  daylight, serving a queue; and the owner checking money and machines.
- **Primary job**: ring up a sale in seconds and keep every printed page
  billed and every printer running.

## Direction

Drawn from the shop's own trade: process inks, registration marks and the
colour bar printed at the edge of every proof sheet. The interface is a clean
sheet of bond paper; colour is ink, used only where it means something.

- **One memorable element**: the CMYK colour bar under the brand, the shop's
  signature. It "prints" once when the app opens (the only motion nobody
  asked for). Everything else stays quiet.
- Cyan is the action colour (buttons, links, focus, selection). Magenta
  marks things that need a person (counts, alerts). Yellow is a highlighter,
  only ever a fill behind dark text. Black is the key plate: text.
- No decoration that doesn't encode something: no gradient washes, no
  shadows on resting surfaces (only on things that float: dialogs, toasts,
  menus), no uppercase tracked labels, no monospace for ordinary numbers.

## Colour

| Token | Hex | Use |
|---|---|---|
| `--stock` | `#EEF2F6` | Page background (cool bond paper, not cream) |
| `--sheet` | `#FFFFFF` | Panels, sidebar, inputs |
| `--key` | `#1B1E24` | Text (16.7:1 on sheet) |
| `--key-2` | `#59606C` | Secondary text (6.3:1 on sheet, 5.6:1 on stock) |
| `--cyan` | `#0068A3` | Actions, links, focus (6.0:1 with white text) |
| `--magenta` | `#B8135F` | Counts, attention (6.4:1 with white text) |
| `--yellow` | `#F5C518` | Highlight fill behind `--key` text (10.2:1) |

Semantic: ok `#1F7A4A`, warning text `#8A4B00` on `#FFF3DC`, danger
`#B42318` on `#FDECEA`. All text pairs meet WCAG AA 4.5:1.

## Type

One family, **Archivo** (variable: width 62–125, weight 100–900), a
grotesque with print-trade roots. Personality comes from its width axis:

- Display (page titles, the brand, big totals): Archivo **expanded** (wdth
  118), weight 750, tight tracking.
- Headings: semi-expanded (wdth 108), 650.
- Body: normal width, 400 / 500 / 600, 15 px, line-height 1.5.
- Money and counts: the same face with **tabular figures**
  (`font-variant-numeric: tabular-nums`), so columns line up without a
  monospace font. Monospace is kept only for codes (receipt numbers, keys).

Scale (px): 12.5 · 13.5 · 15 · 17 · 20 · 24 · 30. Sentence case everywhere.

## Layout

```
┌──────────┬──────────────────────────────────────────────┐
│ ■ brand  │ Page title (expanded)          [actions]     │
│ ▮▮▮▮ CMYK│ one line saying what this page is for        │
│ nav      │ ┌──────── panel ────────┐ ┌──── panel ─────┐ │
│  · link  │ │                       │ │                │ │
│  ▌active │ └───────────────────────┘ └────────────────┘ │
│ user     │                                              │
└──────────┴──────────────────────────────────────────────┘
```

Left aligned throughout. White sidebar on the stock background, with a
hairline edge; the active link is cyan with a 3 px rule. Radius follows
hierarchy: panels 14, controls 10, inner rows 8, chips and counts full.
Touch targets at least 44 px for the till's main controls, 8 px apart.

## Motion

Tokens, shared by every animation (ui-ux-pro-max `motion-consistency`):

| Token | Value | Use |
|---|---|---|
| `--t-instant` | 100 ms | press, focus ring, hover colour |
| `--t-quick` | 160 ms | exits, small state changes |
| `--t-base` | 240 ms | view change, list insert, toast in |
| `--t-slow` | 360 ms | dialog in, success draw |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | arriving (decelerate) |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | leaving (accelerate) |
| `--ease-std` | `cubic-bezier(0.4, 0, 0.2, 1)` | moving within the page |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | small overshoot: badges, ticks |

Rules:

1. Motion answers a person's action and shows what changed (cause → effect).
   The only unprompted motion is the colour bar on first load.
2. Exits run at about 65 % of the entrance (dialogs 300 → 180 ms).
3. Only `transform` and `opacity` animate; nothing reflows.
4. Never block input: every animation is interruptible, and state is set
   explicitly, not on `animationend`.
5. Linear only for constant-rate things (spinners, progress stripes).
6. `prefers-reduced-motion: reduce` shows the final state instantly; the fix
   illustrations show their explanatory still frame.

Moments: button press (scale 0.97), cart line in (slide + fade, 240 ms) and
count bump (spring), money totals tween to their new value (280 ms),
completing a sale draws a tick on the button, dialogs scale in from 0.96
with a dimmed and blurred backdrop, toasts rise in with a dwell bar (errors
shake once and stay longer), tabs slide their underline, printer issues
slide in and fold away as "Fixed".

## Checklist before shipping (ui-ux-pro-max)

- Contrast 4.5:1 for text; focus visible on every control.
- Touch targets ≥ 44 px on the till; 8 px between them.
- No horizontal scroll at 375 px; tables scroll inside their panel.
- SVG icons only, no emoji; icon-only buttons have labels.
- `prefers-reduced-motion` respected.
- Copy: sentence case, active verbs, errors say what to do.
