# REBUILT MatchCam

FRC 2026 **REBUILT** match recorder + driver HUD, built for the **iPhone Duo**.

Put the phone on a tripod behind the driver-station glass with the rear camera on the field. One half of the unfolded screen records the whole match. The other half is a big, high-contrast HUD for the drive coach and driver: match clock, current shift, **is our HUB live or off**, and a countdown to the next change.

It's a web app (PWA): no App Store and no build step. Open the link in Safari, then **Share → Add to Home Screen**.

## What it does

**Driver HUD (second half of the screen)**
- FRC-style match clock: AUTO 0:20, then TELEOP 2:20 → 0:00, plus time left in the current period.
- Our HUB is **LIVE** (alliance color) or **OFF** (striped), with "OFF in 0:07" / "LIVE in 0:12" and a progress bar.
- The box pulses for the last 5 s before a change (the field HUB lights pulse for 3 s).
- Shift timeline (AUTO · T · S1–S4 · EG) with a playhead, plus our live windows in field-clock time, e.g. `LIVE 2:20–1:45 · 1:20–0:55 · 0:30–0:00`.
- The opponent's HUB state, a tip line ("Collect FUEL · defend", "Last shots!", climb call) and a driver note you type before the match.
- **AUTO-winner prompt** at the start of TELEOP: tap RED/BLUE, as shown by the Driver Station game data. Long-press the HUB box to undo.

**Audio cues**
- 3-2-1 beeps before every change of *our* hub, then a distinct go / off tone.
- Voice callouts: "Shift 2. Hub live. Shoot!", "Off in 5", "End game", "Climb now!", "Ten seconds".
- Plays through the silent switch (iOS 17+ audio session).

**Recording**
- Rear camera at 720p / 1080p / 4K, 30 or 60 fps, with sound. Lens switch (0.5× ultra-wide shows the whole field) and zoom.
- Starts automatically on START MATCH and keeps going 8 s after 0:00 (configurable). You can also record manually at any time.
- **Crash-safe**: video is written to storage every second. If Safari is killed mid-match, the recording is rebuilt on the next launch.
- Optional **burn-in**: the clock, shift and HUB state are drawn into the video itself, for sharing.
- Screen stays awake while recording.

**Scouting and analysis**
- Scout panel slides over the camera while recording continues. It has FUEL taps (+1/+3/+5/+10), AUTO tower L1, end-game climbs per robot, and tags (Mark, Defense, Foul, Stuck…).
- FUEL scored while our hub is OFF is flagged (0 pts).
- Live estimated score and RP progress: Energized / Supercharged / Traversal, with thresholds for Regional, DCMP or Championship.
- Post-match card: result, final score, notes, FUEL-by-period chart, % of FUEL wasted on an inactive hub.

**Library**
- Every match with its video, a thumbnail and the result.
- Playback with a **synced HUD overlay**, a shift timeline, one-tap jumps (AUTO, TELEOP, S1–S4, END GAME), tag markers, and 0.25×–2× speed.
- **Save to Photos / Share**, download, delete. Export all match data as CSV + JSON.

**Fold-aware layout**
- Unfolded, the camera | HUD split lands exactly on the hinge. Rotated, it splits top/bottom on the hinge.
- If Safari ever reports viewport segments or device posture, the split follows them exactly.
- Layout button: swap sides · HUD full screen (camera becomes a picture-in-picture) · camera full screen with a mini HUD.
- Folded (5.4" outer screen) it switches to a compact stacked layout.
- *Open driver HUD window* opens a second synced view (`?view=hud`).

**Also**
- Pre-match checklist (editable).
- Shift cheat sheet: who is live when, for both AUTO outcomes.
- Works offline after the first load.

## REBUILT timing used

| Period | Field clock | HUB status |
|---|---|---|
| AUTO | 0:20 → 0:00 | both live |
| TRANSITION | 2:20 → 2:10 | both live |
| SHIFT 1 | 2:10 → 1:45 | AUTO winner **off**, other live |
| SHIFT 2 | 1:45 → 1:20 | AUTO winner live, other **off** |
| SHIFT 3 | 1:20 → 0:55 | AUTO winner **off** |
| SHIFT 4 | 0:55 → 0:30 | AUTO winner live |
| END GAME | 0:30 → 0:00 | both live |

"AUTO winner" is the alliance that scored more FUEL in AUTO, or the FMS pick on a tie. The Driver Station gets it as game data (`R`/`B`) at the start of TELEOP.

Points: FUEL 1 (live hub only) · AUTO tower L1 15 (max 2 robots) · TELEOP L1 10 / L2 20 / L3 30.

Bonus RP thresholds (Team Update 22):

| Bonus RP | Regional / District | District Champs | Championship |
|---|---|---|---|
| Energized (FUEL) | 100 | 240 | 360 |
| Supercharged (FUEL) | 360 | 360 | 500 |
| Traversal (tower pts) | 50 | 50 | 50 |

Sources: 2026 Game Manual §6 and WPILib "2026 Game Data Details". Always defer to the latest manual and Team Updates.

## Match-day workflow

1. **Before the match:** Menu → Match setup (match #, alliance, partners, driver note). Then run the checklist and frame the field (0.5× lens).
2. Tap **START MATCH** on the AUTO start sound. If the field clock is off, use **−1s / +1s**.
3. When TELEOP starts, tap **TELEOP GO**. If you don't, it auto-advances after the configured pause. Then tap who won AUTO.
4. The driver watches the HUD and listens for the beeps.
5. After 0:00 it saves and asks for the result. Library → **Save to Photos**.

## Tips
- Install it to the Home Screen: full screen, offline, and storage that Safari won't clear.
- 1080p30 uses about 200 MB per match. Export to Photos after each event and delete from the library.
- The HUD's "both live" state shows your alliance color with a stripe of theirs on the edge.
- `?speed=8` runs a demo clock 8× faster to train the drive team on shift timing.

## Develop

Plain HTML/CSS/ES modules, no build.

```sh
python3 -m http.server 8000   # http://localhost:8000 (camera works on localhost)
npm test                      # rules engine unit tests (node --test)
```

Deploy: GitHub Pages → Deploy from a branch → `main` / root. Bump `VERSION` in `sw.js` on each release so installed copies update.
