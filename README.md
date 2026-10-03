# Receipt Management System

A small multi-user system for recording sales and printing A5 receipts.
Built with Node.js, Express, and SQLite — no external database server to set up.

**On Windows?** There's a standalone app, `ReceiptSystem.exe`, that needs no Node.js install: download the `ReceiptSystem-win-x64` artifact from the latest "Windows app" GitHub Actions run, or build it with `npm run build:exe`. See [`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md).

**Away from the shop?** Turn on **Settings > Remote access and phone app** and install the **Receipt Admin** Android app (the `ReceiptAdmin-android` artifact from the latest "Android app" GitHub Actions run). See [Remote access and the phone app](#remote-access-and-the-phone-app).

## Features

- **Checkout** — a product grid with category filters, search and barcode/SKU entry (type or scan the SKU and press Enter); a cart with quantity steppers and per-line price overrides; custom one-off items; flat or % discount; tax from settings. Choose **cash, mobile money or card**; for cash, enter the amount tendered and the change due is shown and printed on the receipt. Optional customer name and phone.
- **A5 receipts, bottom-aligned** — every sale opens a print-ready receipt with your business details, logo, tax/discount breakdown, payment method, tendered and change.
- **Sales history** — filter by date, payment method, status, receipt number, customer or phone; paginated; **CSV export**; reprint any receipt; admins can void a sale (kept in history, excluded from totals, tracked stock returned).
- **Reports** — revenue, sales count, average sale and discounts for any date range, broken down by item, cashier and payment method, with a line-item **CSV export**.
- **End-of-day close (Z-report)** — shows the day's takings by payment method and the cash expected in the drawer; enter the cash counted and the shortage/overage is recorded with an optional note, and a printable Z-report opens. A closed day blocks new sales and voids until an admin reopens it. Unclosed days can be printed as an X-report.
- **Dashboard** — today / last 7 days / this month, today's payment mix, top items, and (for admins) pages printed today and today's print gap, plus the insight features below.

### Insights (`server/lib/insights/`)

- **Revenue forecast** (`forecast.js`) — damped additive Holt-Winters with a weekly season; smoothing parameters are chosen by grid search on one-step-ahead error, the history is winsorised (median ± 3·MAD) so one huge order can't bend it, and the 80% range comes from the robust spread of the residuals. Shows the next 7 days and the typical error. With under three weeks of data it uses weekday medians. **Today's pace** projects the close from the shop's own intraday profile (the share of a day's takings normally in by this time) and says whether you're ahead, on track or behind.
- **Risk alerts** (`risk.js`, admin) — cashier void rates and discount rates with empirical-Bayes (Beta) shrinkage, so small samples aren't flagged; daily takings vs the same weekday in previous weeks (robust z-score); unusually large print gaps; unusually large cash shortages and runs of consecutive shortages; sales voided long after they were made.
- **Stock-out forecast and reorder quantities** (`stock.js`) — daily demand from the stock log; EWMA for steady sellers and Croston's method (Syntetos-Boylan corrected) for intermittent ones; reorder point = demand over the lead time + safety stock (95% service level); suggested order covers lead time + the review period. Lead time and cover days are set in Settings.
- **Often bought together** (`baskets.js`) — association rules over the last 120 days, ranked by the Wilson lower bound of confidence × log-lift, so coincidences and items that go with everything aren't suggested. Shown at checkout with one-tap add.
- **Customers** (`customers.js`, admin) — customers recognised from the free-text names and phones typed at the till: phones normalised to their last 9 digits, near-identical full names linked by Jaro-Winkler similarity (≥ 0.93, never across different phones, single first names only when unambiguous), merged with union-find. Each customer gets RFM scores and a segment (champion, loyal, promising, new, at risk, needs attention, lost) plus an "overdue" flag when they're well past their own usual gap between visits. Checkout has typo-tolerant name/phone lookup that fills in the phone.
- **Busy hours and staffing** (`traffic.js`, admin, on Reports) — weekday × hour heatmap of customers per hour; service time measured from back-to-back sales; recommended cashiers per hour from the Erlang C queueing model (80% served within 2 minutes). Opening hours are learned per weekday from when sales happen.
- **Product mix and margins** (`productMix.js`, admin, on Reports) — ABC classes by share of revenue and XYZ classes by the coefficient of variation of weekly demand, with stocking advice for each combination; margins from an optional product cost price, snapshotted on every sale line.
- **Printer supplies and after-hours printing** (`supplies.js`) — paper (sheets, duplex-aware) and toner (pages) remaining per printer since the last refill, with a run-out date from that printer's recent use. Print jobs outside the learned opening hours are flagged on their session and raised as a risk alert.
- **Toner and ink levels** (`toner.js`) — the agent reads each cartridge's real level from network printers over SNMP (Printer MIB: black and C/M/Y, drums, waste toner). From the readings the server detects cartridge replacements automatically (a jump of 15+ points), learns pages per 1% for the current cartridge with a Theil-Sen fit of level against pages printed (colour cartridges against colour pages only), and forecasts pages and days left; it flags a cartridge emptying much faster than the last one. The printer's own page counter is compared with the pages the agent saw (after photocopies, below), revealing prints that bypassed the PC. Shown on the dashboard and in Print monitor. Printers without SNMP fall back to the page-count estimate.
- **Printers page: the printer's panel on the web** (`agent/printerControl.js`, `agent/printer-control.ps1`, `server/lib/printerDoctor.js`, `server/lib/printerControl.js`) — cashiers and admins see every printer's screen text, trays, doors, alerts, queue and default settings, and act on them without going to the printer: hold / release / restart / cancel a job, pause / resume printing, bring a printer online, print a test page, and (admins) clear the queue or change default sides, colour and paper size. A diagnosis engine merges three sources (the printer over SNMP, Windows' printer status, and the queue's progress over time) into plain issues with steps and one-click fixes; a jam reported by both is shown once as confirmed, "use printer offline" isn't double-reported as the printer being offline, one empty tray is a heads-up while all empty is out of paper, and a queue whose first job hasn't printed a page in 3 minutes with nothing physically wrong is flagged as stuck. Print speed is learned per printer (median pages per minute between snapshots) for queue wait times. Actions go through a command queue: checked against the live queue (job id *and* document name, since Windows reuses job ids), role-checked, rate-limited, de-duplicated (double-clicks), superseded (Pause then Resume before pickup drops the Pause), leased to the agent and re-delivered if no result arrives, run at most once thanks to a journal on the agent, and expired rather than run late. The agent syncs every 3 s while someone has the page open and every 30 s otherwise.
- **Guided fixes with animations** — every issue on the Printers page has **Show me how**: a step-by-step guide with an animated illustration per step (opening the door, pulling out jammed paper, closing it, loading a tray, swapping a cartridge, emptying the output tray, pressing Online, checking the cable, switching Windows back online). Each step the printer can confirm ticks itself off from the live state (door reported open, jam bit cleared, tray level back up, issue gone), a later step confirming implies the earlier ones, action steps (restart a job, bring online) run from the guide, and it ends with a success animation and the next problem to fix, if any. The page itself animates new problems in, shows "Fixed" as they clear, and pulses a printer that has stopped. Every animation has a still frame for people who prefer reduced motion.
- **A page for each printer** (`server/lib/printerFeatures.js`) — open any printer to see its own Overview, Features, Settings, Queue and Activity. Features are read on demand from the driver's Print Schema capabilities (two-sided, colour, paper sizes, trays, output bins, stapling, hole punch, booklet, pages per sheet, resolution, paper types), Windows (capabilities, paper names, driver, sharing) and the printer over SNMP (model, serial, lifetime page count, print languages, duplex paper path, rated speed), each labelled with its source; "no" is only shown when a source lists the alternatives. Default settings only offer what that printer supports, and the server refuses others (e.g. A3 on a printer without it). Activity shows today's jobs, pages, photocopies, measured speed and a log of who did what from the app.
- **Photocopy detection** (`agent/copyMonitor.js`, `server/lib/copies.js`) — the agent reads each network printer's page counter every minute and keeps a ledger: every spooled job is a credit (pages × copies, or sheets on printers that count sheets) valid from just before it was submitted until 15 minutes after the spooler finished it; every rise of the counter is a debit paid from overlapping credits, oldest first. What stays unpaid after a grace period, while nothing is still spooling, is walk-up output, grouped into photocopy runs. Each run is rated sure / likely / unsure from evidence: the printer reporting "printing" with nothing owed, the run lasting several minutes, a single page (often a report page), or spooled pages missing nearby (likely a late print). Jobs with no page count absorb growth while they print instead of creating false copies; counter resets re-baseline; several Windows queues on one device share a ledger. On the server, pages other agents printed to the same device (matched by IP) are taken off a run, and the same run reported by two agents is kept once. Runs are billed at the till like print sessions, dismissed as "not a sale", counted in Printed vs sold and raised as a risk alert when left unbilled. Vendor copy counters can be configured for exact counts.
- **Print session ↔ sale matching** (`matching.js`) — unbilled print sessions are paired with hand-rung print-service sales by minimum-cost bipartite matching (Hungarian algorithm) on page mismatch, timing and customer-name similarity, with a reject option so weak pairs aren't forced. Printed vs sold then lists "probably rung up by hand" (confirm to link) separately from "no matching sale found", the prints most likely never paid for. Days with print sales but no print data at all (agent not running) are shown but left out of the totals.
- **Print monitoring with job analysis** — a Windows agent watches the print spooler and reports every finished job with the settings it was actually sent with (copies, colour, duplex, paper size, client PC). The server analyses each job (`server/lib/printAnalysis.js`):
  - **Pages actually printed** = pages × copies, plus sheets for duplex jobs.
  - **Was the whole document printed?** The document's length comes from the source file's page count (opt-in agent setting `inspectDocuments`) or, failing that, the same client's earlier prints of it. Each job is marked *all pages*, *partial* ("3 of 12"), *part of a split print* (a document printed in several parts that add up to the whole), or *length unknown*. Identical repeats are flagged as *reprints*.
  - **Client sessions**: each client's jobs (same PC and Windows user) are grouped into a visit using an adaptive time gap (3× the client's typical pause, between 90 s and 10 min). A session is flagged when the client fires **several jobs within a minute** or has **jobs printing at the same time** (overlapping submit-to-finish windows).
  Admins review and flag whole sessions. At the till, cashiers see **print jobs and photocopies waiting to be billed** and add a session to the sale in one tap: it is priced from the colour/B&W print-service products, matching A3/A4 by product name, and jobs printed on both sides go on a **two-sided** service by the sheet when the shop has one. Once billed, a session can't be billed again; voiding the sale reopens it. Nothing is ever billed automatically. See `agent/README.md`.
