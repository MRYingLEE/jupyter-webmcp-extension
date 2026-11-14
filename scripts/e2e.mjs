#!/usr/bin/env node
/**
 * End-to-end check of the extension against running JupyterLab servers.
 *
 * Usage:
 *   JWE_E2E_URLS=http://localhost:8888,http://localhost:8889 npm run test:e2e
 *
 * Environment:
 *   JWE_E2E_URLS  comma-separated JupyterLab base URLs (required); the servers must be running.
 *   JWE_CHROME    optional Chromium executable, for when Playwright's bundled browser is absent.
 *
 * The runtime build needs `jupyter-builder` on PATH (see README).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist-e2e');
const urls = (process.env.JWE_E2E_URLS ?? '')
  .split(',')
  .map(url => url.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (urls.length === 0) {
  console.error('Set JWE_E2E_URLS to one or more running JupyterLab URLs.');
  process.exit(1);
}

const STATUS_TIMEOUT_MS = 60_000;

async function launch(webmcpFlag) {
  const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`];
  if (webmcpFlag) {
    args.push('--enable-features=WebMCP');
  }
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), 'jwe-e2e-')),
    {
      executablePath: process.env.JWE_CHROME || undefined,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args
    }
  );
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  return { context, worker, extensionId: new URL(worker.url()).host };
}

async function enable(context, extensionId, origin) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const result = await page.evaluate(
    target => chrome.runtime.sendMessage({ type: 'enable', origin: target }),
    origin
  );
  await page.close();
  assert.equal(result.ok, true, `enable ${origin} failed: ${JSON.stringify(result)}`);
}

async function waitForStatus(worker, origin) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    const statuses = await worker.evaluate(
      async () => (await chrome.storage.session.get('tabStatus')).tabStatus ?? {}
    );
    const entry = Object.values(statuses).find(item => item.origin === origin);
    if (entry && Object.keys(entry.components).length === 2) {
      return entry;
    }
    if (Date.now() > deadline) {
      throw new Error(`no runtime status for ${origin}: ${JSON.stringify(statuses)}`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
  }
}

async function checkPage(context, worker, extensionId, base, { webmcpFlag }) {
  await enable(context, extensionId, base);
  const page = await context.newPage();
  await page.goto(`${base}/lab`, { waitUntil: 'load' });
  const status = await waitForStatus(worker, base);

  assert.equal(status.components.ai.state, 'active', `${base}: AI commands not active`);
  if (webmcpFlag) {
    assert.equal(status.components.webmcp.state, 'active', `${base}: WebMCP not active`);
  } else {
    // Mark-unsupported path: the host cannot run WebMCP, so the runtime reports a diagnostic.
    assert.equal(status.components.webmcp.state, 'failed', `${base}: WebMCP should be unsupported`);
    assert.match(status.components.webmcp.detail ?? '', /modelContext/);
  }

  const dom = await page.evaluate(() => ({
    base: document.documentElement.getAttribute('data-jwe-runtime-base'),
    labShell: !!document.querySelector('.jp-LabShell, #jp-main-split-panel'),
    modelContext: typeof document.modelContext
  }));
  // The base uses the dynamic extension origin (use_dynamic_url), so only the scheme and path are fixed.
  assert.ok(dom.base?.startsWith('chrome-extension://') && dom.base.endsWith('/runtime/'), `${base}: runtime base not set`);
  assert.ok(dom.labShell, `${base}: JupyterLab shell not rendered`);
  assert.equal(dom.modelContext, webmcpFlag ? 'object' : 'undefined', `${base}: modelContext`);
  await page.close();
  console.log(`ok ${base} (webmcp ${webmcpFlag ? 'enabled' : 'unsupported'})`);
}

async function runSuite(webmcpFlag) {
  const { context, worker, extensionId } = await launch(webmcpFlag);
  try {
    for (const base of urls) {
      await checkPage(context, worker, extensionId, base, { webmcpFlag });
    }
  } finally {
    await context.close();
  }
}

try {
  execFileSync('npm', ['run', 'build:e2e'], { cwd: root, stdio: 'inherit' });
  await runSuite(true);
  await runSuite(false);
  console.log('e2e passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
