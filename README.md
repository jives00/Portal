# Portal

A personal browser home page and security-camera viewer, served from the Synology NAS at
`http://synology:3012`. It has three tabs.

**Home**
- a fresh Unsplash photo on every load, chosen from your keywords
- the time and date
- your sites, with up/down dots and number-key shortcuts
- scores for followed teams (NFL, NBA, NCAAB, MLB)
- a stock watchlist
- weather: now, the next 12 hours, and 5 days

**Cameras** (`#cameras`)
- **Reolink cameras**, which upload their own clips and stills to the SecurityCameras share over
  FTP, each into a folder named after it (`Driveway/`, `FrontDoor/`). Portal reads them where they
  land and finds a new camera by itself once it uploads.
- **Live view** for a camera with RTSP (the Reolink doorbell): add its RTSP address in settings →
  Cameras. The battery Driveway camera has no stream without a Home Hub.
- **Daily summaries**: after midnight Portal joins each camera's clips from the day into one
  1080p H.264 video, saved in that camera's `Summary/` folder. **Yesterday** shows them.
- The Driveway's 4K HEVC clips play as-is, which works in Edge, Safari, and Chrome with hardware
  decoding; elsewhere the summary is the fallback. The doorbell's clips are H.264 and play anywhere.
- One timeline lane per camera. Drag to scrub stills, play them as a timelapse, or click an event.
  Every player has 1×/2×/4×. Keys: ←/→ (Shift for more), Space, `[`/`]` for days, `L` live, `Y`
  Yesterday, Esc back to the timeline.

**DevDash** (`#devdash`)
- Applications, Bots and Infrastructure: each one's containers, health, errors and recent logs,
  plus the nightly MySQL backup. Portal reads Docker itself through the mounted socket (read-only
  calls), so the old standalone DevDash app isn't needed. "Logs" opens a live log viewer.
- **Add**, **Edit** and **Remove** change what's tracked (saved in `data/devdash.json`; the API is
  `POST /api/devdash/services`, `PUT`/`DELETE /api/devdash/services/:name`).

**Cameras retention**
- Retention is set in settings → Cameras: clips and stills 90 days, summaries 14. It deletes files
  on the NAS only, never the camera's own storage.

Everything is edited in the page's settings drawer (`,`). Press `?` on the page for keyboard
shortcuts.

## Setup on the NAS

1. Create `/volume2/docker/portal/` with `data/` inside.
2. Copy `docker-compose.yml` into `/volume2/docker/portal/`.
3. Create `.env` next to the compose file from `.env.example`. Add a free Unsplash Access Key from
   https://unsplash.com/oauth/applications. Without one, Portal uses a small built-in photo set.
4. Run `docker compose up -d`. Watchtower picks up new images after that.
5. For each camera: in DSM, create `SecurityCameras/<Name>`. In the Reolink app, name the camera
   `<Name>` (no spaces; it becomes the filename prefix) and point FTP at the NAS (port 21,
   passive), remote directory `SecurityCameras/<Name>`, dated subfolders on, video and image.

## Development

```
pnpm install
pnpm dev        # PORT, DATA_DIR, CAMERA_ROOT, UNSPLASH_ACCESS_KEY,
                # DOCKER_SOCKET, BACKUP_STATUS_FILE (the DevDash tab; without a socket it shows "Can't read Docker")
pnpm test
```

Point `CAMERA_ROOT` at a **copy** of some footage, not the real share: retention runs at startup
and deletes old files under it.
