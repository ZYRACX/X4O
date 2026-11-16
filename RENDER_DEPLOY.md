# Online multiplayer deployment

## 1. Create the Supabase table

Create a Supabase project, open **SQL Editor**, and run [`backend/supabase/schema.sql`](backend/supabase/schema.sql). If you already ran the previous version of the schema, run it again to add the username reservation table and Auth trigger.

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
- `NODE_VERSION` — `20` (set in Render's environment)

Render supplies `PORT` automatically. The backend binds to `0.0.0.0` and exposes `/health` for health checks. Render Web Services support WebSocket connections; Socket.IO also falls back to polling when needed.

## 3. Configure the frontend

In Vercel, set the `VITE_API_URL` environment variable to your Render backend URL (for example, `https://fourfold-api.onrender.com`) and redeploy the frontend. The deployed frontend origin is `https://x4-o.vercel.app`; set that exact value as Render's `WEB_ORIGIN`. For local development, copy `backend/.env.example` to `backend/.env`, run `pnpm install` from the repository root, then run `pnpm --dir backend dev` and `pnpm dev` in separate terminals. Vite proxies `/api` and `/socket.io` to port 3001.

## Rooms and reconnecting

The room creator receives a six-character code and a private player token. Share the code for a private game; public rooms also appear in the lobby list. The second player joins with the code or the public room's Join button. Room state and moves are stored in Supabase; each browser retains its player token locally so it can reconnect in the same browser.

## Player accounts

Players can optionally create an account from the home screen. Supabase Auth stores the email and password, while the profile trigger reserves the chosen username (case-insensitively). Configure the Supabase Auth email confirmation setting for the desired sign-up flow. When confirmation is required, players should confirm their email and then log in. The browser stores the returned Auth session locally; logging out clears that local session.
