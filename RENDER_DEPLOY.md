# Online multiplayer deployment

## 1. Create the Supabase table

Create a Supabase project, open **SQL Editor**, and run [`backend/supabase/schema.sql`](backend/supabase/schema.sql). If you already ran an earlier version of the schema, run it again to add the username reservation table, Auth trigger, and online match winner field.

In the Supabase project settings, copy the project URL and a **secret key** for server-side access. The key is a backend secret: never put it in a `VITE_` variable or commit it. The backend also accepts the legacy `service_role` key under `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Deploy the backend to Render

Create a **Web Service** from this repository with:

- Root directory: `backend`
- Build command: `pnpm install --no-frozen-lockfile && pnpm -w run build`
- Start command: `pnpm start`

Set these Render environment variables:

- `SUPABASE_URL` — project URL
- `SUPABASE_SECRET_KEY` — Supabase secret key
- `WEB_ORIGIN` — `https://x4-o.vercel.app` (your deployed frontend origin; use comma-separated origins if you add more frontends)
- `APP_ORIGIN` — `https://x4-o.vercel.app` (where Supabase should send players after email confirmation)
- `NODE_VERSION` — `20` (set in Render's environment)

Render supplies `PORT` automatically. The backend binds to `0.0.0.0` and exposes `/health` for health checks. Render Web Services support WebSocket connections; Socket.IO also falls back to polling when needed.

## 3. Configure the frontend

In Vercel, set the `VITE_API_URL` environment variable to your Render backend URL (for example, `https://fourfold-api.onrender.com`) and redeploy the frontend. The deployed frontend origin is `https://x4-o.vercel.app`; set that exact value as Render's `WEB_ORIGIN`. For local development, copy `backend/.env.example` to `backend/.env`, run `pnpm install` from the repository root, then run `pnpm --dir backend dev` and `pnpm dev` in separate terminals. Vite proxies `/api` and `/socket.io` to port 3001.

## Rooms and reconnecting

The room creator receives a six-character code and a private player token. Share the code for a private game; public rooms also appear in the lobby list. The second player joins with the code or the public room's Join button. Room state and moves are stored in Supabase; each browser retains its player token locally so it can reconnect in the same browser.

## Player accounts

Players can optionally create an account from the home screen. Supabase Auth stores the email and password, while the profile trigger reserves the chosen username (case-insensitively). Set Supabase **Authentication → URL Configuration → Site URL** to `https://x4-o.vercel.app`, and add that same URL to **Redirect URLs**. Configure the Render backend's `APP_ORIGIN` to `https://x4-o.vercel.app` as well. These settings send confirmation links back to the deployed game instead of a local development address. The game completes the confirmation and stores the returned Auth session locally; logging out clears that local session.

Random 1v1 matchmaking has separate first-come-first-served queues for verified and unverified accounts; players never match across those queues. New unverified signups receive a short-lived, matchmaking-only ticket so they can queue before confirming their email, since Supabase does not issue a normal session while confirmation is pending. Each pair gets a 10-second ready check. Queue state and these temporary tickets are held in backend memory, so deploy one backend instance; a backend restart clears the current queue and outstanding unverified tickets.

In an online match, selecting **Leave match** awards the win to the opponent. If a browser closes or loses its connection, the opponent wins after a 10-second reconnect grace period. The `winner_seat` column stores this result; re-run the schema script before deploying the backend change.
