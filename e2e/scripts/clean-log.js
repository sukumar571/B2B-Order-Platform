'use strict';
/* dev-only helper: normalize a mixed UTF-16/ANSI PowerShell capture log into
 * clean printable ASCII text for the evidence folder. Not part of any test suite. */
const fs = require('node:fs');
const [, , src, dest] = process.argv;
let raw = fs.readFileSync(src, 'latin1');
raw = raw
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // ANSI SGR/CSI sequences
  .replace(/\x00/g, '') // UTF-16 null bytes for ASCII chars
  .replace(/[\x80-\xFF]+/g, ' ') // mangled multibyte reporter symbols
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n');
fs.writeFileSync(dest, raw, 'utf8');
console.log(`cleaned ${src} -> ${dest} (${raw.length} chars)`);
