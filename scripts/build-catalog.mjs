#!/usr/bin/env node
// Builds the runtime catalog from scripts/catalog-pins.json into runtime/catalog/<id>/.
// Anywidget lines are built from a local anywidget checkout at the pinned commit
// (ANYWIDGET_SOURCE), each under a unique federation name so several lines can coexist.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'scripts/catalog-pins.json'), 'utf8'));
const outRoot = join(root, 'runtime/catalog');

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function fail(message) {
  throw new Error(message);
}

function assertPluginId(dir, plugin) {
  const files = readdirSync(join(dir, 'static'));
  const found = files.some((file) => readFileSync(join(dir, 'static', file), 'utf8').includes(plugin));
  if (!found) fail(`plugin id ${plugin} not found in ${dir}/static`);
}

function publish(entry, labextensionDir, licensePath) {
  const dest = join(outRoot, entry.id);
  rmSync(dest, { recursive: true, force: true });
  cpSync(labextensionDir, dest, { recursive: true });
  copyFileSync(licensePath, join(dest, 'LICENSE'));
  console.log(`catalog ${entry.id} -> ${dest}`);
}

function buildAnywidget(entry, source) {
  const work = mkdtempSync(join(tmpdir(), `jwe-${entry.id}-`));
  try {
    const tar = join(work, 'source.tar');
    run('git', ['-C', source, 'archive', '--format=tar', '-o', tar, entry.source.commit]);
    const tree = join(work, 'anywidget');
    mkdirSync(tree);
    run('tar', ['-xf', tar, '-C', tree]);

    run('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: tree });

    // Rename after install so the lockfile still matches; the rename only changes the
    // federation container and plugin id, not the widget name the Python side looks up.
    const pkgPath = join(tree, 'packages/anywidget/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.name = entry.federation;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const pluginPath = join(tree, 'packages/anywidget/src/plugin.js');
    const plugin = readFileSync(pluginPath, 'utf8');
    const original = 'id: "anywidget:plugin"';
    if (plugin.split(original).length !== 2) fail(`expected exactly one ${original} in plugin.js`);
    writeFileSync(pluginPath, plugin.replace(original, `id: "${entry.plugin}"`));

    run('corepack', ['pnpm', 'run', 'build'], { cwd: tree });

    const labextensionDir = join(tree, 'anywidget/labextension');
    const built = JSON.parse(readFileSync(join(labextensionDir, 'package.json'), 'utf8'));
    if (built.name !== entry.federation) fail(`built name ${built.name} != ${entry.federation}`);
    if (!built.version.startsWith(`${entry.line}.`)) fail(`built version ${built.version} is not ${entry.line}.x`);
    if (!existsSync(join(labextensionDir, built.jupyterlab._build.load))) fail('remoteEntry is missing');
    assertPluginId(labextensionDir, entry.plugin);

    publish(entry, labextensionDir, join(tree, 'LICENSE'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function buildWidgetManager(entry) {
  const { package: name, version, sha256 } = entry.source;
  const work = mkdtempSync(join(tmpdir(), `jwe-${entry.id}-`));
  try {
    const wheelDir = join(work, 'wheel');
    run('python3', ['-m', 'pip', 'download', `${name}==${version}`, '--no-deps', '--only-binary=:all:', '--dest', wheelDir]);
    const wheelName = readdirSync(wheelDir).find((file) => file.endsWith('.whl'));
    if (!wheelName) fail(`no wheel downloaded for ${name}==${version}`);
    const wheel = join(wheelDir, wheelName);

    const digest = createHash('sha256').update(readFileSync(wheel)).digest('hex');
    if (digest !== sha256) fail(`sha256 mismatch for ${wheelName}: ${digest}`);

    const extracted = join(work, 'extracted');
    run('python3', ['-m', 'zipfile', '-e', wheel, extracted]);

    const labextensionDir = join(extracted, `${name}-${version}.data/data/share/jupyter/labextensions`, ...entry.federation.split('/'));
    const built = JSON.parse(readFileSync(join(labextensionDir, 'package.json'), 'utf8'));
    if (built.name !== entry.federation) fail(`labextension name ${built.name} != ${entry.federation}`);
    assertPluginId(labextensionDir, entry.plugin);

    publish(entry, labextensionDir, join(extracted, `${name}-${version}.dist-info/licenses/LICENSE`));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const source = process.env.ANYWIDGET_SOURCE;
const needsAnywidget = pins.entries.some((entry) => entry.source.kind === 'git');
if (needsAnywidget && !source) {
  fail('set ANYWIDGET_SOURCE to a local anywidget checkout containing the pinned commits');
}

mkdirSync(outRoot, { recursive: true });
for (const entry of pins.entries) {
  if (entry.source.kind === 'git') buildAnywidget(entry, resolve(source));
  else if (entry.source.kind === 'pypi') buildWidgetManager(entry);
  else fail(`unknown source kind for ${entry.id}`);
}
