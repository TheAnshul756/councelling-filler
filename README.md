# JoSAA Choice Filler

A Chrome extension that auto-fills your JoSAA counselling choices in your preferred priority order.

## Features

- **Auto-fill** — paste a list of choices (institute + program) and the extension fills them on the JoSAA portal in one click
- **Choice Ranker** — reads all available options from the JoSAA page, sorts them by closing rank, and lets you drag-and-drop to reorder before filling
- **CSV export** — download your final ranked list as a CSV
- **Auto-accept dialogs** — optionally dismiss PwD / restriction confirmation dialogs automatically
- **Clear existing choices** — optionally wipe previously filled choices before re-filling

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar

## Usage

### Ranker (recommended)

1. Navigate to the JoSAA choice-filling page
2. Click the extension icon and press **Open Ranker**
3. A new tab opens with all available choices sorted by closing rank
4. Drag rows to reorder, use the filters to narrow down options
5. Click **Fill Choices** to inject your ranked list into the portal

### Manual fill

1. Click the extension icon
2. Enter one choice per line in the format:
   ```
   IIT Bombay | Computer Science and Engineering
   IIT Delhi | Electrical Engineering
   ```
   or using codes:
   ```
   101 | 4101
   110 | 4105
   ```
3. Click **Fill Choices**

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html/js` | Extension popup UI and logic |
| `ranker.html/js` | Full-page drag-and-drop choice ranker |
| `collges.html` | College data reference page |
| `ranks.csv` | Closing rank data used by the ranker |
