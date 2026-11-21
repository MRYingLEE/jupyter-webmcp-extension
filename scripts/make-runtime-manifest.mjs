#!/usr/bin/env node
// Publishes the built catalog (runtime/catalog/<id>/) as a runtime manifest in
// dist-catalog/: one directory per id with its static/ files, and a manifest.json
// that lists each file with its sha256. Serve dist-catalog/ over https and point
// the extension's options page at manifest.json.
//
// The version is the catalog package's version plus a short digest of the files,
// so a rebuild with the same package version is still a new version.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_MANIFEST_SCHEMA = 'jupyter-webmcp-extension/runtime-catalog@1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogRoot = join(root, 'runtime', 'catalog');
const outRoot = join(root, 'dist-catalog');
const pins = JSON.parse(readFileSync(join(root, 'scripts', 'catalog-pins.json'), 'utf8'));

/** Every file under a directory, as paths relative to it, in sorted order. */
function filesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path).map(file => `${name}/${file}`));
    } else {
      found.push(name);
    }
  }
  return found.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A module path in the form the manifest requires: starting with ./. */
function relativeModule(path) {
  return path.startsWith('./') ? path : `./${path}`;
}

const entries = [];
for (const { id, federation } of pins.entries) {
  const dir = join(catalogRoot, id);
  const packagePath = join(dir, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`runtime/catalog/${id} is missing; run \`npm run build:catalog\` first.`);
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const build = pkg.jupyterlab?._build;
  if (typeof build?.load !== 'string' || typeof build?.extension !== 'string') {
    throw new Error(`runtime/catalog/${id}/package.json has no jupyterlab._build entry.`);
  }
  const staticDir = join(dir, 'static');
  // Paths are relative to the package directory, like the load entry.
  const files = filesUnder(staticDir).map(name => ({
    path: `static/${name}`,
    sha256: sha256(join(staticDir, name))
  }));
  const digest = createHash('sha256')
    .update(files.map(file => `${file.path}:${file.sha256}`).join('\n'))
    .digest('hex')
    .slice(0, 8);

  const outDir = join(outRoot, id);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(staticDir, join(outDir, 'static'), { recursive: true });

  entries.push({
    id,
    federation,
    version: `${pkg.version}+${digest}`,
    base: `${id}/`,
    // The manifest format requires module paths to start with ./.
    load: relativeModule(build.load),
    extension: relativeModule(build.extension),
    files
  });
}

writeFileSync(
  join(outRoot, 'manifest.json'),
  `${JSON.stringify({ schema: RUNTIME_MANIFEST_SCHEMA, entries }, null, 2)}\n`
);
console.log(`Wrote ${relative(root, join(outRoot, 'manifest.json'))} with ${entries.length} entries.`);
