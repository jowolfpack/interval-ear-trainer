import { defineConfig, type Plugin } from 'vite';
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Generates dist/sw.js with a precache list of every built file (app shell,
// samples, icons), so the app works fully offline after the first visit.
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precache-sw',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split(sep).join('/'));
        }
      };
      walk(outDir);
      const list = files.filter((f) => f !== 'sw.js').sort();
      const hash = createHash('sha256');
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const tpl = readFileSync('src/sw-template.js', 'utf8');
      writeFileSync(join(outDir, 'sw.js'), tpl.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(['./', ...list.map((f) => './' + f)], null, 0)));
    },
  };
}

// Relative base: works on GitHub Pages (/<repo>/) and any other static host.
export default defineConfig({
  base: './',
  build: { target: 'es2020' },
  plugins: [serviceWorker()],
});
