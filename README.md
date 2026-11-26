# LuxxeTV

Windows DVR for Xtream Codes (or M3U) playlists, with a built-in **web player** you can open on a Tesla, phone or any browser.

Architecture follows the same idea as Fredolx's [open-tv](https://github.com/Fredolx/open-tv): a desktop shell around a web UI, with ffmpeg doing the stream work. Here the shell is Electron and the backend is Node.

## Features
- Xtream Codes (server/user/pass) or M3U URL; category filter, search, EPG now/next
- **TV guide** (XMLTV from your provider, ~3 days ahead): scrolling time grid; tap a program to record it once, daily or weekly, or to watch it if it is on now. Scheduled programs are highlighted. Set a custom guide URL in Settings if your provider has none.
- **Movies tab** (needs a free [TMDB](https://www.themoviedb.org/settings/api) API key, set in Settings → Movies):
  - *Coming to theaters* (major releases, next ~6 months), *In theaters*, and *Streaming soon* (digital releases from the last 30 days to the next 90)
  - Each movie shows its **theater date** and **streaming (digital) date** for your country. If the studio hasn't announced a streaming date, an estimate (~45 days after theaters) is shown and marked *est.*
  - A green *On your provider* badge when the movie is already in your Xtream VOD library
  - Search any movie to add it
- **Auto-download watchlist**: tap *＋ Download when available* and LuxxeTV checks your Xtream provider's movie library every few hours (configurable) and downloads the movie as soon as it appears, to `<Save folder>\Movies` by default. CAM/telesync copies are skipped; a 1080p copy is preferred over 4K; interrupted downloads resume. Downloaded MP4s play in the web player. Needs an Xtream Codes playlist (M3U playlists don't expose a movie library).
- **Show/hide categories** in Settings, under the playlist; applies to Live, Guide and every device
- **Record now** (until stopped / 30m–3h) or **schedule** (once, daily, weekly, with start/stop padding)
- Recordings go to a folder **you choose**, transcoded with ffmpeg to H.264/AAC MP4:
  | Preset | Resolution | Approx. size |
  |---|---|---|
  | Small | 480p | ~0.4 GB/hour |
  | Balanced (default) | 720p | ~0.9 GB/hour |
  | High | 1080p | ~2 GB/hour |
  | Original | no re-encode (.mkv) | source size |
- Fragmented MP4: playable while recording, survives crashes; auto-reconnect and resume on stream drops
- Optional GPU encoding (NVENC / QSV / AMF) auto-detected
- Web player: live TV is restreamed as H.264/AAC HLS (Tesla-compatible); recordings play with seeking
- Provider credentials stay on the PC; the web UI never sees them
- Closing the window hides to tray so scheduled recordings keep running

## Run
Needs Node 18+ and ffmpeg (auto-detected from PATH or `C:\ffmpeg\bin`; or set the path in Settings).

```bash
npm install
npm start          # desktop app
npm run serve      # headless server only
npm test           # end-to-end test against a mock provider
npm run dist       # build Windows installer + portable exe (dist/)
```
Open **Settings**, enter your playlist, pick a save folder, press *Test & reload channel list*.

## Tesla / phone
- **Home Wi-Fi:** browse to `http://<PC-IP>:8484/` (allow Node/LuxxeTV through Windows Firewall when prompted; give the PC a fixed IP/DHCP reservation).
- **Away from home:** the Tesla browser can't run a VPN, so expose the port with a tunnel, e.g. Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8484`) – **set a web password in Settings first**. Without a password the server only accepts private-network, non-proxied requests.
- Tesla only plays video while parked. Pick a lower *Live stream quality* (480p/720p) on cellular.

## Version
The app version, git commit, environment and build date are shown in **Settings → About**. `npm run dist` stamps the commit and build date into the installer.

## Notes
- Config/schedules live in `%APPDATA%\luxxetv`. Live HLS temp files are in the system temp folder and deleted 30 s after you stop watching.
- Your provider may limit simultaneous connections: recording + watching = 2 connections.
- Only record content you have the right to record.
