# Slide Pulse

Live, anonymous, slide-by-slide feedback for Google Slides presentations.

1. Sign in with Google and paste a link to your (private) Google Slides deck.
2. The app fetches a picture of every slide and shows you a QR code.
3. Students scan it on their phones. They see the slide you are on and three buttons:
   **This slide is great!**, **I didn't understand**, **I have a question** (with an optional typed question).
4. Your dashboard shows, live, which slides collected the most confusion and open questions
(answered questions drop out of the ranking).
   Nobody has to raise a hand.

## What's inside

| Page | URL | Who |
|---|---|---|
| Home | `/` | Everyone: "Live now" list of running presentations with Join buttons and a code box. Teacher: sign in, paste a deck link, list past presentations |
| Dashboard | `/t/CODE?key=…` | Instructors (owner or invited co-instructors): current slide, Prev/Next (also ← → keys), QR code, per-slide totals, question feed |
| Student | `/s/CODE` | Students: follows your current slide, three feedback buttons, can browse back to earlier slides |
| Projected results | `/p/CODE` | Anyone: a bar per slide, top-slide summary, optional question list for the projector |
| Phone remote | `/r/CODE?key=…` | Instructors: a clicker with Prev/Next, live counts, and thumbnails |

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
| `GOOGLE_TRANSLATE_API_KEY`, `DEEPL_API_KEY`, `ANTHROPIC_API_KEY` | One of these enables speaker-note translation (see below). |
| `TRANSLATE_PROVIDER`, `NOTES_LANGUAGE`, `CLAUDE_MODEL` | Translation tuning (see below). |

## Deploy with Docker

```bash
cp .env.example .env && $EDITOR .env
docker compose up -d --build
```

The container listens on port 3000 and keeps its data in the `slide-pulse-data` volume.
Put it behind any HTTPS reverse proxy (Caddy, nginx, Fly.io, Railway, Render, …) and set `BASE_URL` to
the public https URL. WebSockets must be passed through (`/ws`); Caddy and most platforms do this by default.

## Speaker notes in the student's language

Each slide's **speaker notes** are imported with the deck and shown on the student page under the
slide. Students tap the flag button in the header and pick their language from a sheet of flags; the buttons and labels switch
immediately, and the notes are translated on demand. A second flag button in the **Speaker notes**
panel sets the reading language for notes and teacher replies separately (it follows the app
language until a student picks one), for students who prefer English buttons but notes in their own language. Each translation is done once per slide and
language and cached, so a 40-slide deck read in Romanian costs 40 short translations, total.

Languages offered: English (original), Spanish, Chinese (Simplified), Hindi, Arabic, French,
Portuguese, Bengali, Russian, Urdu, Indonesian, German, Japanese, Romanian. Arabic and Urdu are
shown right-to-left.

Translation needs one API key. Set exactly one of these in `.env`:

| Provider | Variable | Notes |
|---|---|---|
| Google Cloud Translation | `GOOGLE_TRANSLATE_API_KEY` | In the same Google Cloud project as your OAuth client: enable **Cloud Translation API**, create an **API key** under Credentials. Google requires billing to be enabled on the project; the first 500k characters per month are free. All 14 languages. |
| DeepL | `DEEPL_API_KEY` | Free plan at deepl.com/pro-api (500k characters/month). Keys ending in `:fx` use the free endpoint automatically. No Hindi, Bengali or Urdu. |
| Claude | `ANTHROPIC_API_KEY` | Uses the Claude API (`claude-opus-5` by default; set `CLAUDE_MODEL` to change). All 14 languages, best at keeping teaching tone and technical terms. |

Without a key, notes are shown untranslated and the language menu still switches the interface.
`TRANSLATE_PROVIDER` forces a provider; `NOTES_LANGUAGE` tells the translator what language your
notes are written in (default English). In `DEMO_MODE` a fake "[Română] …" translator is used so
the flow can be tried without any key.

Notes are read once at import. If you edit them in Google Slides, click **Re-import slides**; the
cache notices the change and re-translates only the slides whose notes changed.

## Replying to questions

Every question in the dashboard feed has a **Reply** button. Type a reply (Ctrl/Cmd+Enter sends it)
and the student who asked sees it on their phone under their question, with a short buzz and a
"Your teacher replied" notice, even if they have moved to another slide. Replying also marks the
question as answered; you can edit a reply later. Nobody else sees the reply except co-instructors
and the projected results page, where it appears under the question.

With translation configured, questions typed in another language arrive translated for you, with
the original underneath, and your reply is translated back into the student's language. Each
translation is cached, so nothing is paid for twice.

## Driving log

The dashboard has a collapsible **Driving log** under the slide: every slide change with the time,
who made it, from where (dashboard, phone remote, or Google Slides via the extension), the kind of
move (next, previous, jump), and the target slide's number and Google object id, for example
`[Joe] Google Slides → Jump to slide 20 (g2e02a843a92_0_298) from slide 7`. Newest first, last 60.

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

