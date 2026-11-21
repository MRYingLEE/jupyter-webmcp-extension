/**
 * Builds the extension into `dist/` (or `dist-e2e/` with `--e2e`).
 *
 * The runtime must be built first (`npm run build:runtime`): its
 * `labextension/` output is copied to `runtime/` in the extension, and its
 * remoteEntry file name is injected into the MAIN-world hook.
 *
 * The catalog builds (`runtime/catalog/`) must exist too; run
 * `npm run build:catalog` once, with `ANYWIDGET_SOURCE` set, before building.
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const out = join(root, e2e ? 'dist-e2e' : 'dist');
const labextension = join(root, 'runtime', 'labextension');

if (!existsSync(join(labextension, 'package.json'))) {
  throw new Error('runtime/labextension is missing; run `npm run build:runtime` first.');
}

const runtimePackage = JSON.parse(readFileSync(join(labextension, 'package.json'), 'utf8'));
const entryLoad = runtimePackage.jupyterlab?._build?.load;
if (typeof entryLoad !== 'string') {
  throw new Error('runtime/labextension/package.json has no jupyterlab._build.load entry.');
}

// The catalog is built separately (`npm run build:catalog`) because it needs a
// local anywidget checkout and network access. Only its built output is read here.
const catalogRoot = join(root, 'runtime', 'catalog');
const pins = JSON.parse(readFileSync(join(root, 'scripts', 'catalog-pins.json'), 'utf8'));
const catalogBuilds = {};
for (const { id } of pins.entries) {
  const packagePath = join(catalogRoot, id, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`runtime/catalog/${id} is missing; run \`npm run build:catalog\` first.`);
  }
  const build = JSON.parse(readFileSync(packagePath, 'utf8')).jupyterlab?._build;
  if (typeof build?.load !== 'string' || typeof build?.extension !== 'string') {
    throw new Error(`runtime/catalog/${id}/package.json has no jupyterlab._build entry.`);
  }
  catalogBuilds[id] = { load: build.load, extension: build.extension };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'chrome120',
  logLevel: 'warning'
};

await build({
  ...shared,
  entryPoints: [join(root, 'src/background/service-worker.ts')],
  outfile: join(out, 'background.js'),
  format: 'esm'
});

await build({
  ...shared,
  entryPoints: [join(root, 'src/content/main.ts')],
  outfile: join(out, 'content-main.js'),
  format: 'iife',
  define: {
    __RUNTIME_LOAD__: JSON.stringify(entryLoad),
    __CATALOG_BUILDS__: JSON.stringify(catalogBuilds)
  }
});

await build({
  ...shared,
  entryPoints: [join(root, 'src/content/bridge-isolated.ts')],
  outfile: join(out, 'content-bridge.js'),
  format: 'iife'
});

for (const page of ['popup', 'options']) {
  await build({
    ...shared,
    entryPoints: [join(root, 'src', page, `${page}.ts`)],
    outfile: join(out, `${page}.js`),
    format: 'iife'
  });
}

for (const file of ['popup/popup.html', 'popup/ui.css', 'options/options.html']) {
  cpSync(join(root, 'src', file), join(out, file.split('/').pop()));
}
cpSync(join(root, 'icons'), join(out, 'icons'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (e2e) {
  // Optional host permissions cannot be granted without a user gesture, so the
  // e2e build grants the same host patterns up front. Match patterns cannot
  // wildcard ports, so the patterns are not limited to localhost. The
  // production manifest is not changed.
  delete manifest.optional_host_permissions;
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

cpSync(join(labextension, 'static'), join(out, 'runtime', 'static'), { recursive: true });
cpSync(join(labextension, 'package.json'), join(out, 'runtime', 'package.json'));

// Catalog artifacts keep their own LICENSE files, copied with each directory.
for (const id of Object.keys(catalogBuilds)) {
  cpSync(join(catalogRoot, id), join(out, 'runtime', 'catalog', id), { recursive: true });
}

// The bundled runtime includes BSD-3-Clause code from both upstream projects,
// so their license texts ship with the build.
for (const project of ['jupyter-webmcp', 'jupyterlab-ai-commands']) {
  mkdirSync(join(out, 'licenses'), { recursive: true });
  cpSync(join(root, 'runtime', 'src', 'vendor', project, 'LICENSE'), join(out, 'licenses', `${project}-LICENSE`));
}
cpSync(
  join(root, 'licenses', 'jupyter-design-LICENSE'),
  join(out, 'licenses', 'jupyter-design-LICENSE')
);

console.log(
  `Built ${e2e ? 'e2e ' : ''}extension in ${out} (runtime entry ${entryLoad}, catalog ${Object.keys(catalogBuilds).join(', ')}).`
);
