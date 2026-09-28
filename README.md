# Dota 2 Heroes

Every Dota 2 hero with win rate, pick rate and an S to D meta tier for the chosen rank bracket, plus the most bought items per game phase, a core build and matchups for each hero.

Live site: https://faizadhio.github.io/dota2-heroes/

Built with the OpenDota API. A static site (`index.html`, `style.css`, `app.js`) with no build step. Data comes live from the free [OpenDota API](https://docs.opendota.com/) and is cached in the browser for a day to stay under its 60 requests per minute limit.

## Preview locally

Run `python3 -m http.server` and visit http://localhost:8000.

## Publish with GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.
