---
name: LuxxeTV
description: A household DVR and TV guide in the Metro typographic-tile tradition: flat tiles, giant light headings cropped at the edge, one accent that owns every live state.
colors:
  ground-night: "#000000"
  ground-day: "#ffffff"
  tile-night: "#1a1a1a"
  tile-hi-night: "#272727"
  tile-day: "#ececec"
  tile-hi-day: "#dcdcdc"
  ink-night: "#ececec"
  ink-2-night: "#a3a3a3"
  ink-day: "#111111"
  ink-2-day: "#555555"
  accent-teal: "oklch(0.52 0.11 215)"
  accent-blue: "oklch(0.52 0.13 255)"
  accent-green: "oklch(0.5 0.11 150)"
  accent-magenta: "oklch(0.5 0.16 335)"
  accent-orange: "oklch(0.5 0.12 52)"
  record-red: "oklch(0.58 0.19 27)"
typography:
  display:
    fontFamily: "Segoe UI Light, Segoe UI Variable Display, Segoe UI, Selawik, system-ui, sans-serif"
    fontSize: "clamp(3rem, 7.5vw, 5.75rem)"
    fontWeight: 200
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Segoe UI Light, Segoe UI, Selawik, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 300
    lineHeight: 1.15
  body:
    fontFamily: "Segoe UI, Segoe UI Variable Text, Selawik, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Segoe UI, Selawik, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
rounded:
  none: "0"
spacing:
  gap: "2px"
  pad: "clamp(16px, 2.2vw, 32px)"
components:
  category-tile:
    backgroundColor: "{colors.tile-night}"
    textColor: "{colors.ink-night}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
    height: "48px"
  category-tile-selected:
    backgroundColor: "{colors.accent-teal}"
    textColor: "#ffffff"
  program-tile:
    backgroundColor: "{colors.tile-night}"
    textColor: "{colors.ink-night}"
    rounded: "{rounded.none}"
    padding: "6px 10px 10px"
  program-tile-now:
    backgroundColor: "{colors.accent-teal}"
    textColor: "#ffffff"
  button-record:
    backgroundColor: "{colors.record-red}"
    textColor: "#ffffff"
    rounded: "{rounded.none}"
    padding: "10px 18px"
---

# Design System: LuxxeTV

## Overview

**Creative North Star: "The Panorama"**

The interface is a Metro-style panorama: content is typography and flat color, with chrome deleted. Headings are giant light-weight words that bleed off the right edge of their pane; they promise more beyond the viewport. Tiles (categories, channels, programs, actions) are flat rectangles with no borders, shadows or gradients and a 2px gap between them. One accent color owns every live state: the selected category, the program on now, focus. Recording has its own red and nothing else uses it.

Operating scene: a dim, parked-car cabin at night, plus a lit desk by day. Night is primary: true-black ground, low-luminance gray tiles, a deliberately subdued accent (no neon, no glow, no bright flashes). Day mode (automatic via the OS/car setting, or chosen in Settings) inverts to a white ground with the same grammar.

**Key Characteristics:**
- Flat tiles on a pure ground; no borders, shadows, gradients or glass.
- Display type is Segoe UI Light at poster scale. App-authored words are lowercase; provider data (category, channel, program names) keeps its own case.
- The accent floods whole tiles; it is never a thin decorative line (the thin progress bar on an on-now tile is the one data-bearing exception).
- Press feedback tilts the tile toward the pointer (up to 8deg); entrances glide in from the right with stagger; reduced motion disables both.
- Touch sizing applies when the device reports coarse pointer or no hover (Tesla): rows 88px, controls 52px.

## Colors

Restrained strategy: neutral tiles plus one accent, chosen per device (stored in the browser, default teal).

### Primary
- **Dim Teal** (oklch(0.52 0.11 215)): selected category, the program on now, primary buttons, focus ring. Alternates (blue, green, magenta, orange) sit at L 0.50-0.52 so white text clears 4.5:1.

