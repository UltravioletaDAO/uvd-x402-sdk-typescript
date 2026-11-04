/** Fail closed unless the registry fixture is the same bytes in both SDKs. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pythonRoot = resolve(process.env.UVD_X402_PY_ROOT ?? join(repo, '..', 'uvd-x402-sdk-python'));
const ts = readFileSync(join(repo, 'src/providers/near/vectors/near-registry.json'));
const py = readFileSync(join(pythonRoot, 'tests/fixtures/near-registry.json'));
if (!ts.equals(py)) throw new Error('NEAR registry vectors differ between TypeScript and Python');
console.log(`NEAR registry vectors: identical in both SDKs (${ts.length} bytes)`);
