# Receipt Management System

A small multi-user system for recording sales and printing A5 receipts.
Built with Node.js, Express, and SQLite — no external database server to set up.

**On Windows?** See [`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md) for one-click setup scripts and a walkthrough of testing Print Monitoring on the same PC.

## Features

- **Accounts & roles** — admin and cashier logins, session-based auth, passwords hashed with bcrypt.
- **Product catalog** — admins maintain products with price, SKU, category, and optional stock tracking. On the sale screen, typing an item name autocompletes against the catalog, auto-fills the price, and shows stock on hand; selling a catalog item automatically decrements stock. Non-catalog items can still be typed in freely.
- **Dashboard** — today / last 7 days / this month revenue and transaction counts, a 14-day revenue chart, top-selling items (last 30 days), and a low-stock alert list.
- **Print monitoring & auto-billing** — a Windows agent watches the physical print spooler and reports every finished print job (metadata only, never contents — document name, page count, color/mono, submitting user, printer). Set up "print service" products (e.g. "Color Print" / "B&W Print", priced per page); when a job's detected color mode matches exactly one active product, a sale is created and billed **automatically**, closing the loop against print jobs going unrecorded. Anything ambiguous (unclear color mode, no matching product, multiple candidates) lands in a review queue for an admin to pick the product and approve, or reject with a note. See `agent/README.md` for setup. Architecture details below.
- **Sales entry** — add line items, apply a discount (flat amount or %), tax is applied automatically from your settings.
- **A5 receipts, bottom-aligned** — every sale opens a print-ready receipt sized for A5 paper, with your business name, address, logo, tax and discount breakdown, and a footer note. Content sits in the lower half of the sheet with the top left blank, rather than starting at the top.
- **Sales history** — searchable/filterable list of past sales, reprint any receipt, admins can void a sale (kept in history, marked voided).
- **Business settings** — business name, address, phone, email, logo, tax rate, currency, receipt number prefix, footer note (admin only).
- **User management** — admins can add cashiers/admins, disable accounts, reset passwords.

**On fonts:** the app loads Source Serif 4, IBM Plex Sans, and IBM Plex Mono from Google Fonts for its look. This needs internet access the first time a page loads (fonts are then cached by the browser); with no internet, it falls back gracefully to system fonts — nothing breaks, it just looks plainer.

If you already have a `data/receipts.db` from an earlier version, it's fine — the app migrates it automatically on startup (adds new tables like `products`, `agents`, and `print_jobs`, and links sale items to products, without touching your existing sales history).

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

> Note: I built and syntax-checked all the files, but couldn't run `npm install` or a live end-to-end test in this environment — outbound network access here is disabled. Run the steps above on your own machine and let me know if you hit anything odd; happy to debug.

## Using it

1. **Settings** (admin) — fill in your business name, address, phone, tax rate, currency, and optionally upload a small logo.
2. **Users** (admin) — add a login for each cashier.
3. **Products** (admin) — add the things you sell, with a price and (optionally) stock on hand and a low-stock alert level. Untick "Track stock" for services or items you don't want to count.
4. **New Sale** — start typing an item name to pick it from your catalog (price and stock fill in automatically), or type a name that isn't in the catalog for a one-off item. Add a discount if needed, then complete the sale — a print-ready A5 receipt opens in a new tab.
5. **Sales History** — search by receipt number or customer, filter by date, reprint any past receipt.
6. **Dashboard** — see today/week/month revenue, a 14-day trend, your best sellers, and what's running low.
7. **Print Monitoring** (admin) — in Products, add one product for each print type you charge for (e.g. "Color Print" priced per page, marked "Bills color print jobs"; "B&W Print" marked "Bills black & white print jobs"). Register an agent for each printer-connected PC and install it there (see `agent/README.md`). From then on, matching print jobs are billed automatically; anything the system isn't confident about shows up in the review queue for you to resolve.

## Print monitoring & auto-billing architecture

```
Windows PC + Printer(s)                          Receipt System Backend
┌────────────────────────┐   HTTPS + X-Agent-Key  ┌────────────────────────────┐
│ watch-print-jobs.ps1     │ ─────────────────────▶ │ POST /api/print-jobs/      │
│  (WMI event: job          │  /api/print-jobs/ingest│      ingest                │
│   FINISHED printing on     │                       │  → match color_mode against │
│   Win32_PrintJob, incl.     │                      │    an active print product  │
│   color mode + pages)        │                     │                            │
│         │ JSON per line       │                     │  exactly 1 match & pages>0? │
│         ▼                      │                    │   ├─ yes → auto-create sale │
│ agent.js                        │                   │   │        (status: billed)  │
│  - batches + retries              │                 │   └─ no  → status: draft,    │
│  - local queue.json (offline-safe) │                │            needs admin pick  │
└────────────────────────┘                            └─────────────┬──────────────┘
                                                                      ▼
                                                     Admin "Print Monitoring" page:
                                                     billed jobs → "View Receipt";
                                                     drafts → pick product → bill,
                                                     or reject with a note
```

- **Detection & timing**: the agent subscribes to a WMI event for `Win32_PrintJob` **completion** (not submission) — this fires once a job finishes printing, giving a final, accurate page count and confirming the print actually happened rather than just being requested.
- **Color/mono matching**: the driver's color-vs-grayscale setting (`Win32_PrintJob.Color`) is read and matched against active products flagged as billing "color" or "mono" jobs. This is generally reliable for standard drivers but isn't guaranteed for every printer — worth confirming on your actual hardware. Only metadata is ever read (document name, page count, size, color mode, submitting Windows user, printer, timestamp); the document's contents are never touched.
- **Auto-billing is conservative by design**: a job only auto-bills when there's exactly one active product configured for its detected color mode *and* a page count greater than zero. Anything less certain — no matching product, two products claiming the same mode, an undetermined color mode, a missing page count — is left as a draft rather than risking a wrong charge. An admin resolves those from the review queue by picking the product (or rejecting with a note).
- **Auto-billed sales are fully traceable**: they're recorded under a locked system account ("Print Monitor (Auto)") with the customer name set to the Windows username that printed the job, and show up in Sales History and the Print Monitoring queue with a "View Receipt" link like any other sale.
- **Auth**: agents authenticate with a long random API key (`X-Agent-Key` header), separate from user logins. Keys are stored as SHA-256 hashes server-side and shown to the admin exactly once at registration. An admin can disable an agent at any time to revoke it immediately.
- **Idempotency**: each job is deduped server-side on `(agent, printer, OS job id, day)`, so re-sending a job that already made it through (e.g. after a retry) is a no-op.
- **Resilience**: if the backend is unreachable, jobs queue to a local file on the Windows PC and are retried with exponential backoff; a periodic heartbeat keeps the admin page's online/offline status accurate even when there's nothing to report.
- **Correcting a mistake**: a wrongly auto-billed or manually-approved sale isn't reversed from the Print Monitoring page — void the sale itself from Sales History instead, the same way you'd correct any other sale.

## Project structure

```
receipt-system/
├── server/
│   ├── server.js          Express app entry point
│   ├── db.js               SQLite schema + seed data
│   ├── middleware/auth.js  Session auth guards
│   └── routes/
│       ├── auth.js         Login, logout, change password
│       ├── users.js        User management (admin)
│       ├── settings.js     Business settings (admin)
│       ├── sales.js        Create/list/void sales
│       ├── products.js     Product catalog + stock (admin)
│       ├── dashboard.js     Summary stats for the dashboard
│       ├── agents.js        Print monitor agent registration (admin)
│       └── printJobs.js     Print job ingest (agent) + review queue (admin)
├── public/
│   ├── login.html
│   ├── app.html             Main app shell (sidebar + views: dashboard, sale, history, products, print monitoring, users, settings, account)
│   ├── receipt.html         A5 print view
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
