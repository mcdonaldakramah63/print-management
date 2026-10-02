# Receipt Management System

A small multi-user system for recording sales and printing A5 receipts.
Built with Node.js, Express, and SQLite — no external database server to set up.

**On Windows?** See [`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md) for one-click setup scripts and a walkthrough of testing Print Monitoring on the same PC.

## Features

- **Checkout** — a product grid with category filters, search and barcode/SKU entry (type or scan the SKU and press Enter); a cart with quantity steppers and per-line price overrides; custom one-off items; flat or % discount; tax from settings. Choose **cash, mobile money or card**; for cash, enter the amount tendered and the change due is shown and printed on the receipt. Optional customer name and phone.
- **A5 receipts, bottom-aligned** — every sale opens a print-ready receipt with your business details, logo, tax/discount breakdown, payment method, tendered and change.
- **Sales history** — filter by date, payment method, status, receipt number, customer or phone; paginated; **CSV export**; reprint any receipt; admins can void a sale (kept in history, excluded from totals, tracked stock returned).
- **Reports** — revenue, sales count, average sale and discounts for any date range, broken down by item, cashier and payment method, with a line-item **CSV export**.
- **End-of-day close (Z-report)** — shows the day's takings by payment method and the cash expected in the drawer; enter the cash counted and the shortage/overage is recorded with an optional note, and a printable Z-report opens. A closed day blocks new sales and voids until an admin reopens it. Unclosed days can be printed as an X-report.
- **Dashboard** — today / last 7 days / this month, a 14-day revenue chart, today's payment mix, top items, low-stock alerts, and (for admins) pages printed today and today's print gap.
- **Print monitoring** — a Windows agent watches the print spooler and reports every finished job (metadata only: document name, pages, colour/mono, user, printer). Admins see a daily summary, a per-printer breakdown and a job log they can mark reviewed or flag. It never creates sales. See `agent/README.md`.
- **Printed vs sold** — mark products as colour or B&W **print services** (1 quantity = 1 page) and this page compares, per day, pages the agents saw printed against pages actually sold, with the gap and its estimated unbilled value.
- **Products & stock** — price, SKU, category, print-service type and optional stock tracking with a low-stock level. Every stock change (opening stock, sale, void, manual adjustment with a reason, edit) is kept in a per-product **stock history**.
- **Accounts & roles** — admin and cashier logins (bcrypt-hashed passwords). Admins add users, edit names and roles, reset passwords and disable accounts (effective immediately). The last active admin can't be demoted.
- **Business settings** — business name, address, phone, email, logo, tax rate, currency, receipt prefix, footer note.

The UI was redesigned from a Claude Design canvas: an ink sidebar on a light paper background, Space Grotesk headings, IBM Plex Sans body text and IBM Plex Mono figures. It works down to phone width.

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
- **Color/mono detection**: `Win32_PrintJob.Color` is a *string* property (`"Color"` or `"Monochrome"`) per Microsoft's documented class members. An earlier version of `watch-print-jobs.ps1` compared it as a boolean, which is a real bug — in PowerShell any non-empty string (including `"Monochrome"`) is truthy, so it reported "color" for nearly everything. That's fixed now: it compares the actual string values. Still worth spot-checking against your printers, since driver accuracy itself can vary.
- **Duplex/two-sided is best-effort, not a guarantee**: `Win32_PrintJob` has no duplex property at all — confirmed against Microsoft's documented class members, not a driver gap. The agent instead reads the *printer's* current default duplex setting (`Win32_PrinterConfiguration.Duplex`) at the moment each job finishes, which is a real signal but not proof that specific job used it — and some drivers don't expose it, in which case it's reported as "unknown" rather than guessed. If you know how a printer is normally used, `agent/config.json`'s `printerDuplexAssumption` lets you override whatever was detected with a manual assumption per printer — clearly a guess, not a detection, same pattern as `printerColorOverride`.
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
│   ├── config.example.json
│   └── README.md              Agent-specific setup & troubleshooting
├── windows/                 install.bat / start.bat / build.bat (standalone .exe, see WINDOWS-SETUP.md)
├── data/                    SQLite database lives here (created on first run)
├── package.json
└── .env.example
```

## Deploying for real use

- Put this behind HTTPS (e.g. behind Nginx or a platform like Render/Railway/a VPS) — login cookies should never travel over plain HTTP.
- Set a strong, random `SESSION_SECRET` in production.
- Back up the `data/receipts.db` file regularly — it's the entire database.
- If you expect many concurrent users, consider swapping the default in-memory session store for a persistent one (e.g. `connect-sqlite3`); fine as-is for a single small shop/team.

## Customizing the receipt

The A5 layout lives in `public/css/print.css` and `public/js/receipt.js`. The page size is set via `@page { size: A5; }`, so it will print correctly on any A5-configured printer without extra setup.
