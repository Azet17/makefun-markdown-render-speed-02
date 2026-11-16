// Driver: renders every case in $MAKEFUN_INPUT_DIR/cases.json with parse()
// from parse.js and writes the HTML strings, in the cases' order, to
// $MAKEFUN_OUTPUT_DIR/html.json. Each case is rendered alone, so no state
// (references, autolink suppression) leaks between cases.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const input = JSON.parse(readFileSync(inDir + '/cases.json', 'utf8'));
const out = [];
for (let i = 0; i < input.length; i++) out.push(parse(input[i].markdown));
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + '/html.json', JSON.stringify(out));
