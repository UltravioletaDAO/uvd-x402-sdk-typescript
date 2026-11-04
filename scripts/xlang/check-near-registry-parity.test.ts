import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'registry-parity-'));
mkdirSync(join(root, 'tests/fixtures'), { recursive: true });
const fixture = join(root, 'tests/fixtures/near-registry.json');
const bytes = readFileSync(resolve('src/providers/near/vectors/near-registry.json'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const check = () => spawnSync(process.execPath, [resolve('scripts/xlang/check-near-registry-parity.mjs')], {
  encoding: 'utf8', timeout: 10000, windowsHide: true,
  env: { ...process.env, UVD_X402_PY_ROOT: root },
});

describe('registry vector CI parity', () => {
  it('accepts exactly the same bytes from the configured Python checkout', () => {
    writeFileSync(fixture, bytes);
    const result = check();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`identical in both SDKs (${bytes.length} bytes)`);
  });
  it.each([Buffer.concat([bytes, Buffer.from(' ')]), Buffer.from(bytes.toString().replaceAll('\n', '\r\n'))])(
    'rejects byte drift even when parsed JSON is identical', (different) => {
      expect(JSON.parse(different.toString())).toEqual(JSON.parse(bytes.toString()));
      writeFileSync(fixture, different);
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('NEAR registry vectors differ');
    },
  );
  it('fails when the sibling fixture is missing', () => {
    rmSync(fixture, { force: true });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });
});
