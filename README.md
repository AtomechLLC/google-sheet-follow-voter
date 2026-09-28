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
| Dashboard | `/t/CODE?key=…` | Instructors (owner or invited co-instructors): current slide, Prev/Next (also ← → keys), QR code, per-slide totals, question feed |
| Student | `/s/CODE` | Students: follows your current slide, three feedback buttons, can browse back to earlier slides |
| Projected results | `/p/CODE` | Anyone: a bar per slide, top-slide summary, optional question list for the projector |

Votes are stored per anonymous device id (random, kept in the phone's local storage), so each student
counts once per slide and can change their mind. "Great" and "Didn't understand" are mutually exclusive.

Tech: Node.js (Express 5 + `ws`), SQLite (`better-sqlite3`), vanilla HTML/JS, no build step.
An optional Chrome extension (`extension/`) lets phones follow Google Slides automatically.

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

## Two (or more) instructors

Any number of instructors can drive the same presentation.

- On the dashboard click **Invite co-instructor** to copy an invite link and send it to your colleague.
  It opens the same dashboard with the same controls, except **Re-import** and **Delete**, which stay
  with the owner. If the colleague is signed in with Google, the presentation also appears in their list.
- Everyone picks a display name the first time they open the dashboard (click the "You: …" pill to
  change it). When someone else changes the slide you see "Set by Sam · just now" under the slide
  number, and the header shows who else is on the dashboard right now.
- The last change wins. There is no lock, so agree who is driving; the attribution line makes an
  accidental takeover obvious.
- With the Chrome extension, each instructor pairs their own browser using the invite link (or the
  owner link). Set your name in the popup so changes are attributed. When a colleague is presenting
  from their laptop, tick **Pause** in your popup so your open copy of the deck doesn't fight theirs.

## Chrome extension: phones follow Google Slides automatically

Google offers no way for a website to know which slide you are presenting, so the dashboard's
Prev/Next is the default. The `extension/` folder contains a small Chrome extension that removes
that step: while you present in Google Slides, it watches the tab's URL (which carries the current
slide's id) and tells the server. Student phones follow with no dashboard interaction.

Install once (Chrome, Edge, Brave, or any Chromium browser):

1. Download the extension from your own server at `https://YOUR-DOMAIN/extension.zip` (linked from the
   home page and from every dashboard) and unzip it somewhere permanent. The `extension/` folder in this
   repository is the same thing.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and choose
   the unzipped folder.
3. Pin the "Slide Pulse Follower" icon, click it, and paste a **dashboard link**
   (the `/t/CODE?key=…` URL; there is a copy button on the dashboard under the QR code). Click **Pair**.
   You can pair several presentations; the extension picks the right one by the deck being shown.
4. Open your deck in Google Slides and press **Present**. A small blue badge in the corner confirms
   each slide change ("Slide Pulse: slide 4 of 20"). A red badge means it could not reach the server
   or the slide is unknown (re-import the deck on the dashboard after editing it).

By default it only follows in Present mode; tick "Also follow while editing" in the popup if you
prefer to present from the editor view. It only runs on `docs.google.com/presentation/*` pages and
sends nothing but the slide id and your session key to your own server.

## During class

- With the Chrome extension: just present from Google Slides; phones follow. Without it: keep the
  dashboard open next to Google Slides and advance with the **→** key there (or click the thumbnails).
- Students who fall behind or want to flag an earlier slide can tap ◀ on their phone; a
  "Back to live slide" button brings them back.
- Open **Projected results** on the projector at the end (or any time) to discuss the slides that
  collected the most questions.
- Edited the deck? Click **Re-import slides** on the dashboard.

## Tests

```bash
npm test
```
