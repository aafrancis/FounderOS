#!/usr/bin/env node
/**
 * Make the arming secret hash for the approval queue (SH-0271).
 *
 *   node scripts/hash-arm-secret.mjs
 *
 * Type the secret when asked (it is not echoed and not stored anywhere), then put
 * the printed line in the instance's local env file. It must differ from the login
 * password: the server refuses an arming secret that equals it. Same scrypt
 * format as lib/auth.ts, so the server verifies it with the same code.
 */
import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY) {
  console.error('Run this in a terminal: the secret is typed, never piped or passed as an argument.');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = (c) => {
      for (const ch of c) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u007f') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const a = await ask('Arming secret (12+ characters): ');
const b = await ask('Again: ');
if (a !== b) {
  console.error('They differ. Nothing written.');
  process.exit(1);
}
if (a.length < 12) {
  console.error('Too short. Use 12 or more characters.');
  process.exit(1);
}
const N = 16384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const key = scryptSync(a, salt, 32, { N, r, p });
console.log(`GLADOS_ARM_HASH=${['scrypt', N, r, p, salt.toString('hex'), key.toString('hex')].join(':')}`);
