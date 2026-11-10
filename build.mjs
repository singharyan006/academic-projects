import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  external: ['three', 'three/addons/*'],
  target: 'es2020',
  outfile: 'dist/bundle.js',
  logLevel: 'warning',
});

const [template, bundle] = await Promise.all([
  readFile('src/template.html', 'utf8'),
  readFile('dist/bundle.js', 'utf8'),
]);

if (bundle.includes('</script')) {
  throw new Error('Generated bundle contains a closing script tag');
}

await writeFile('dist/index.html', template.replace('/*BUNDLE*/', bundle));
console.log(`ok ${template.length + bundle.length}`);
