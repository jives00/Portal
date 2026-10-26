# Portal

A personal browser home page and security-camera viewer, served from the Synology NAS at
`http://synology:3012`. It has two tabs.

**Home**
- a fresh Unsplash photo on every load, chosen from your keywords
- the time and date
- your sites, with up/down dots and number-key shortcuts
- scores for followed teams (NFL, NBA, NCAAB, MLB)
- a stock watchlist
- weather: now, the next 12 hours, and 5 days

**Cameras** (`#cameras`)
- **Ring doorbell**, through [ring-mqtt](https://github.com/tsightler/ring-mqtt) without a
  Ring Protect subscription. Portal records 60 s from each motion event or doorbell press
  (changeable), saves Ring's interval snapshots, and offers live view. Ring sends no motion events
  while live view is open, so nothing records until you close it.
- **Reolink**, which uploads its own clips and stills to the share over SFTP. Portal reads them
  where they land. Its 4K HEVC clips play as-is, which works in Edge, Safari, and Chrome with
  hardware decoding. There's no Reolink live view: battery models without a Home Hub don't offer
  a stream.
- **Yesterday**: the DSM task's daily summary, converted to H.264.
- One timeline lane per camera. Drag to scrub stills, play them as a timelapse, or click an event.
  Every player has 1×/2×/4×. Keys: ←/→ (Shift for more), Space, `[`/`]` for days, `L` live, `Y`
  Yesterday, Esc back to the timeline.
- Retention is set in settings → Cameras: Ring snapshots 30 days and clips 90; Reolink clips and
  stills 90; summaries 14. It deletes files on the NAS only, never the camera's own storage.

Everything is edited in the page's settings drawer (`,`). Press `?` on the page for keyboard
shortcuts.

## Setup on the NAS

1. Create `/volume2/docker/portal/` with `data/`, `mosquitto/` and `ring-mqtt/` inside, plus
   `/volume2/SecurityCameras/Sentry/` (where Ring footage goes; the name is historical).
2. Copy `docker-compose.yml` into `/volume2/docker/portal/`, `nas/mosquitto/mosquitto.conf`
   into `mosquitto/`, and `nas/ring-mqtt/config.json` into `ring-mqtt/`.
3. Create `.env` next to the compose file from `.env.example`. Add a free Unsplash Access Key from
   https://unsplash.com/oauth/applications. Without one, Portal uses a small built-in photo set.
4. Run `docker compose up -d`. Watchtower picks up new images after that.
5. Open `http://synology:55123` and sign in to Ring (email, password, 2FA code). ring-mqtt saves
   a refresh token to `ring-mqtt/ring-state.json` and renews it from then on. That file grants
   full access to the Ring account. In the Ring app, check that end-to-end encryption is **off**;
   with it on, ring-mqtt can't stream.

## Development

```
pnpm install
pnpm dev        # PORT, DATA_DIR, CAMERA_ROOT, FOOTAGE_ROOT, MQTT_URL, RTSP_BASE, UNSPLASH_ACCESS_KEY
pnpm test
```

Point `CAMERA_ROOT` at a **copy** of some footage, not the real share: retention runs at startup
and deletes old files under it.
