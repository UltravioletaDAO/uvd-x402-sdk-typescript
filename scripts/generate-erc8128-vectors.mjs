#!/usr/bin/env node
/**
 * Inline the ERC-8128 conformance vectors into a TypeScript module.
 *
 * WHY A GENERATED MODULE AND NOT A RUNTIME FILE READ: the package is dual
 * CJS+ESM (tsup `format: ['cjs','esm']`, no `"type": "module"`). A runtime file
 * read cannot be written once — `__dirname` does not exist in the `.mjs` chunk
 * and `import.meta.url` is a syntax error in the `.js` one. Only build-time
 * inlining works in both, and the vectors have to survive `npm pack` for
 * `runConformance()` to mean anything in a consumer's CI.
 *
 * The JSON text is embedded VERBATIM (as a string literal) rather than as a
 * parsed object, so `sha256(embedded text) === CONFORMANCE_SHA256[gen]` is a
 * real tripwire: hand-editing either copy fails the suite before a single
 * signature is produced.
 *
 * The source files are LF-only artefacts (pinned in .gitattributes in all three
 * repos that ship them). This script REQUIRES that and refuses to run on a CRLF
 * copy, so `sha256(file on disk)` and `sha256(what the package ships)` are the
 * same number — and the same number the Python package computes.
 *
 * Usage:  node scripts/generate-erc8128-vectors.mjs [--check]
 *   --check  regenerate into memory and diff against the committed module
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'erc8128');
const OUT_PATH = join(SRC, 'vectors.generated.ts');

/**
 * Read a vector file as BYTES and require it to be LF already.
 *
 * It used to normalise silently. That hid the actual problem: the TypeScript
 * working copy was CRLF on disk while the embedded string (and therefore
 * CONFORMANCE_SHA256) was LF, so `sha256(file on disk)` and `sha256(what we
 * ship)` were different numbers and no check anywhere noticed. The files are
 * pinned to `text eol=lf` in .gitattributes in all three repos; if one arrives
 * with CRLF anyway, say so instead of papering over it.
 */
function readLf(name) {
  const bytes = readFileSync(join(SRC, name));
  if (bytes.includes(0x0d)) {
    console.error(
      `${name} contains CR. These vectors are LF-only artefacts shared byte for ` +
        'byte with uvd-x402-sdk-python and execution-market/shared/test-vectors.\n' +
        'Fix: convert it to LF (git add --renormalize, or dos2unix) and re-run.'
    );
    process.exit(1);
  }
  return bytes.toString('utf8');
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

const f3_1 = readLf('erc8128.f3-1.json');
const f3_3 = readLf('erc8128.f3-3.json');

const generated = `/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Source:      src/erc8128/erc8128.f3-1.json (byte-identical copy of
 *              execution-market/shared/test-vectors/erc8128.json)
 *              src/erc8128/erc8128.f3-3.json (additive, derived by
 *              scripts/derive-erc8128-f3-3.mjs)
 * Regenerate:  npm run vectors:gen
 * Verify:      npm run vectors:check   (fails when this file is stale)
 *
 * The JSON is embedded verbatim so the hashes below cover the exact bytes the
 * package ships, in both the CJS and the ESM chunk.
 */

/* eslint-disable */

/** Raw F3-1 vector document (LF-normalised). */
export const F3_1_VECTORS_JSON: string = ${JSON.stringify(f3_1)};

/** Raw F3-3 vector document (LF-normalised). */
export const F3_3_VECTORS_JSON: string = ${JSON.stringify(f3_3)};

/**
 * sha256 of the embedded documents. Pinned; both SDKs must report the same map,
 * KEY FOR KEY. The keys are the generation ids as spelled everywhere else —
 * the file names (\`erc8128.f3-1.json\`), Python's \`_RESOURCES\`, the documents'
 * own \`generation\` field. A JS-flavoured \`f3_1\` here made the spec's
 * cross-language hash-equality check impossible to pass as written.
 */
export const CONFORMANCE_SHA256 = {
  'f3-1': '${sha256Hex(f3_1)}',
  'f3-3': '${sha256Hex(f3_3)}',
} as const;
`;

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(OUT_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error('vectors.generated.ts is missing — run: npm run vectors:gen');
    process.exit(1);
  }
  if (current !== generated) {
    console.error('vectors.generated.ts is stale — run: npm run vectors:gen');
    process.exit(1);
  }
  console.log('vectors.generated.ts is up to date');
} else {
  writeFileSync(OUT_PATH, generated, 'utf8');
  console.log(
    `wrote ${OUT_PATH} (f3-1 ${sha256Hex(f3_1).slice(0, 12)}…, f3-3 ${sha256Hex(f3_3).slice(0, 12)}…)`
  );
}