### Secondary
- **Record Red** (oklch(0.58 0.19 27)): the recording badge, scheduled-program dot, record buttons, live recording items. Never decorative.

### Neutral
- **Night ground / tiles** (#000, #1a1a1a, hover #272727) and **day ground / tiles** (#fff, #ececec, hover #dcdcdc).
- **Ink** (#ececec night, #111 day) for primary text; **Ink-2** (#a3a3a3 night, #555 day) for timestamps, counts and metadata.

### Named Rules
**The One Voice Rule.** One accent hue is active at a time; red is reserved for recording.
**The Dim Cabin Rule.** No large saturated fills brighter than L 0.52 at night.

## Typography

**Display Font:** Segoe UI Light (with Segoe UI Variable Display, Segoe UI, Selawik, system sans).
**Body Font:** Segoe UI (with Segoe UI Variable Text, Selawik, system sans). Segoe is Windows-native; on the Tesla the system sans stands in at the same weights.

### Hierarchy
- **Display** (200, clamp(3rem, 7.5vw, 5.75rem), 1.02): category title in the guide pane and page titles; never wraps, cropped at the pane edge.
- **Pivot** (200, clamp(1.5rem, 3vw, 2.25rem)): section switcher at top (guide, recordings, schedule, settings); active is full ink, inactive is ink-2.
- **Title** (300, 1.5rem): panel headings, action sheet heading (1.25rem).
- **Body** (400, 1rem): channel names (1.0625rem), program titles (1rem, two-line clamp), descriptions.
- **Label** (400, 0.8125rem): times, counts, form labels.

## Layout

A left rail (272px; 220px under 1100px) of category tiles with Favorites first, beside the guide pane. The pane holds the display title, a tools row (search, earlier/now/later, day, guide-data filter), and a scroll area whose first child is a sticky time ruler. Channel tiles are 232px (196px, 96px on phones) and program tiles follow on a track whose width sets the window: 3 hours when the track is at least 640px, otherwise 2. Rows are 76px (88px on touch). Under 760px the rail becomes a horizontal strip with the selected category scrolled into view. Other views (recordings, schedule, settings) are single-column pages with 880px content.

## Elevation & Depth

No shadows. Depth is tonal (ground, tile, hover tile) and kinetic (tilt on press). Overlays (action sheet, player) are opaque panels on the ground; the action sheet is a bottom sheet on touch.

## Shapes

Square corners everywhere (0 radius). The only round form is the 9-10px record dot.

## Components

### Category tile
Full-width tile, 48px high (56px touch), name left, count right. Selected floods with the accent. Favorites is first and slightly heavier.

### Program tile
Absolutely positioned on the track by start and duration; title two-line clamp, start time shown when the tile is at least 110px wide. On now: accent flood with a thin progress bar. Scheduled: red dot before the title. Click, right-click and long-press all open the action sheet.

### Channel tile
Star toggle, logo, name. Click opens the player. The star is a separate target (44px, 52px touch).

### Action sheet
Opaque stack of flat tiles near the pointer (bottom sheet on touch): heading with time and description, then watch now (when airing), record, record every day, record every week, or cancel.

### Player (stage)
Full-screen panel: back tile, giant channel title, video, now/next tiles from the XMLTV guide, then favorite, length select, record, previous and next.

### Inputs and buttons
Inputs: 2px ink-2 outline, transparent, accent outline on focus. Buttons: flat tile color, hover one step lighter; solid (accent) and record (red) variants. Swatches and segmented controls for per-device accent and appearance.

## Do's and Don'ts

### Do:
- **Do** keep tiles flat with a 2px gap; let selection flood the whole tile with the accent.
- **Do** keep click, right-click and long-press on a program equivalent.
- **Do** switch focus outlines to ink on accent-flooded tiles.
- **Do** keep provider data in its own case.

### Don't:
- **Don't** add borders, drop shadows, gradients, glass or glow.
- **Don't** use neon or high-chroma fills at night.
- **Don't** make desktop slower: no extra clicks versus the previous flow; `/` search and Esc stay.
