# HandForge cloud bot

Browser-free Socket.IO client for HandForge Poker, built so gameplay content
can be produced from a Bash-only cloud sandbox (no chrome-devtools / no
browser). Validated locally against the live server at handforge.onrender.com.

## Pipeline

1. `run-session.js` — logs into 2+ bot accounts, creates/joins a room, plays
   a tournament with heuristic (real outs/pot-odds based, not scripted)
   decisions from `bot-brain.js`, writes `transcript-<ts>.json`.
2. `pick-hand.js` — scores every completed hand in the transcript (pot size,
   rare combo, betting action) and picks the most content-worthy one.
3. `music-synth.js` — synthesizes a short original background track via
   ffmpeg lavfi sine oscillators (randomized key/tempo/pattern every call —
   never reused between videos, no copyrighted audio).
4. `render-reel.js` — pure-ffmpeg vertical (1080x1920) Reels edit: hook line,
   street-by-street card reveal, showdown with both hands + winner, CTA.
   No headless browser/Chrome dependency — cards are drawn as labeled boxes
   (rank + suit-letter, e.g. "Kh", "10d"), not screenshots.
5. `produce-reel.js` — orchestrates 1-4 end to end. Publishing to Instagram
   is NOT part of this script — that needs the Windsor.ai MCP connector,
   which is only available to the calling agent/routine, not a plain Node
   script. The routine should call `create_video_post` itself after this
   script produces the .mp4.

## Requirements

- Node 18+, `npm install` in this folder (socket.io-client, node-fetch).
- `ffmpeg` on PATH (or set `HF_FFMPEG=/path/to/ffmpeg`). On a fresh Debian/
  Ubuntu cloud sandbox: `apt-get update && apt-get install -y ffmpeg fonts-dejavu-core`.
- Fonts: uses fontconfig names (`DejaVu Sans` / `DejaVu Sans:style=Bold`) by
  default — no bundled font files, works on any Linux box with
  `fonts-dejavu-core` installed. Override with `HF_FONT_BOLD` / `HF_FONT_REGULAR`
  (accepts either a fontconfig name or a direct file path).

## Running

```bash
node produce-reel.js session-config.json ./out
```

`session-config.json` (NOT committed — contains bot credentials):

```json
{
  "accounts": [
    { "username": "handforge_bot1", "password": "..." },
    { "username": "handforge_bot2", "password": "..." }
  ],
  "mode": "pro",
  "maxPlayers": 2,
  "ante": 20,
  "startingStack": 2000,
  "handsToPlay": 1,
  "roomName": "HandForge Pro auto"
}
```

For `race` mode use `"mode": "race"` with 3-4 accounts and no ante/pick
mechanics differences beyond what the server already enforces.

Output: `out/reel-<mode>-<timestamp>.mp4` + a `.json` sidecar with the raw
hand data (board, hole cards, actions, result) for caption writing.
