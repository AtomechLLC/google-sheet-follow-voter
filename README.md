# Slide Pulse

Live, anonymous, slide-by-slide feedback for Google Slides presentations.

1. Sign in with Google and paste a link to your (private) Google Slides deck.
2. The app fetches a picture of every slide and shows you a QR code.
3. Students scan it on their phones. They see the slide you are on and three buttons:
   **This slide is great!**, **I didn't understand**, **I have a question** (with an optional typed question).
4. Your dashboard shows, live, which slides collected the most confusion and questions.
   Nobody has to raise a hand.

## What's inside

| Page | URL | Who |
|---|---|---|
| Home | `/` | Teacher: sign in, paste a deck link, list past presentations |
| Dashboard | `/t/CODE?key=…` | Teacher: current slide, Prev/Next (also ← → keys), QR code, per-slide totals, question feed |
| Student | `/s/CODE` | Students: follows your current slide, three feedback buttons, can browse back to earlier slides |
| Projected results | `/p/CODE` | Anyone: a bar per slide, top-slide summary, optional question list for the projector |

Votes are stored per anonymous device id (random, kept in the phone's local storage), so each student
counts once per slide and can change their mind. "Great" and "Didn't understand" are mutually exclusive.

Tech: Node.js (Express 5 + `ws`), SQLite (`better-sqlite3`), vanilla HTML/JS, no build step.

## Run it locally

```bash
npm install
cp .env.example .env      # fill in the values below
npm start                 # http://localhost:3000
```

Without Google credentials you can still try everything with placeholder slides:

```bash
DEMO_MODE=1 npm start     # then click "Try a demo deck"
```

## Google setup (one time, ~5 minutes)

The deck is private, so the app reads it through the Google Slides API on your behalf.
It asks only for the `presentations.readonly` scope.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library**: enable **Google Slides API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and your email.
   Under *Scopes* add `.../auth/presentations.readonly`. Under *Test users* add your Google account.
   (While the app is in "Testing" status only listed test users can sign in, which is fine for personal use.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type *Web application*.
   Add this **Authorized redirect URI** (must match `BASE_URL` exactly):

   ```
   https://YOUR-DOMAIN/auth/google/callback
   ```

   For local testing also add `http://localhost:3000/auth/google/callback`.
5. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Configuration

| Variable | Meaning |
|---|---|
| `BASE_URL` | Public URL of the app. Used in the QR code and the OAuth redirect. |
| `PORT` | Port to listen on (default 3000). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the steps above. |
| `SESSION_SECRET` | Random string that signs the teacher cookie. `openssl rand -hex 32` |
| `DATA_DIR` | Where `app.sqlite` and slide images live (default `./data`, `/data` in Docker). |
| `DEMO_MODE` | `1` enables "Try a demo deck". |
| `THUMBNAIL_SIZE` | `SMALL`, `MEDIUM` (default, 800 px) or `LARGE` (1600 px). |

## Deploy with Docker

```bash
cp .env.example .env && $EDITOR .env
docker compose up -d --build
```

The container listens on port 3000 and keeps its data in the `slide-pulse-data` volume.
Put it behind any HTTPS reverse proxy (Caddy, nginx, Fly.io, Railway, Render, …) and set `BASE_URL` to
the public https URL. WebSockets must be passed through (`/ws`); Caddy and most platforms do this by default.

## During class

- Open the dashboard on your laptop next to Google Slides. Advance with the **→** key in the dashboard
  window (or click the thumbnails). Student phones follow automatically.
- Students who fall behind or want to flag an earlier slide can tap ◀ on their phone; a
  "Back to live slide" button brings them back.
- Open **Projected results** on the projector at the end (or any time) to discuss the slides that
  collected the most questions.
- Edited the deck? Click **Re-import slides** on the dashboard.

## Tests

```bash
npm test
```
