// End-to-end browser test: real Chrome, the real built app, and a fake
// microphone that plays a WAV of piano notes (Iowa recordings, phone-room
// condition). Checks that the Mic Test page logs the right notes and that the
// trainer hears the played pair.
//
//   npm run build && npm run e2e        (needs Chrome installed + fixtures)
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { writeWav, mixInto, rng, ROOT } from '../harness/audio.ts';
import { pianoNote, iowaAvailable, voicePhrase } from '../harness/sources.ts';
import { applyCondition } from '../harness/scenarios.ts';

const CHROME = process.env.CHROME ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found; set CHROME=/path/to/chrome');

const SR = 48000;
const OUT = join(ROOT, 'test', 'out');
mkdirSync(OUT, { recursive: true });

// Fake mic content (Chrome loops it): G3 at 1.0 s, D4 at 1.8 s, then silence.
const NOTES = [55, 62];
const loopLen = 6;
const x = new Float32Array(loopLen * SR);
const src = iowaAvailable() ? 'iowa' : 'salamander';
mixInto(x, pianoNote({ source: src, midi: NOTES[0], sampleRate: SR, releaseAt: 0.85, length: 1.5 }), 1.0 * SR, 0.5);
mixInto(x, pianoNote({ source: src, midi: NOTES[1], sampleRate: SR, releaseAt: 1.5, length: 2.5 }), 1.8 * SR, 0.5);
const wav = join(OUT, 'fake-mic.wav');
writeWav(wav, applyCondition(x, SR, 'phone', 7), SR);

// Static server for dist/.
const DIST = join(ROOT, 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const f = join(DIST, p === '/' ? 'index.html' : p);
  if (!f.startsWith(DIST) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise<void>((r) => server.listen(4179, r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // --- Mic Test page
  await page.goto('http://localhost:4179/#/mic', { waitUntil: 'networkidle0' });
  await page.click('button.primary');
  await new Promise((r) => setTimeout(r, 9000));
  const log = await page.$$eval('.log li .n', (els) => els.map((e) => e.textContent ?? ''));
  console.log('Mic Test log:', log.join(' '));
  check(log.includes('G3') && log.includes('D4'), 'Mic Test logs G3 and D4 from the fake mic');
  check(log.every((n) => n === 'G3' || n === 'D4'), 'Mic Test logs no spurious notes');
  const diag = await page.$eval('.kv.small', (e) => e.textContent ?? '');
  console.log('Audio setup:', diag.replace(/\s+/g, ' '));
  await page.screenshot({ path: join(OUT, 'mictest.png'), fullPage: true });

  // --- Trainer
  await page.goto('http://localhost:4179/#/train', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: join(OUT, 'trainer-idle.png') });
  await page.click('button.primary');
  await page.waitForSelector('.result', { timeout: 25000 });
  const resultText = await page.$eval('.result', (e) => e.textContent ?? '');
  console.log('Trainer result:', resultText);
  check(/G3 → D4/.test(resultText) || /D4 → G3/.test(resultText), 'Trainer heard the G3/D4 pair');
  await page.screenshot({ path: join(OUT, 'trainer-result.png'), fullPage: true });

  // --- Stats & Settings render without errors
  await page.goto('http://localhost:4179/#/stats', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: join(OUT, 'stats.png'), fullPage: true });
  const statsText = await page.$eval('#screen', (e) => e.textContent ?? '');
  check(/1\s*attempts/.test(statsText), 'Stats shows the recorded attempt');
  await page.goto('http://localhost:4179/#/settings', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: join(OUT, 'settings.png'), fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
}

// --- Voice: a synthetic singer (A3 → E4 with scoop + vibrato) on the fake mic.
{
  const v = voicePhrase({ sampleRate: SR, seed: rng(3), vowel: 'ah', notes: [
    { midi: 57, duration: 1.0, scoopCents: -150, vibratoCents: 35, gapAfter: 0.25 },
    { midi: 64, duration: 1.1, scoopCents: -120, vibratoCents: 35 },
  ], leadIn: 1.0 });
  const y = new Float32Array(6 * SR);
  for (let i = 0; i < Math.min(y.length, v.data.length); i++) y[i] = 0.15 * v.data[i];
  const vwav = join(OUT, 'fake-mic-voice.wav');
  writeWav(vwav, applyCondition(y, SR, 'phone', 9), SR);
  const b2 = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${vwav}`] });
  try {
    const page = await b2.newPage();
    await page.goto('http://localhost:4179/#/mic', { waitUntil: 'networkidle0' });
    const [, voiceBtn] = await page.$$('.seg button');
    await voiceBtn.click();
    await page.click('button.primary');
    await new Promise((r) => setTimeout(r, 9000));
    const log = await page.$$eval('.log li .n', (els) => els.map((e) => e.textContent ?? ''));
    console.log('Mic Test (voice) log:', log.join(' '));
    check(log.includes('A3') && log.includes('E4'), 'Mic Test (voice mode) logs A3 and E4 from the synthetic singer');
    check(log.every((n) => n === 'A3' || n === 'E4'), 'Mic Test (voice mode) logs no spurious notes');
    await page.screenshot({ path: join(OUT, 'mictest-voice.png') });
  } finally {
    await b2.close();
    server.close();
  }
}
console.log(failures ? `${failures} check(s) failed` : 'all e2e checks passed');
process.exit(failures ? 1 : 0);
