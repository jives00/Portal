# Portal

A personal browser home page served from the Synology NAS at `http://synology:3012`. It shows:

- a fresh Unsplash photo on every load, chosen from your keywords
- the time and today's forecast
- your sites, with up/down dots and number-key shortcuts
- scores for followed teams (NFL, NBA, NCAAB, MLB)
- a stock watchlist
- yesterday's security camera daily summary

Everything is edited in the page's settings drawer (`,`). Press `?` on the page for keyboard
shortcuts.

## Setup on the NAS

1. Create `/volume2/docker/portal/` and copy `docker-compose.yml` into it.
2. Create `.env` next to it from `.env.example`. Add a free Unsplash Access Key from
   https://unsplash.com/oauth/applications. Without one, Portal uses a small built-in photo
   set.
3. Run `docker compose up -d`. Watchtower picks up new images after that.

## Development

```
pnpm install
pnpm dev        # PORT, DATA_DIR, CAMERA_ROOT, UNSPLASH_ACCESS_KEY are read from the environment
pnpm test
```