### Letting a co-instructor drive Google Slides itself

Google Slides on the presenting laptop can only be moved by something running on that laptop, so
this needs the extension there. With it installed and paired, **Remote control** is on by default:

1. On the presenting laptop, present as usual and walk away if you need to.
2. The extension listens to the session: when anyone changes the slide from a dashboard or the
   phone remote, it moves your Google Slides with real keystrokes through Chrome's extension
   debugger channel, which reaches the tab even when the window is not focused (Google Slides
   ignores simulated key events): one arrow press for Next/Previous, otherwise the slide number
   followed by Enter (also used if the arrow press did not change the slide within 0.7 s, e.g. an
   animation build took it). If that does not take, arrow-key presses one slide at a time with the
   slide checked after each, then clicks on Google's own Previous/Next controls, and in a classic
   `/present` window finally loading the slide's URL. Measured on real Google Slides the slide
   changes about 50–100 ms after the move reaches the laptop, and quick taps on the phone are
   followed one for one (a newer tap takes over from a move still being checked). Works in Present
   mode, the in-tab slideshow and with presenter view (speaker notes) open. While you present with
   Remote control on, Chrome shows a "Slide Pulse Follower started debugging this browser" bar
   (also over a fullscreen slideshow); the extension keeps the debugger attached for the whole
   slideshow so the bar appears once at the start instead of popping in and resizing the slide on
   every remote move. That bar is Chrome's rule for the debugger channel and cannot be hidden by
   the extension. Clicking its **Cancel** stops that, and moves then show the bar briefly each time.
   To silence it permanently, start Chrome with the `--silent-debugger-extension-api` flag (add it
   to the Chrome shortcut's target on Windows). A badge says who moved it, and turns red if a move
   did not take.
   Google numbers skipped slides too, so the app records each slide's Google number at import and
   types that (re-import decks imported before this change). With presenter view open, the
   extension can also jump by clicking the slide in presenter view's own slide list.
   The extension popup has a **Diagnostics** section: open it while the presentation window is active
   to see what the extension detects, a **Test remote move** button that moves the presentation
   and reports which method worked (or why none did), **Inspect presenter view** which lists the
   controls in the presenter-view window, and **Copy logs** which puts all of that on the clipboard
   ready to paste into a bug report. Untick
   **Remote control** in the popup if you ever want your laptop to ignore other instructors.
3. The co-instructor drives from their dashboard (arrow keys) or from the **phone remote**:
   `/r/CODE?key=…`, copied with the "Copy phone remote link" button on the dashboard. It shows the
   current slide, big Prev/Next buttons, live counts for that slide, and a thumbnail strip to jump.

The presenter can still click through normally; both directions stay in sync.

## Chrome extension: phones follow Google Slides automatically

Google offers no way for a website to know which slide you are presenting, so the dashboard's
Prev/Next is the default. The `extension/` folder contains a small Chrome extension that removes
that step: while you present in Google Slides, it watches the tab's URL (which carries the current
slide's id) and tells the server. Student phones follow with no dashboard interaction.

Install once (Chrome, Edge, Brave, or any Chromium browser):

1. Download the extension from your own server at `https://YOUR-DOMAIN/extension.zip` (the file is named with its version, e.g. `slide-pulse-extension-1.3.5.zip`; linked from the
   home page and from every dashboard) and unzip it somewhere permanent. The `extension/` folder in this
   repository is the same thing.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and choose
   the unzipped folder.
3. Pin the "Slide Pulse Follower" icon, click it, and paste a **dashboard link**
   (the `/t/CODE?key=…` URL; there is a copy button on the dashboard under the QR code). Click **Pair**.
   You can pair several presentations; the extension picks the right one by the deck being shown.
4. Open your deck in Google Slides and press **Slideshow**. Both the classic `/present` window and
   the newer in-tab slideshow (the URL stays on `/edit`) are recognised. A small blue badge in the corner confirms
   each slide change ("Slide Pulse: slide 4 of 20"). A red badge means it could not reach the server
   or the slide is unknown (re-import the deck on the dashboard after editing it).

**After every update, reload the Google Slides tab.** Tabs opened before the update keep running
the old code until reloaded; the popup says so if it gets no answer from the tab.

**Updating.** An unpacked extension does not auto-update: Chrome only updates extensions installed
from the Chrome Web Store. The app helps in two ways: the dashboard header shows the version of the
extension connected from the presenting laptop and turns orange with a download link when the site
serves a newer one, and the extension popup and in-page badge say "update available" too. To update,
download the zip again, unzip it over the same folder, and click ↻ on `chrome://extensions`.

To get real auto-updates, publish the `extension/` folder to the Chrome Web Store as an **unlisted**
item (one-time developer registration fee; review usually takes a few days). Upload the same
`/extension.zip` from your site, fill in the listing (the description in `manifest.json` works;
`extension/icons/128.png` is the store icon; take one 1280×800 screenshot of the popup), and share
the store link with co-instructors. Later versions upload the same way and roll out automatically.

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
