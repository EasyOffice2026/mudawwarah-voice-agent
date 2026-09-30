// Syntax-checks every source and test file with `node --check`; works in any shell (the old
// `for f in …` one-liner only ran under POSIX shells, so `npm run lint` failed on Windows).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let failed = 0;
for (const dir of ['src', 'test', 'scripts']) {
  for (const file of readdirSync(dir).filter((f) => /\.m?js$/.test(f))) {
    try {
      execFileSync(process.execPath, ['--check', join(dir, file)], { stdio: 'inherit' });
    } catch {
      failed += 1;
    }
  }
}
if (failed) {
  console.error(`${failed} file(s) failed the syntax check`);
  process.exit(1);
}
console.log('Syntax OK');
