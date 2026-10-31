#!/usr/bin/env node
// Prove the live gateway works end to end, or point it at a real screenshot.
//
//   node scripts/live-check.mjs                         # synthetic image
//   node scripts/live-check.mjs shot.jpg "BIOL 201"     # a real quiz screen
//   node scripts/live-check.mjs shot.jpg "BIOL 201" rec.webm   # + audio

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { makeGateway } from '../src/gateway.js';

const [imagePath, courseArg, audioPath] = process.argv.slice(2);
const course = courseArg || 'Live check';

// ── a tiny PNG encoder, so the check needs no fixture files ──────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A crude "quiz page": header band, text rows, four option rows. */
function syntheticPng(w = 900, h = 560) {
  const raw = Buffer.alloc(h * (w + 1));
  const put = (x, y, v) => { raw[y * (w + 1) + 1 + x] = v; };
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter byte
    for (let x = 0; x < w; x++) put(x, y, 250);
  }
  const band = (x0, y0, x1, y1, v) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, v);
  };
  band(0, 0, w, 64, 40);            // header
  band(40, 110, 780, 126, 70);      // question line 1
  band(40, 138, 700, 154, 70);      // question line 2
  for (let i = 0; i < 4; i++) {     // four options
    const y = 210 + i * 62;
    band(40, y, 60, y + 26, 120);   // radio
    band(80, y + 4, 520, y + 20, 90);
  }
  band(40, 500, 200, 522, 30);      // submit button

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 1 second of 440Hz — enough to prove the audio path without a real recording. */
function toneWav() {
  const rate = 16000;
  const n = rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── run ──────────────────────────────────────────────────────────────────────
const cfg = loadConfig();
const gateway = makeGateway(cfg);
const line = (s) => console.log(s);
let failures = 0;
const check = (ok, label, detail = '') => {
  line(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

line(`gateway   ${cfg.gatewayUrl}`);
line(`models    reasoning=${cfg.model} vision=${cfg.visionModel} stt=${cfg.sttModel}`);
line('');

const health = await gateway.health();
check(health.ok, 'reachable', `HTTP ${health.status}`);

line('\n1. reasoning (text -> JSON)');
try {
  const { text } = await gateway.complete({
    messages: [
      { role: 'system', content: 'Return only JSON.' },
      {
        role: 'user',
        content: 'A cell has a chloroplast and a mitochondrion. Return JSON {"best_organelle": one of "chloroplast"/"mitochondrion", "reason": "one sentence"} for photosynthesis.',
      },
    ],
    maxTokens: 300,
    temperature: 0.1,
  });
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  check(/chloroplast/i.test(JSON.stringify(parsed)), 'answered correctly', text.replace(/\s+/g, ' ').slice(0, 120));
} catch (e) {
  check(false, 'reasoning call', e.message);
}

line('\n2. vision (image -> JSON)');
const img = imagePath ? readFileSync(imagePath) : syntheticPng();
const mime = imagePath
  ? (imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg')
  : 'image/png';
check(img.length > 1000, 'image available', `${img.length} bytes ${imagePath ? `from ${imagePath}` : '(synthetic)'}`);
try {
  const { text } = await gateway.vision({
    image: { b64: img.toString('base64'), mime },
    prompt:
      'Describe this screen for a student agent. Return ONLY JSON {"screen_type":"quiz|lecture|slide|reading|essay_prompt|other","topic":"...","visible_text":"...","confidence":0.0-1.0}',
    maxTokens: 500,
    temperature: 0.1,
  });
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  check(typeof parsed.screen_type === 'string', 'returned a screen_type', `${parsed.screen_type} @ ${parsed.confidence}`);
  line(`         topic: ${String(parsed.topic || '').slice(0, 110)}`);
} catch (e) {
  check(false, 'vision call', e.message);
}

if (audioPath) {
  line('\n3. transcription');
  try {
    const audio = readFileSync(audioPath);
    const { text } = await gateway.transcribe({
      audio: { b64: audio.toString('base64'), mime: audioPath.endsWith('.wav') ? 'audio/wav' : 'audio/webm' },
    });
    check(text.length > 0, 'transcribed', text.replace(/\s+/g, ' ').slice(0, 120));
  } catch (e) {
    check(false, 'transcription', e.message);
  }
} else {
  line('\n3. transcription — synthetic 1s tone');
  try {
    const wav = toneWav();
    const { text, via } = await gateway.transcribe({ audio: { b64: wav.toString('base64'), mime: 'audio/wav' } });
    check(true, 'transcription path reachable', `via ${via}${text ? `: "${text.slice(0, 60)}"` : ' (empty — correct for a tone)'}`);
  } catch (e) {
    check(false, 'transcription', e.message);
  }
}

line('');
if (failures === 0) {
  line('All live checks passed.');
  if (!imagePath) {
    line('The image was synthetic, so this proves the vision path round-trips — not that it can read a real quiz.');
    line('Run again with a real screenshot to test that:  node scripts/live-check.mjs shot.png "'+course+'"');
  }
} else {
  line(`${failures} check(s) failed.`);
  process.exit(1);
}
