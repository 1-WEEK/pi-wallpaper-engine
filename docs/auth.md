# Authentication

Pi Wallpaper Engine ships with optional Passkey-only authentication backed by
[Better Auth](https://better-auth.com). It is **disabled by default**. Enable it
when you expose the backend over the public internet (Cloudflare Tunnel,
reverse proxy, etc.); leave it off for LAN-only setups where the network
boundary is the trust boundary.

## Architecture

```
Browser
  └─ https://pwe.example.com               (Cloudflare edge)
       └─ Cloudflare Tunnel
            └─ connector on LAN
                 └─ http://<pi-lan-ip>:5173 (Vite dev) or :8080 (prod)
                      └─ /api/*            (Elysia + Better Auth)
                           ├─ auth.db      (~/.local/state/pi-wallpaper-engine/auth.db)
                           └─ business db  (~/.local/state/pi-wallpaper-engine/pi-wallpaper-engine.db)
```

- The browser only ever talks to the public HTTPS domain.
- The backend serves over plain HTTP on the Pi LAN; TLS terminates at Cloudflare.
- Cookies are emitted with `Secure; HttpOnly; SameSite=Lax` and host-only scope.
  Better Auth is configured with `useSecureCookies: true` so the `Secure` flag is
  always present regardless of the local transport.

## Enable

1. Pick two strong secrets and export them in the systemd unit or shell that
   launches the backend:

   ```sh
   export PWE_AUTH_SECRET="$(openssl rand -hex 32)"
   export PWE_AUTH_SETUP_TOKEN="$(openssl rand -hex 16)"
   ```

2. Edit `config.json` and add an `auth` section:

   ```json
   {
     "auth": {
       "enabled": true,
       "base_url": "https://pwe-dev.example.com",
       "trusted_origins": ["https://pwe-dev.example.com"],
       "rp_id": "pwe-dev.example.com",
       "admin_email": "admin@example.com",
       "secret_env": "PWE_AUTH_SECRET",
       "setup_token_env": "PWE_AUTH_SETUP_TOKEN",
       "session_days": 30,
       "max_passkeys": 3
     }
   }
   ```

3. Start the backend (`bun run dev:backend` or `systemctl --user restart
   pi-wallpaper-engine`). On first start it creates
   `~/.local/state/pi-wallpaper-engine/auth.db` and applies Better Auth's
   schema migrations automatically.

4. Open the public HTTPS URL in a browser. The frontend will show a setup
   wizard. Paste the setup token, fill in the admin email, and follow the
   passkey prompt. Setup completion is derived from "at least one passkey
   exists" — once that holds, `/sign-up/email` returns `403`. The setup
   token itself is not consumed on success, so an abandoned sign-up
   (account created but no passkey registered) is cleaned up automatically
   on the next attempt and never permanently locks the admin out.

## Dev vs prod separation

- Use different domains, secrets, and setup tokens for dev and prod.
- Passkeys are bound to the RP ID (the hostname). A passkey registered on
  `pwe-dev.example.com` cannot sign in at `pwe.example.com`. Treat the two
  domains as independent installs.
- Do not set a parent-domain cookie. Better Auth defaults to host-only.

## Cloudflare Tunnel notes

- The backend trusts the `Origin` header but not `Host`. Vite's dev proxy
  rewrites `Host` to `localhost`, and the tunnel often does too. `Origin` is
  preserved end-to-end by browsers and intermediaries.
- The connector device must be able to reach `http://<pi-lan-ip>:5173`
  (dev) or `http://<pi-lan-ip>:8080` (prod). If you firewall the Pi origin
  port, allowlist only that connector's LAN IP.
- Cloudflare Access is **not** required. The Better Auth login screen is the
  primary security boundary.

## Rate limiting

The following endpoints have per-IP sliding-window limits:

| Endpoint                                      | Limit            |
|-----------------------------------------------|------------------|
| `POST /api/auth/sign-up/email`                | 5 / minute       |
| `POST /api/auth/sign-in/*`                    | 20 / minute      |
| `POST /api/auth/passkey/verify-*`             | 30 / minute      |

Excess requests get `429 Too Many Requests` with a `Retry-After` header. Limits
are in-memory and reset on backend restart.

## Passkey management

Visit Settings → Passkeys when signed in:

- Add up to `max_passkeys` (default 3) registered devices.
- Each passkey shows its name and creation time.
- Removing the **last** remaining passkey is blocked server-side. Add a second
  passkey before removing the first.

## Emergency reset

If you lose every registered passkey:

```sh
ssh <pi>
bun run --filter @pwe/backend auth:reset -- --yes
systemctl --user restart pi-wallpaper-engine
```

This deletes `auth.db` and its WAL/SHM files. The next browser session will
show the setup wizard again. Make sure `PWE_AUTH_SETUP_TOKEN` is still set
(or set a new one) before re-running setup.

## Disable

Set `auth.enabled = false` in `config.json` and restart the backend. The
business APIs become reachable without a session again. The `auth.db` file is
left in place — it is harmless when auth is disabled, and re-enabling auth
later will pick up the existing admin and passkeys.

## File summary

| File                                                     | Purpose                                          |
|----------------------------------------------------------|--------------------------------------------------|
| `packages/backend/src/services/Auth.ts`                  | Better Auth init, hooks for setup + caps         |
| `packages/backend/src/db/AuthDb.ts`                      | `bun:sqlite` handle; tables are owned by Better Auth migrations |
| `packages/backend/src/routes/auth.ts`                    | Mount `/api/auth/*` + `setup-state` endpoint     |
| `packages/backend/src/middleware/originGuard.ts`         | Origin whitelist on `/api/*`                     |
| `packages/backend/src/middleware/sessionGuard.ts`        | Session check on business `/api/*`               |
| `packages/backend/src/middleware/authRateLimit.ts`       | Per-IP limits on auth endpoints                  |
| `packages/backend/scripts/auth-reset.ts`                 | Emergency wipe of `auth.db`                      |
| `packages/frontend/src/auth.ts`                          | Client helpers (setup, login, passkey CRUD)      |
| `packages/frontend/src/pages/Login.tsx`                  | Passkey sign-in page                             |
| `packages/frontend/src/pages/Setup.tsx`                  | First-run wizard                                 |
| `packages/frontend/src/pages/Settings.tsx`               | Passkey management section                       |
