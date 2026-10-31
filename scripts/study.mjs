#!/usr/bin/env node
// Build a study pack from a course's memory and write it to data/study/<course>.md
//
//   node scripts/study.mjs "BIOL 201 Cell Biology"

import { loadConfig, ensureDirs } from '../src/config.js';
import { openStore } from '../src/store.js';
import { makeGateway } from '../src/gateway.js';
import { makeStudy } from '../src/study.js';
import { makePersonaSource } from '../src/persona.js';

const course = process.argv.slice(2).join(' ').trim();
if (!course) {
  console.error('usage: node scripts/study.mjs "<course name>"');
  process.exit(2);
}

const cfg = loadConfig();
ensureDirs(cfg);
const store = openStore(cfg.dbPath);
const gateway = makeGateway(cfg);
const study = makeStudy({ cfg, store, gateway, personaSource: makePersonaSource(cfg.personaPath) });

const pack = await study.build({ course });
const file = study.writeToDataDir(pack);
store.close();

console.log(pack.markdown);
console.log(`\n→ ${file}`);
console.log(`  ${pack.flashcards.length} flashcards, ${pack.key_terms.length} key terms, ${pack.likely_exam.length} exam questions`);
if (pack.degraded) console.warn('  (exported without a model — summary and exam questions are missing)');
