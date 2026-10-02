# Screenshot Preference Study

Participants enter their name, email and the shared passcode (the same email resumes their progress), then see groups of **1 original + 3 AI
variants** (`_A`, `_B`, `_C`) as four tiles in a random order and pick the best one.
After 10 picks they're asked, once, to explain what their choices were based on.
Everything is recorded in PostgreSQL and shown at **`/admin`**.

Images are read from `public/images/original` (not AI) and
`public/images/variants` (AI). They are served as `/img/<id>`, so the URL never
reveals which tile is the original.

## Local development

```bash
npm install
cp .env.example .env          # set DATABASE_URL, ADMIN_PASSWORD, PARTICIPANT_PASSCODE
createdb image_select         # if using a local Postgres
npm run db:seed               # create tables + seed the images table
npm run dev                   # API on :3001, Vite on http://localhost:5180
```

Admin panel: http://localhost:5180/admin (password = `ADMIN_PASSWORD`).

## Deploying on Railway

1. Push this folder to a GitHub repo, including `public/images` (~68 MB).
2. In Railway: **New Project → Deploy from GitHub repo**.
3. In the same project: **+ New → Database → PostgreSQL**.
4. On the web service, open **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_PASSWORD` = a strong password
   - `PARTICIPANT_PASSCODE` = the passcode you give participants
5. **Settings → Networking → Generate Domain**.

`railway.json` runs `npm run build`, then `npm start`. On every boot, `npm start` runs the
seed (it creates the tables if needed and upserts the images, so it is idempotent) and then
starts the server. To seed from your laptop instead, copy the Postgres service's
**public** URL and run `DATABASE_URL=<url> PGSSL=true npm run db:seed`.

## Data recorded

| Table        | Contents |
|--------------|----------|
| `images`     | `name`, `group_stem`, `variant` (original/A/B/C), `is_ai`, `path` |
| `sessions`   | `name`, `email` (unique), `started_at`, `last_active_at`, `completed_at`, user agent |
| `selections` | per session and group: chosen `image_id`, `is_ai`, tile position (1–4), response time (ms), number of changes, `selected_at` |
| `feedback`   | the free-text reason, and how many picks had been made when it was written |

Session time is `completed_at` (or the last activity) minus `started_at`.
The admin panel shows totals, picks by image type, per-participant rows, a
per-session drill-down with thumbnails, and a CSV export of every selection.
