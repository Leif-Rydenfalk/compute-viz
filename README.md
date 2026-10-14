# compute-viz

Two isometric animations of CI compute, drawn on one canvas from a JSON file. No build step, no dependencies.

- **burst**: CPU and memory per CI step (setup, compile, test, upload). When a step is resource-bound its bars turn
  orange and the runner gets more: `+1 vCPU`, `+8 GB`.
- **router**: six CI jobs routed to four sandbox providers by how fast each finishes there. Providers A and C go down,
  the routing weights move to B and D, telemetry scrolls on the right, end-to-end time falls from 27 to 15 min.

Inspired by a launch video posted by [@dbworku](https://x.com/dbworku). Original code, data and type; no assets from it.

## Run

```
python3 -m http.server 8000
open http://localhost:8000/            # both scenes, alternating
open http://localhost:8000/?scene=router
```

## Change the story

Everything on screen comes from `data.json` (or `?data=<url>`):

| key | what it drives |
|---|---|
| `burst.steps[]` | name, column range, CPU and memory need as a fraction of the base runner |
| `burst.bursts[]` | at which column the runner gets `cpu` more cores or `mem` more GB |
| `router.jobs[]`, `router.providers[].cost[]` | the per-job cost on each provider; weights are a softmax of it |
| `router.providers[].down` | `[from, to]` seconds of an outage |
| `router.telemetry[]` | strip name, unit, value range, spikes |

## Film

`?rec=burst` or `?rec=router` hides nothing but switches the clock to `window.REC_STEP(t)`, so a recorder can step
exactly 1/30 s per frame. `rec/sqrec.mjs <url> <outdir> 12 30` (Playwright) writes the PNGs; then

```
ffmpeg -framerate 30 -i out/%04d.png -c:v libx264 -crf 16 -pix_fmt yuv420p burst.mp4
```

## Licence

MIT. Fonts: Inter and IBM Plex Mono, SIL Open Font License 1.1.
