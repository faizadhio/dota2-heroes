# Dota 2 Heroes

Every Dota 2 hero with win rate, pick rate and an S to D meta tier for the chosen rank bracket, plus the most bought items per game phase, a core build and matchups for each hero.

Live site: https://faizadhio.github.io/dota2-heroes/

Built with the OpenDota API. A static site (`index.html`, `style.css`, `app.js`) with no build step. Fonts (Unbounded and Chakra Petch) are self-hosted in `fonts/`. Animation uses GSAP (ScrollTrigger, SplitText, Flip) and Lenis smooth scrolling, vendored in `vendor/`. Data comes live from the free [OpenDota API](https://docs.opendota.com/) and is cached in the browser for a day to stay under its 60 requests per minute limit.

A GitHub Action (`.github/workflows/snapshot.yml`) runs `scripts/snapshot.mjs` every day and commits a snapshot of that data to `data/`. The site reads the snapshot when it is less than three days old and falls back to the live API otherwise. Run the workflow by hand from the Actions tab to refresh it right away.

A second workflow (`.github/workflows/highlights.yml`) runs `scripts/highlights.mjs` every six hours. It collects the latest highlight videos from the PGL, ESL, BLAST and Dota 2 YouTube channels into `data/highlights.json`, and the Highlights page (`#/highlights`) embeds them from YouTube; nothing is downloaded or re-hosted. It reads the public channel feeds and pages; adding a `YOUTUBE_API_KEY` repository secret (a free YouTube Data API key) makes it use the official API instead. Edit `CHANNELS` in that script to change the sources.

`sw.js` is a service worker: fonts and libraries are served from cache, pages and data go to the network first and fall back to the cache when offline. Phones and data-saver connections get still hero renders instead of the videos.

## Preview locally

Run `python3 -m http.server` and visit http://localhost:8000.

## Publish with GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.
