# Print Monitor Agent (Windows)

Runs on a Windows PC connected to a physical printer. It watches the print
spooler and reports each finished job's **metadata** (document name, final
page count, color/mono mode, submitting Windows user, printer, timestamp) to
the receipt system. **It never reads the contents of what's printed.**

If the app has an active print-service product matching the job's detected
color mode (see *Auto-billing* in the main `README.md`), a sale is created
automatically — that's the anti-theft point of this whole feature: a print
job either gets billed the instant it finishes, or it lands in an admin
review queue, but it's never simply invisible.

## How it works

- `watch-print-jobs.ps1` subscribes to a WMI event for `Win32_PrintJob`
  **completion** — it fires once a job finishes printing (or is cancelled),
  which gives an accurate final page count and confirms the print actually
  happened, rather than firing the instant it's merely queued.
- `agent.js` runs that script as a child process, batches the jobs it emits,
  and POSTs them to `/api/print-jobs/ingest` on your server, authenticated
  with an agent API key (not a user login).
- If the server is unreachable, jobs pile up in a local `queue.json` file and
  are retried with backoff — nothing is lost.
- A quiet heartbeat is sent periodically even with no jobs, so the admin
  Print Monitoring page can show the agent as online/offline.

## Setup

1. **Install Node.js** (18 or later) on the Windows PC connected to the
   printer: https://nodejs.org
2. Copy this `agent/` folder onto that PC.
3. In the web app, sign in as an admin, go to **Print Monitoring**, and
   register an agent (e.g. name it "Front Desk PC"). **Copy the API key
   shown — it's only displayed once.**
4. In the `agent/` folder:
   ```
   copy config.example.json config.json
   ```
   Edit `config.json`:
   - `backendUrl` — your server's URL, e.g. `https://receipts.myshop.example`
     (use `http://localhost:3000` only for local testing)
   - `agentApiKey` — the key from step 3
   - `printers` — leave as `[]` to watch every printer on this PC, or list
     specific printer names to only watch those
5. Test it:
   ```
   node agent.js
   ```
   Print something on the PC, then check the **Print Monitoring** page in
   the app — the job should appear as "Pending review" within a couple of
   seconds.

## Running it automatically (Task Scheduler)

The simplest way to keep the agent running without a visible window:

1. Open **Task Scheduler** → **Create Task** (not "Basic Task").
2. **General** tab: name it "Print Monitor Agent". Under "Security options",
   choose **Run whether user is logged on or not** if you want it active even
   when no one's signed in (you'll be prompted for the account password);
   otherwise **Run only when user is logged on** is simpler.
3. **Triggers** tab: New → **At startup** (or **At log on**).
4. **Actions** tab: New → Action **Start a program**:
   - Program/script: `node.exe` (or the full path, e.g.
     `C:\Program Files\nodejs\node.exe`)
   - Add arguments: `agent.js`
   - Start in: the full path to this `agent/` folder
5. Save. Test with **Run** in Task Scheduler, then check the app's Print
   Monitoring page for the agent showing "Online".

For a true Windows Service (survives even without any user context and
restarts itself on crash more robustly than Task Scheduler), the
[`node-windows`](https://www.npmjs.com/package/node-windows) package can wrap
`agent.js` as a service — worth doing once you've confirmed the agent works,
if you want the extra robustness.

## Troubleshooting

- **No jobs appear at all** — confirm WMI can see print jobs on this machine.
  Print something slow enough to catch mid-job (a multi-page document works
  well) and, *while it's still printing*, run this in PowerShell:
  ```powershell
  Get-CimInstance Win32_PrintJob
  ```
  If that returns nothing while a job is clearly queued, the issue is with
  this Windows install's print subsystem, not the agent. Note the agent
  itself reports jobs on *completion*, not submission (see "How it works"
  above), so give it a few seconds after printing finishes before checking
  the app.
- **A job never shows up even though printing finished** — very short or
  instantly-completing jobs (e.g. printing to a virtual/PDF printer) can
  sometimes come and go faster than the 2-second WMI polling interval this
  script uses internally to catch deletion events; this is a known
  limitation of WMI eventing, not something the agent can fully avoid.
- **Color mode shows "Unknown" for everything, or is wrong** — the print
  driver isn't reporting `Win32_PrintJob.Color` accurately. This varies by
  printer/driver. If you *know* a printer's hardware capability for certain
  (e.g. it's mono-only hardware and physically can't print color), you can
  force its jobs to always report that mode instead of trusting the driver.
  In `config.json`, add:
  ```json
  "printerColorOverride": {
    "Exact Printer Name As Windows Shows It": "mono"
  }
  ```
  Find the exact name with `Get-Printer | Select Name` in PowerShell — it
  must match exactly (case-sensitive). This is useful for printers whose
  driver reports a generic default rather than the real per-job setting; for
  genuinely color-capable printers there's no such shortcut, since the mode
  really does vary job to job — those rely on accurate detection, or on the
  "require manual review for every print job" setting in the app if you
  don't trust it yet.
- **"Could not start powershell.exe"** — this only runs on Windows;
  PowerShell ships with it by default, so this usually means `node.exe`
  isn't finding it on PATH.
- **Execution policy errors** — shouldn't happen; the agent launches the
  script with `-ExecutionPolicy Bypass` scoped to just that one process, so
  your system-wide policy is untouched.
- **"Agent key looks invalid or revoked"** in the log — re-check
  `agentApiKey` in `config.json`, or the agent may have been disabled from
  the Print Monitoring admin page.
- **A job billed for 0 pages, or didn't auto-bill despite a clear match** —
  the agent reports `PagesPrinted` if available, otherwise `TotalPages`;
  some drivers don't populate either reliably. Jobs with no usable page
  count are always left as drafts rather than auto-billed with a guessed
  page count — you'll need to enter the page count manually when approving.
- **Firewall** — this agent only makes outbound HTTPS requests to
  `backendUrl`; it doesn't need to accept any inbound connections.
