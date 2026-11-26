# LuxxeTV

Windows DVR for Xtream Codes (or M3U) playlists, with a built-in **web player** you can open on a Tesla, phone or any browser.

Architecture follows the same idea as Fredolx's [open-tv](https://github.com/Fredolx/open-tv): a desktop shell around a web UI, with ffmpeg doing the stream work. Here the shell is Electron and the backend is Node.

## Features
- Xtream Codes (server/user/pass) or M3U URL; category filter, search, EPG now/next
- **Guide-first layout:** categories in a left rail (Favorites on top), the TV guide on the right with 2-3 hours of program titles per channel. Click a channel to watch; right-click (or tap / long-press) a program to record it once, daily or weekly. Scheduled programs show a red dot. Guide data is the provider's XMLTV feed (~3 days ahead); set a custom guide URL in Settings if your provider has none.
- **Favorites:** star any channel; stored on the PC, so every device sees the same list
- **Look:** Metro-style flat tiles, giant light lowercase headings, one accent color (pick it per device in Settings, plus night/day). Dim by default for a dark car cabin
- Keyboard: `/` search, `Esc` close, Up/Down change channel in the player
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
- **Movies & TV shows (Xtream VOD):** browse the provider's movie and series catalogs with search, category filter and sorting. Download a movie, a single episode, a whole season, or an entire show; files are saved as the provider sends them (unless you turn on shrinking) in your **Download folder** as `Movies/Title (Year).ext` and `TV Shows/Show/Season 01/Show - S01E02 - Title.ext` (Plex/Jellyfin friendly). Click a movie to see its info (plot, cast, director, running time, trailer link; fuller with a TMDB key) before watching or downloading it.
- **Download queue:** the Downloads tab shows progress, cancel, retry, play and delete, including watchlist downloads. The queue is saved to disk, so closing or restarting the app keeps it and interrupted transfers resume. Leftover `.part` files are listed under *unfinished downloads*, where you can resume or delete them. Free space on the download drive is shown at the top.
- **Smaller files (optional):** Settings → movies & tv shows → *Downloaded file size* → *Shrink to about 5 GB*. Each larger download is re-encoded after it arrives to an H.264/AAC MP4 (1080p at most, HDR converted to SDR, up to 3 audio tracks, text subtitles kept; picture subtitles are dropped), one at a time. The original is replaced only after the new file checks out, so the drive needs room for both while it runs. A GPU encoder (NVENC / QSV / AMF, chosen under Settings → encoding) is much faster than the CPU. Files you already have get a *shrink* button.
- **Box office sort:** movies can be sorted by how much they made in theaters (worldwide gross, from TMDB). Needs a free TMDB API key in Settings; numbers are looked up in the background and cached on disk. Movies TMDB does not know sort last.
- **Release dates** (in the movies view; needs a free [TMDB](https://www.themoviedb.org/settings/api) API key, set in Settings → movies & tv shows):
  - *Coming to theaters* (major releases, next ~6 months), *In theaters*, and *Streaming soon* (digital releases from the last 30 days to the next 90)
  - Each movie shows its **theater date** and **streaming (digital) date** for your country. If the studio hasn't announced a streaming date, an estimate (~45 days after theaters) is shown and marked *est.*
  - A green *On your provider* badge when the movie is already in your Xtream VOD library
  - Search any movie to add it
- **Auto-download watchlist**: tap *＋ Download when available* and LuxxeTV checks your Xtream provider's movie library every few hours (configurable) and downloads the movie as soon as it appears, to `<Download folder>\Movies` by default (so they also appear in the Downloads tab). CAM/telesync copies are skipped; a 1080p copy is preferred over 4K; interrupted downloads resume. Downloaded MP4s play in the web player. Needs an Xtream Codes playlist (M3U playlists don't expose a movie library).
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

### Install it as an app
The web player is a PWA: it gets its own icon, opens full screen, and shows a *Can't reach your LuxxeTV PC* page when the PC is off.
- **Android / desktop Chrome or Edge:** open it, then **Settings → install app** (or the browser menu → *Install app*).
- **iPhone / iPad:** open it in Safari, tap **Share → Add to Home Screen**. Sign in once inside the installed app.
- Browsers only allow a full install over **https** (or `localhost`). A plain `http://<PC-IP>:8484/` address gives a home-screen shortcut instead; for the real app use the https address of your tunnel (see above; set a web password first). A quick `trycloudflare.com` address changes every run, so give the tunnel a fixed hostname before installing.

## Version
The app version, git commit, environment and build date are shown in **Settings → About**. `npm run dist` stamps the commit and build date into the installer.

## Notes
- Config/schedules live in `%APPDATA%\luxxetv`. Live HLS temp files are in the system temp folder and deleted 30 s after you stop watching.
- Your provider may limit simultaneous connections: recording + watching = 2 connections.
- Only record content you have the right to record.
