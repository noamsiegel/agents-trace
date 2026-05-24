import { test, expect } from 'bun:test';
import pkg from '../package.json';
import { readFileSync } from 'fs';
import { join } from 'path';

test('cli.ts VERSION matches package.json version', () => {
  const cli = readFileSync(join(import.meta.dir, '../cli.ts'), 'utf8');
  const m = cli.match(/const VERSION = '([^']+)'/);
  expect(m).toBeTruthy();
  expect(m![1]).toBe(pkg.version);
});
