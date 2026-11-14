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

const REQUIRED_TOOLS = [
  'get_context',
  'create_notebook',
  'add_cell',
  'read_notebook',
  'run_cell',
  'save_notebook',
  'read_file',
  'write_file',
  'run_code',
  'interrupt_kernel',
  'restart_kernel',
  'execute_command',
  'answer_dialog',
  'wait_for_result'
];

async function checkTools(page, base) {
  // The status turns active before the tools are synced, so wait for them to appear.
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let names;
  for (;;) {
    names = await page.evaluate(async () => (await document.modelContext.getTools()).map(tool => tool.name));
    if (REQUIRED_TOOLS.every(name => names.includes(name)) || Date.now() > deadline) {
      break;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  }
  for (const name of REQUIRED_TOOLS) {
    assert.ok(names.includes(name), `${base}: missing tool ${name}`);
  }

  // Unique names so repeated runs on a shared server root do not collide.
  const notebookName = `jwe-e2e-${Date.now()}`;
  const notebookPath = `${notebookName}.ipynb`;
  const filePath = `${notebookName}.txt`;
  const call = async (name, input, { expectSuccess = true } = {}) => {
    const text = await page.evaluate(async ([toolName, toolInput]) => {
      const tool = (await document.modelContext.getTools()).find(item => item.name === toolName);
      const result = await document.modelContext.executeTool(tool, toolInput);
      return typeof result === 'string' ? result : JSON.stringify(result);
    }, [name, input]);
    const parsed = JSON.parse(text);
    if (expectSuccess) {
      assert.equal(parsed.success, true, `${base}: ${name} failed: ${text}`);
    }
    return parsed;
  };

  // Scenario from the plan (§8), in order. A shared server can restore dialogs from earlier runs (for
  // example "Select Kernel"), so clear shown dialogs first; the harness expects a disposable server.
  const clearDialogs = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { dialogs = [] } = await call('get_context', {});
      const shown = dialogs.find(item => item.shown);
      if (!shown) {
        return;
      }
      const answer = await call('answer_dialog', { button: shown.buttons[0], dialogId: shown.id }, { expectSuccess: false });
      assert.ok(answer.answered, `${base}: answer_dialog did not answer: ${JSON.stringify(answer)}`);
    }
    throw new Error(`${base}: dialogs keep opening`);
  };
  await clearDialogs();
  await call('create_notebook', { name: notebookName });
  const { cellId } = await call('add_cell', { notebookPath, content: 'print(1+1)', cellType: 'code' });
  const unsaved = await call('read_notebook', { notebookPath });
  assert.match(JSON.stringify(unsaved.content), /print\(1\+1\)/, `${base}: read_notebook unsaved cell`);
  const run = await call('run_cell', { notebookPath, cellId });
  assert.equal(run.status, 'ok', `${base}: run_cell status`);
  assert.match(JSON.stringify(run.outputs), /2/, `${base}: run_cell output`);
  await call('save_notebook', { notebookPath });

  await call('create_file', { fileName: filePath, fileType: 'text', content: 'before' });
  await call('write_file', { filePath, content: 'hi' });
  const file = await call('read_file', { filePath });
  assert.equal(file.content, 'hi', `${base}: read_file content`);

  // The kernel belongs to the notebook opened by this run, not to any earlier one.
  const info = await call('get_context', {});
  const kernelId = info.widgets?.find(widget => widget.path === notebookPath)?.kernel?.id;
  assert.ok(kernelId, `${base}: no kernel for ${notebookPath} in get_context`);
  const quick = await call('run_code', { kernelId, code: 'print(40+2)' });
  assert.match(JSON.stringify(quick.outputs), /42/, `${base}: run_code output`);

  // A call that outlives the foreground wait returns pending. Interrupt it, then collect the result.
  const slow = await call('run_code', { kernelId, code: 'import time\ntime.sleep(60)' }, { expectSuccess: false });
  assert.equal(slow.status, 'pending', `${base}: long run_code should be pending`);
  await call('interrupt_kernel', { kernelId });
  const settled = await call('wait_for_result', { pendingId: slow.pendingId, timeout: 60 }, { expectSuccess: false });
  assert.notEqual(settled.status, 'ok', `${base}: interrupted run should not succeed`);
  await call('restart_kernel', { kernelId });

  const blocked = await call('execute_command', { command_id: 'apputils:run-all-enabled' }, { expectSuccess: false });
  assert.equal(blocked.success, false, `${base}: blocked command should fail`);
  assert.match(blocked.error ?? '', /blocked/, `${base}: blocked command message`);

  // Writing a file that does not exist opens an error dialog; answer_dialog closes that dialog by id.
  // Other dialogs may be open on a shared server, so the id is required.
  const dialog = await call('write_file', { filePath: `${notebookName}-missing.txt`, content: 'x' }, { expectSuccess: false });
  assert.equal(dialog.status, 'pending', `${base}: missing file should raise a dialog`);
  assert.ok(dialog.dialog?.id, `${base}: dialog id missing`);
  const answer = await call('answer_dialog', { button: dialog.dialog.buttons[0], dialogId: dialog.dialog.id }, { expectSuccess: false });
  assert.ok(answer.answered, `${base}: answer_dialog did not answer: ${JSON.stringify(answer)}`);
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
  if (webmcpFlag) {
    await checkTools(page, base);
  }
  await page.close();
  console.log(`ok ${base} (webmcp ${webmcpFlag ? 'enabled' : 'unsupported'})`);
}

async function checkNotEnabled(context, base) {
  // 127.0.0.1 is a different origin from the enabled localhost origin, so it must not be injected.
  const other = base.replace('://localhost', '://127.0.0.1');
  if (other === base) {
    return;
  }
  const page = await context.newPage();
  await page.goto(`${other}/lab`, { waitUntil: 'load' });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 5000));
  const injected = await page.evaluate(() => document.documentElement.getAttribute('data-jwe-runtime-base'));
  assert.equal(injected, null, `${other}: runtime injected on a site that is not enabled`);
  await page.close();
  console.log(`ok ${other} (not enabled)`);
}

async function runSuite(webmcpFlag) {
  const { context, worker, extensionId } = await launch(webmcpFlag);
  try {
    for (const base of urls) {
      await checkPage(context, worker, extensionId, base, { webmcpFlag });
    }
    await checkNotEnabled(context, urls[0]);
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