- **Print services** — mark products as colour or B&W **print** or **photocopy** services, sold for **one side** (1 quantity = 1 page) or **both sides** (1 quantity = 1 sheet, counted as 2 pages).
- **Printed vs sold** — compares, per day, pages the agents saw printed and photocopied against pages actually sold, with the gap and its estimated unbilled value. Blank backs of odd-page documents printed on both sides aren't counted as missing.
- **Products & stock** — price, SKU, category, print-service type and optional stock tracking with a low-stock level. Every stock change (opening stock, sale, void, manual adjustment with a reason, edit) is kept in a per-product **stock history**.
- **Accounts & roles** — admin and cashier logins (bcrypt-hashed passwords). Admins add users, edit names and roles, reset passwords and disable accounts (effective immediately). The last active admin can't be demoted.
- **Business settings** — business name, address, phone, email, logo, tax rate, currency, receipt prefix, footer note.

The UI follows the design system in `design-system/receipt-system/MASTER.md`, built with the design and animation skills in `.claude/skills/` (Anthropic's frontend-design, UI UX Pro Max, and the animation-principles motion skills). The interface is a clean sheet of bond paper with process inks used only where they mean something: cyan for actions, magenta for things that need a person, yellow as a highlighter; the shop's signature is the CMYK colour bar under the logo, which prints in once when the app opens. Type is Archivo (its expanded width for headings, tabular figures for money), bundled in `public/fonts` so the till works offline. Motion uses one set of timing and easing tokens and always answers an action: dialogs scale in and leave faster than they came, toasts rise with a dwell bar (errors shake once and stay longer), cart lines slide in, totals count to their new value, a completed sale draws a tick, tabs slide their underline. Panels are frosted glass over a field of process ink (cyan, magenta and yellow blooms with a halftone screen), with glows in the same inks: buttons, the active page, focus rings, counts, and each printer's health. Extra motion includes press ripples, a pointer spotlight on panels, KPIs that count, growing chart bars, staggered table rows and a CMYK ink splash when a sale completes. The ink only drifts on the sign-in screen (moving ink behind glass is expensive) and shifts when you change page. Everything respects reduced-motion and reduced-transparency settings. It works down to phone width.

**On fonts:** the app loads Source Serif 4, IBM Plex Sans, and IBM Plex Mono from Google Fonts for its look. This needs internet access the first time a page loads (fonts are then cached by the browser); with no internet, it falls back gracefully to system fonts — nothing breaks, it just looks plainer.

If you already have a `data/receipts.db` from an earlier version, it's fine — the app migrates it automatically on startup (adds new tables and columns such as payment details, `stock_movements` and `day_closings`, without touching your existing sales history; older sales are treated as cash).

## Requirements

- Node.js 18 or later
- npm

## Setup

```bash
cd receipt-system
npm install
cp .env.example .env      # then edit .env — at minimum set SESSION_SECRET
npm start
```

The server starts at `http://localhost:3000` (or whatever `PORT` you set).

On first run it creates a SQLite database at `data/receipts.db` and a default admin account:

```
username: admin
password: admin123   (or whatever DEFAULT_ADMIN_PASSWORD you set in .env)
```

**Log in immediately and change this password** from *My Account*, or via *Users → Reset password* for a fresh one.

## Using it

1. **Settings** (admin) — fill in your business name, address, phone, tax rate, currency, and optionally upload a small logo.
2. **Users** (admin) — add a login for each cashier.
3. **Products** (admin) — add the things you sell, with a price, a category and (optionally) stock on hand and a low-stock alert level. Untick "Track stock" for services. Set **Print service** to Colour or B&W on your per-page print products so printing can be compared with sales.
4. **New Sale** — tap products (or search / scan a SKU) to add them, use "+ Custom item" for one-offs, pick the payment method, enter the cash tendered, then complete the sale — a print-ready A5 receipt opens in a new tab.
5. **Sales History** — search and filter past sales, export them to CSV, reprint any receipt.
6. **Reports & close** — run a report for any date range; at the end of each day count the cash drawer and close the day to print the Z-report.
7. **Dashboard** — today/week/month revenue, a 14-day trend, payment mix, best sellers and what's running low.
8. **Print monitor** (admin) — register an agent for each printer-connected PC and install it there (see `agent/README.md`). Every finished print job then shows up in the log.
9. **Printed vs sold** (admin) — once your print products are marked as colour/B&W print services, compare pages printed with pages sold each day.

## Remote access and the phone app

The admin can follow the shop and use every admin page from anywhere, on a
phone or any browser, without port forwarding or a fixed IP address.

```
 shop PC (Receipt System) ──connects out──▶  relay  ◀── phone app / browser
   long-polls for requests                (relay/)     https://relay/s/<shop>/
   pushes an encrypted snapshot every 2 min
```

1. **Run a relay** (once). It is a single dependency-free Node file,
   [`relay/relay.js`](relay/README.md). Free on Render: *New > Blueprint*, pick
   this repository (it reads `render.yaml`), and enter a long random
   `RELAY_KEY`. Or run `docker build -t relay relay && docker run -p 8080:8080 -e RELAY_KEY=… relay`
   on any server behind HTTPS.
2. **On the shop PC**, sign in as admin, change the default password
   (remote access stays off until you do), then open **Settings > Remote
   access and phone app**: enter the relay address and key, switch on
   *Allow admins to connect from anywhere*, and save. The status turns
   *Connected*.
3. **On the phone**, install Receipt Admin (allow installs from your browser
   or file manager), then scan the QR code shown in Settings with the
   phone's camera and tap *Open in Receipt Admin*. Sign in with your admin
   account; the app keeps you signed in for 30 days. Without the app, open
   the shop link in any browser.

**What the app does**

- **Full admin**: the shop's own web app, so every feature (sales, reports
  and Z-reports, printers and remote printer control, print monitor,
  printed vs sold, products, users, settings) is there and always current.
  Receipts and reports print through Android's print service, CSV exports
  download, the logo upload works. Phones get a drawer menu.
