# Deployment Notes

Short checklist to turn this branch into a running production instance on
this host. Not a general CloudCLI install guide - see the main README for
that. This assumes the repo is already checked out at
`/home/claude/claudecodeui`.

## 1. Build

```bash
cd /home/claude/claudecodeui
npm ci
npm run build
```

This produces `dist/` (client) and `dist-server/` (server). The systemd unit
below runs the pre-built server directly - it does not rebuild on start, so
re-run `npm run build` after every code update (and before the first start).

## 2. Install the systemd unit

```bash
sudo cp deploy/claudecodeui.service /etc/systemd/system/claudecodeui.service
sudo systemctl daemon-reload
sudo systemctl enable --now claudecodeui
```

The `MemoryMax`/`CPUQuota` values in that unit file are already sized for
this specific host (3.8GB RAM / 2 CPUs, shared with other bots) - see the
comments in `deploy/claudecodeui.service` for the measured baseline they're
based on. Don't copy them as-is to a different host without re-checking.

The unit binds to `HOST=127.0.0.1` only - nothing outside this machine can
reach it yet.

## 3. Reverse proxy + HTTPS + domain

Out of scope for this repo. Putting a real domain with HTTPS in front of the
loopback-only service above (nginx/caddy + a cert) is a separate, later step,
done outside this repository. `docs/nginx-subpath-template.conf` is a
starting point for the nginx side once that's ready.

## 4. JWT secret

Nothing to do here - already automatic. If `JWT_SECRET` is not set in the
environment, the server generates a random secret on first run and persists
it in `app_config` inside the auth database (`appConfigDb.getOrCreateJwtSecret`,
see `server/modules/database/repositories/app-config.ts`). It survives
restarts because it's stored in the DB, not recomputed. Do not set
`JWT_SECRET` manually from `.env.example` - that file's value is a
placeholder, never a real secret.

## 5. Create the first (and only) user

Registration is closed after the first account is created - this is a
single-user system by design (see `server/modules/auth/auth.service.ts`,
`register()`: a second `POST /api/auth/register` returns
`AUTH_USER_ALREADY_CONFIGURED`). To create that first account:

1. Start the service (steps 1-2 above) and open it in a browser
   (`http://127.0.0.1:3001` directly on the host, or through the reverse
   proxy once step 3 is done).
2. Because no user exists yet, the app shows the registration form instead
   of the login form automatically (`GET /api/auth/status` reports
   `needsSetup: true`). Fill in a username (>=3 chars) and password
   (>=6 chars) and submit.
3. From then on this is the only account. To replace it, the row has to be
   removed from the `users` table in the auth database
   (`~/.cloudcli/auth.db` by default, or `DATABASE_PATH` if set) - there is
   no "reset" button in the UI.

Login itself is rate-limited (5 failed attempts per IP+username per 15
minutes, in-memory - resets on every restart). A wrong password shows a
normal "Invalid username or password" message; it does not need any special
handling.

## 6. Smoke-check after deploying

- `sudo systemctl status claudecodeui` - should be `active (running)`.
- Open the site, log in, open a project, send a message that uses a tool
  (e.g. an Edit). Confirm the response streams in, thinking/diff blocks
  render, and reloading the page and reopening the same session shows the
  same content without duplication.
- `journalctl -u claudecodeui -f` for the live log if anything looks off.
