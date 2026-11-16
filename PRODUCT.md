# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
A household shares one LuxxeTV install running on a Windows PC. The owner sets it up and manages recordings at the desk (Electron window, mouse and keyboard). Household members watch live TV, browse the guide and play recordings from other screens: a parked Tesla (touchscreen Chromium browser, usually evenings), phones, tablets.

## Product Purpose
Turn an IPTV (Xtream Codes / M3U) subscription into a personal DVR and a browser-playable TV service: browse channels by category, see what is on, watch live, record shows now or in the future, and play recordings back on any screen. Success: finding a channel and starting playback or a recording takes a few taps, from a car seat or a desk.

## Positioning
Not a streaming-service clone: it is the household's own DVR. Recording, the guide and playback are one surface, and credentials and transcoding stay on the owner's PC.

## Operating Context
- Categories (hundreds, user-curated: some hidden), channels (thousands), EPG ~3 days ahead.
- Live TV is restreamed as H.264/AAC HLS; recordings are MP4 files on the PC.
- Tesla: touch only, parked, glanceable, often dark cabin at night. Desktop: right-click and mouse expected to stay fast.

## Capabilities and Constraints
- Left sidebar of categories with a Favorites category on top; right pane shows the guide for the selected category (2-3 hours of program titles per channel).
- Click a channel to open the player; right-click a program to record it (long-press on touch).
- Favorites: star channels; stored on the PC so all devices share them.
- Existing: schedule once/daily/weekly, recordings list, settings (playlist, categories show/hide, quality, web password).
- No frameworks or build step: plain HTML/CSS/JS served by the Node server; hls.js is the only client library.

## Product Principles
1. Glance first: the guide answers "what is on" without a tap.
2. One gesture to watch, one gesture to record; both reachable by mouse and touch.
3. Desktop speed is not traded for touch size.
4. Quiet at night: a dim cabin is a primary viewing scene, not an edge case.

## Accessibility & Inclusion
Large touch targets on coarse pointers; do not rely on right-click alone (long-press / visible Record action); respect reduced motion; readable contrast without glare.
