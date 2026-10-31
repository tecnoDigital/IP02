# Sequential Retell Dashboard

An early dashboard for importing contacts, managing sequential outbound calls, and reviewing call history with Retell AI and SQLite.

**Version 0.1.0 is experimental, not production-ready.** Normal mode can place real calls. Keep it on a trusted local machine; do not expose it directly to the internet. Existing incompatible databases are rejected, not automatically migrated or reset.

## Install and configure

Use Node.js **24.18.0** (the version declared by the project) and npm.

```sh
npm ci
```

Copy `.env.example` to `.env` without overwriting an existing configuration. On PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with your own values:

- Set a long random `SESSION_SECRET`, then run `npm run auth:setup` in an interactive terminal to create the admin password hash.
- Set `DATABASE_PATH` to a new local database path. Back up existing databases before changing versions. Without an override, Windows stores data in `%LOCALAPPDATA%\ip2\ip2.db`.
- For real calls, configure the `RETELL_*` settings and a reachable `APP_BASE_URL` for webhooks. Never commit credentials, contact data, or database files.

## Run

From the GitHub source checkout, start the backend and frontend with automatic reload:

```sh
npm run dev
```

Open **http://127.0.0.1:5173** and sign in with the password you created. The backend uses port 3000. Stop both services with Ctrl+C.

For a single-server run, build the frontend first:

```sh
npm run build:frontend
npm start
```

Open **http://127.0.0.1:3000** (default). This normal-mode server listens on all network interfaces; restrict access with your firewall. Use `import-templates/contacts-template.csv` as the contact import starting point.

## Package

```sh
npm run package
```

This builds the frontend and creates `sequential-retell-dashboard-0.1.0.tgz` in the project root. It does **not** publish anything or create a standalone executable.

The archive allowlist includes application source, compiled browser assets, the password setup script, build configuration, the CSV template, `.env.example`, this README, and package metadata. It excludes credentials, databases, dependencies, tests, agent tools, local planning, and executable-build artifacts.

To run the archive, extract it into a new directory, enter its `package` folder, run `npm install` (including development dependencies, because startup uses `tsx`), then configure `.env`, run `npm run auth:setup`, and run `npm start`. Node.js is still required. The archive does not include a lockfile or the development/test/Windows executable tooling; use the GitHub checkout for those workflows.

Git publication and distribution are separate: `.gitignore` keeps local-only files out of a future source commit, while `package.json` defines the archive allowlist. Tests remain on disk but are intentionally excluded from this early GitHub release. Keep `scripts/test-environment.ts`: the development launcher imports it even in normal mode.

## More detail

See [PROJECT_GUIDE.md](PROJECT_GUIDE.md) in the source checkout for architecture and operational details.
