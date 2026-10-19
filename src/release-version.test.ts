import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A release PR writes the version in four places: package.json, the two `version` fields of
// package-lock.json (the root and packages[""]) and the first version section of CHANGELOG.md,
// right under [Unreleased]. publish.yml checks only that its input is package.json's version, and
// `npm ci` does not read the lock's own version, so nothing failed when one was left behind: the
// lock said 2.48.0 from 2.48.0 until 919d580 (2.91.0), while package.json went on to 2.90.0.
const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');
const { version } = JSON.parse(read('package.json')) as { version: string };

describe('the release version is the same in package.json, package-lock.json and CHANGELOG.md', () => {
  it('package-lock.json names the version of package.json, at the root and in packages[""]', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
  });

  it("CHANGELOG.md's first section is [Unreleased] and the next is package.json's version", () => {
    const sections = read('CHANGELOG.md')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('## '));
    expect(sections[0]).toBe('## [Unreleased]');
    const heading = `## [${version}] - `;
    expect(sections[1]?.startsWith(heading), `"${sections[1]}" does not start with "${heading}"`).toBe(true);
  });
});