- **Summary that works when the shop PC is off**: today's sales against
  yesterday, the week and month, a 14-day chart, payment mix, cashiers,
  printers and their problems, toner, low stock, risk alerts. It comes from
  a snapshot the shop sends every 2 minutes, **encrypted end to end**
  (AES-256-GCM) with a key that only reaches phones through the QR code's
  `#fragment`: the relay stores ciphertext it can't read.
- **Alerts**: every 15 minutes the phone checks each paired shop and
  notifies once per new problem: a printer that stopped, a high-risk alert,
  toner or stock running out.
- **Several shops**: pair as many as you like. A plain address such as
  `http://192.168.1.20:3000` also works, on the shop Wi-Fi only.

**Security**

- Only **admin** accounts can sign in from outside the shop, never with the
  default password, and failed sign-ins lock the account for a while
  (remote and in-shop attempts are counted separately, so internet guessing
  can't lock out the counter).
- The relay only accepts shops that know `RELAY_KEY`, and each shop's link
  secret is pinned on first contact. Use an `https://` relay address.
- Turning remote access off, or **Reset pairing** (new shop address and
  keys: every phone must scan again), can only be done at the shop.
- Sessions are kept in the database, so a restart doesn't sign anyone out.

Building the app yourself, and signing it with your own key:
[`android/README.md`](android/README.md).

## Print monitoring architecture

This is a detection log, not a billing engine — an earlier version of this feature auto-created sales from print jobs, but that's been removed. Nothing here creates, edits, or affects a sale; it exists purely so an admin can see what was printed and compare it against what was rung up.

```
Windows PC + Printer(s)                          Receipt System Backend
┌───────────────────────┐   HTTPS + X-Agent-Key  ┌──────────────────────────┐
│ watch-print-jobs.ps1   │ ─────────────────────▶ │ POST /api/print-jobs/    │
│  (WMI event: job        │  /api/print-jobs/ingest│      ingest              │
│   FINISHED printing on   │                       │  → stored as a log entry │
│   Win32_PrintJob, incl.   │                      │    (draft/unreviewed)    │
│   color mode + pages)      │                     └────────────┬─────────────┘
│         │ JSON per line     │                                  ▼
│         ▼                    │                    Admin "Print Monitoring" page:
│ agent.js                      │                   Daily print activity totals +
│  - batches + retries            │                 job log → mark reviewed, or
│  - local queue.json (offline-safe)│                flag with a note
└───────────────────────┘                          └──────────────────────────┘
```

- **Detection & timing**: the agent subscribes to a WMI event for `Win32_PrintJob` **completion** (not submission) — this fires once a job finishes printing, giving a final, accurate page count and confirming the print actually happened rather than just being requested.
- **Per-job settings (copies, colour, duplex, paper)**: when a job enters the queue the agent reads that job's own DEVMODE from the spooler (`GetJob` level 2), so copies, colour/mono, duplex and paper size reflect what *this job* was sent with. If a job comes and goes too fast to catch (WMI polls every second), it falls back to `Win32_PrintJob.Color` (a *string*, `"Color"`/`"Monochrome"`) and the printer's default duplex setting, and copies are assumed to be 1. Driver accuracy varies, so spot-check against your printers.
- **Manual overrides**: if a printer's driver reports colour or duplex unreliably, `printerColorOverride` / `printerDuplexAssumption` in `agent/config.json` force a value per printer. This is a stated assumption, not a detection.
- **Known-hardware color override**: if a printer's hardware capability is certain (e.g. mono-only), `printerColorOverride` in `agent/config.json` forces its jobs to that mode regardless of what the driver reports.
- **Auth**: agents authenticate with a long random API key (`X-Agent-Key` header), separate from user logins. Keys are stored as SHA-256 hashes server-side and shown to the admin exactly once at registration. An admin can disable an agent at any time to revoke it immediately.
- **Idempotency**: each job is deduped server-side on `(agent, printer, OS job id, day)`, so re-sending a job that already made it through (e.g. after a retry) is a no-op.
- **Resilience**: if the backend is unreachable, jobs queue to a local file on the Windows PC and are retried with exponential backoff; a periodic heartbeat keeps the admin page's online/offline status accurate even when there's nothing to report.

## Project structure

```
receipt-system/
├── server/
│   ├── server.js          Express app entry point
│   ├── db.js               SQLite schema + seed data
│   ├── middleware/
│   │   ├── auth.js         Session auth guards
│   │   └── agentAuth.js    Print agent API-key auth
│   ├── lib/
│   │   ├── saleCreator.js  Sale creation, totals, payments, receipt numbers
│   │   ├── stock.js        Stock changes + stock history log
│   │   ├── printAnalysis.js Pages x copies, document coverage, client sessions
│   │   └── insights/       Forecast, risk, stock, baskets, matching, customers, traffic, product mix, supplies
│   │   ├── remoteLink.js   Outbound link to the relay (long polling)
│   │   ├── pulse.js        Status snapshot for phones, AES-256-GCM
│   │   ├── loginGuard.js   Failed sign-in limits
│   │   ├── sessionStore.js Sessions in SQLite
│   │   ├── dates.js        Local business-date helpers
│   │   └── csv.js          CSV export helper
│   └── routes/
│       ├── auth.js         Login, logout, change password
│       ├── users.js        User management (admin)
│       ├── settings.js     Business settings (admin)
│       ├── sales.js        Create/list/void sales
│       ├── products.js     Product catalog + stock (admin)
│       ├── dashboard.js     Summary stats for the dashboard
│       ├── agents.js        Print monitor agent registration (admin)
│       ├── printJobs.js     Print job ingest (agent) + review queue (admin)
│       ├── reports.js       Date-range reports, CSV export, end-of-day close
│       ├── printSessions.js Client print sessions (admin view + checkout list)
│       ├── insights.js      Forecast, risk, stock outlook, suggestions
│       ├── remote.js        Remote access settings, encrypted snapshot (/__pulse)
│       └── reconciliation.js Pages printed vs pages sold
├── public/
│   ├── login.html
│   ├── app.html             Main app shell (sidebar + views: dashboard, sale, history, reports, print monitor, printed vs sold, products, users, settings, account)
│   ├── receipt.html         A5 print view
│   ├── zreport.html         End-of-day Z-report print view
│   ├── css/
│   │   ├── style.css        App UI styling
│   │   └── print.css        A5 receipt layout
│   └── js/
│       ├── api.js           Shared fetch helper
│       ├── app.js           App logic
│       └── receipt.js       Receipt rendering
├── agent/                   Windows print monitor agent (runs on the printer's PC, not this server)
│   ├── watch-print-jobs.ps1  WMI event watcher — emits JSON per detected job
│   ├── agent.js               Node wrapper: batching, retry queue, heartbeat
│   ├── docPages.js            Opt-in source document page counter (PDF/DOCX/PPTX)
│   ├── snmp.js                Minimal SNMP client (Printer MIB: toner, page counter)
│   ├── printerSupplies.js     Finds printer IPs and reports toner levels
│   ├── copyMonitor.js         Photocopy detection from the printer's page counter
│   ├── printerControl.js      Printers page: snapshots, command sync, at-most-once journal
│   ├── printer-control.ps1    Long-running PowerShell helper that acts on the print spooler
│   └── test/                  SNMP, photocopy and printer-control tests (simulated printer)
│   ├── config.example.json
│   └── README.md              Agent-specific setup & troubleshooting
├── relay/                   Relay for remote access (no dependencies; Dockerfile, test)
├── android/                 Receipt Admin, the Android app (Java, no libraries)
├── scripts/build-exe.js     Builds ReceiptSystem.exe + PrintMonitorAgent.exe (Node SEA)
├── windows/                 install.bat / start.bat / build.bat (standalone .exe, see WINDOWS-SETUP.md)
├── data/                    SQLite database lives here (created on first run)
├── package.json
└── .env.example
```

## Deploying for real use

- Put this behind HTTPS (e.g. behind Nginx or a platform like Render/Railway/a VPS) — login cookies should never travel over plain HTTP.
- Set a strong, random `SESSION_SECRET` in production.
- Back up the `data/receipts.db` file regularly — it's the entire database.
- Sessions are stored in the SQLite database, so they survive restarts.
- To reach the shop from outside, use the relay ([Remote access](#remote-access-and-the-phone-app)) rather than opening a port on the router.

## Customizing the receipt

The A5 layout lives in `public/css/print.css` and `public/js/receipt.js`. The page size is set via `@page { size: A5; }`, so it will print correctly on any A5-configured printer without extra setup.
