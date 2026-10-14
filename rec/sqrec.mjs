// frame-exact square recorder: node sqrec.mjs <url> <outdir> <seconds> [fps]
import { chromium } from "playwright";
import fs from "fs";
const [url, out, secs, fps = 30] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1080 } });
await p.goto(url); await p.waitForFunction(() => window.REC_READY && window.REC_READY(), null, { timeout: 30000 });
const n = Math.round(secs * fps);
for (let i = 0; i < n; i++) { await p.evaluate((t) => window.REC_STEP(t), i / fps); await p.screenshot({ path: `${out}/${String(i).padStart(4, "0")}.png` }); }
console.log("frames", n); await b.close();
