# Running on Windows

This app is plain Node.js/Express, which runs natively on Windows — there's
no separate "Windows build" needed, just Node itself plus the scripts in
this folder to make setup one-click. (A true standalone `.exe` installer
that bundles Node itself is possible with tools like `pkg` or
`electron-builder`, but building one requires internet access to a build
machine that this project wasn't built from — see the note at the bottom if
you want to go that route yourself.)

## 1. Install Node.js

Download and install the **LTS** version from https://nodejs.org (the
installer is a normal Windows `.msi` — click through it with defaults).

## 2. Set up the app

1. Unzip this project anywhere, e.g. `C:\ReceiptSystem`.
2. Double-click **`windows\install.bat`**. It checks for Node, creates a
   `.env` file, and installs dependencies. This only needs to be done once
   (run it again later if you pull an update with new dependencies).

## 3. Run it

Double-click **`windows\start.bat`**. A console window opens (leave it
running — closing it stops the server) and your browser opens automatically
to `http://localhost:3000`.

Log in with the default admin account shown in the console the first time
it runs (`admin` / `admin123` unless you changed `DEFAULT_ADMIN_PASSWORD` in
`.env`) and change the password right away from *My Account*.

## 4. Try Print Monitoring on this same PC

Since the app and a printer can be on the very same Windows machine, this is
the fastest way to see the whole pipeline work end to end:

1. In the app, go to **Print Monitoring** (admin) → **Register agent**.
   Name it something like "Test PC" and copy the API key shown — it's only
   displayed once.
2. Open the `agent` folder and copy `config.example.json` to `config.json`.
3. Edit `config.json`:
   - `"backendUrl": "http://localhost:3000"` (since it's the same PC)
   - `"agentApiKey": "..."` — paste the key from step 1
4. Double-click **`agent\start-agent.bat`**. Leave that window open too.
5. Print anything to any printer set up on this PC (even a "Microsoft Print
   to PDF" printer works for testing — it still creates a real spooler job).
6. Back in the app's **Print Monitoring** page, the job should show up in
   the print job log (as "Unreviewed") within a few seconds of finishing.

Once you're happy it works, move `agent/` to whichever PC is actually
connected to your real printer and point `backendUrl` at your server's real
address instead of `localhost` — see `agent/README.md` for the full agent
setup, including running it automatically at startup via Task Scheduler.

## Using it on other devices on your network

`http://localhost:3000` only works on the PC running the server. For phones,
tablets, or other PCs on the same network to reach it, use that PC's local
IP address instead, e.g. `http://192.168.1.20:3000` (find yours with
`ipconfig` in Command Prompt, look for "IPv4 Address"). Windows Firewall may
prompt you to allow Node.js through on first run — allow it for private
networks.

## Optional: building a standalone `.exe`

To hand someone a single `.exe` that doesn't require installing Node.js,
double-click **`windows\build.bat`** on a Windows PC with Node.js and
internet access (or run `npm run build:win`). It installs dependencies,
installs [`pkg`](https://github.com/vercel/pkg) if needed, and produces
`dist\receipt-system.exe` plus a `dist\public` folder and a `dist\.env`.

Copy the whole `dist\` folder to distribute it — the `.exe`, `public\` and
`.env` must stay together. The database is created in `dist\data\` beside
the `.exe` on first run. Set a real `SESSION_SECRET` in `dist\.env` before
real use.
