#!/usr/bin/env node
/**
 * End-to-end check of the extension against running JupyterLab servers.
 *
 * Usage:
 *   JWE_E2E_URLS=http://localhost:8888,http://localhost:8889 npm run test:e2e
 *
 * Environment:
 *   JWE_E2E_URLS     comma-separated JupyterLab base URLs (required); the servers must be running.
 *   JWE_E2E_CSP_URL  optional JupyterLab base URL served with a strict script-src CSP (no chrome-extension:).
 *   JWE_CHROME       optional Chromium executable, for when Playwright's bundled browser is absent.
 *
 * The runtime build needs `jupyter-builder` on PATH (see README).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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
const cspUrl = (process.env.JWE_E2E_CSP_URL ?? '').trim().replace(/\/+$/, '');
// A different origin from every JupyterLite URL, served by the harness on loopback (see startParentServer).
const PARENT_PORT = 8894;
const PARENT_ORIGIN = `http://127.0.0.1:${PARENT_PORT}`;
const PARENT_PATH = '/jwe-e2e-xparent';

if (urls.length === 0) {
  console.error('Set JWE_E2E_URLS to one or more running JupyterLab URLs.');
  process.exit(1);
}

const STATUS_TIMEOUT_MS = 60_000;
const sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function launch(webmcpFlag, extensionDir = dist) {
  const args = [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
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

const isReady = entry => Object.keys(entry.components).length === 2;

async function readStatuses(worker, origin) {
  const statuses = await worker.evaluate(
    async () => (await chrome.storage.session.get('tabStatus')).tabStatus ?? {}
  );
  return Object.values(statuses).filter(item => item.origin === origin);
}

async function readFrameStatuses(worker, origin) {
  const tabs = await worker.evaluate(
    async () => (await chrome.storage.session.get('frameStatus')).frameStatus ?? {}
  );
  return Object.values(tabs)
    .flatMap(frames => Object.values(frames))
    .filter(item => item.origin === origin);
}

async function isLite(base) {
  return (await fetch(`${base}/jupyter-lite.json`)).ok;
}

async function until(check, description, timeoutMs = STATUS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(1000);
  }
}

async function waitForStatuses(worker, origin, count = 1) {
  return until(async () => {
    const ready = (await readStatuses(worker, origin)).filter(isReady);
    return ready.length >= count ? ready : null;
  }, `${count} runtime status(es) for ${origin}`);
}

// The five upstream built-ins from the plan (§8) are get_context, list_all_commands, execute_command,
// answer_dialog and wait_for_result. The rest are default AI-command tools.
const REQUIRED_TOOLS = [
  'get_context',
  'list_all_commands',
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

async function toolNames(page) {
  return page.evaluate(async () =>
    typeof document.modelContext === 'object' ? (await document.modelContext.getTools()).map(tool => tool.name) : []
  );
}

async function waitForTools(page) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let names = await toolNames(page);
  while (!REQUIRED_TOOLS.every(name => names.includes(name)) && Date.now() < deadline) {
    await sleep(500);
    names = await toolNames(page);
  }
  return names;
}

async function getContext(page) {
  const text = await page.evaluate(async () => {
    const tool = (await document.modelContext.getTools()).find(item => item.name === 'get_context');
    const result = await document.modelContext.executeTool(tool, {});
    return typeof result === 'string' ? result : JSON.stringify(result);
  });
  return JSON.parse(text);
}

async function checkTools(page, base) {
  // The status turns active before the tools are synced, so wait for them to appear.
  const names = await waitForTools(page);
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
  const [status] = await waitForStatuses(worker, base);

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

// The isolated bridge marks every page of an enabled origin, so the runtime (status and tools) is the signal here.
async function checkNonJupyterPage(context, worker, base) {
  const page = await context.newPage();
  await page.goto(`${base}/api/status`, { waitUntil: 'load' });
  await sleep(5000);
  assert.deepEqual(await readStatuses(worker, base), [], `${base}/api/status: runtime reported status on a non-Jupyter page`);
  assert.deepEqual(await toolNames(page), [], `${base}/api/status: tools on a non-Jupyter page`);
  await page.close();
  console.log(`ok ${base}/api/status (non-Jupyter page)`);
}

// JupyterLab sends frame-ancestors 'self', so the embed has to be same-origin. Jupyter's own pages send
// default-src 'none', which blocks any frame, so the parent is a routed document without a CSP. A JupyterLite
// service worker answers navigations before Playwright routes see them, so there the parent is a real file that
// has no CSP and no #jupyter-config-data, and the frame is set with setContent.
// A same-origin frame has tools by default, so the runtime runs there with or without allow="tools". The
// permission only matters across origins (see checkCrossOrigin).
async function checkIframe(context, worker, base, { allowTools }) {
  const page = await context.newPage();
  const iframe = `<!doctype html><iframe src="${base}/lab" ${allowTools ? 'allow="tools"' : ''}></iframe>`;
  if (await isLite(base)) {
    await page.goto(`${base}/jupyter-lite.json`, { waitUntil: 'load' });
    await page.setContent(iframe);
  } else {
    await page.route(`${base}/jwe-e2e-parent`, route => route.fulfill({ contentType: 'text/html', body: iframe }));
    await page.goto(`${base}/jwe-e2e-parent`, { waitUntil: 'load' });
  }
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForLoadState('load');
  await sleep(15_000);
  const label = `${base} iframe (allow="tools": ${allowTools})`;
  const labShell = await frame.evaluate(() => !!document.querySelector('.jp-LabShell, #jp-main-split-panel'));
  assert.ok(labShell, `${label}: JupyterLab shell not rendered in iframe`);
  const injected = await frame.evaluate(() => document.documentElement.getAttribute('data-jwe-runtime-base'));
  assert.ok(injected?.startsWith('chrome-extension://'), `${label}: runtime not granted to a same-origin subframe`);
  await until(async () => (await readFrameStatuses(worker, base)).some(item => item.components.ai?.state === 'active'), `${label}: embedded AI status`);
  // Chrome lists a same-origin subframe's tools on the top document too (the parent has none without the frame).
  // That stays inside one origin, so it is recorded here rather than asserted.
  const parentTools = (await toolNames(page)).length;
  await page.close();
  console.log(`ok ${label} (same-origin subframe runs the runtime; parent lists ${parentTools} tools)`);
}

// The parent is on another origin, so the embedded frame needs allow="tools", and the parent origin must be
// enabled too. Each case checks the frame's runtime base and the status it reports to the popup and badge.
// The parent comes from startParentServer: a routed document has no network address, so Chrome's Private Network
// Access rules would block the loopback child.
async function checkCrossOrigin(context, worker, child, { allowTools, parentEnabled }) {
  const page = await context.newPage();
  const target = `${PARENT_ORIGIN}${PARENT_PATH}?src=${encodeURIComponent(`${child}/lab`)}&allow=${allowTools ? 1 : 0}`;
  await page.goto(target, { waitUntil: 'load' });
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForLoadState('load');
  const label = `${child} in ${PARENT_ORIGIN} (allow="tools": ${allowTools}, parent enabled: ${parentEnabled})`;
  await until(() => frame.evaluate(() => !!document.querySelector('.jp-LabShell, #jp-main-split-panel')), `${label}: JupyterLab shell`);
  const granted = allowTools && parentEnabled;
  const deniedDetail = allowTools
    ? 'Runtime is not enabled for this frame.'
    : 'The embedding frame does not allow the tools permission.';
  const entry = await until(
    async () => (await readFrameStatuses(worker, child)).find(item =>
      granted ? item.components.ai?.state === 'active' : item.components.runtime?.detail === deniedDetail
    ),
    `${label}: embedded status`
  );
  const base = await frame.evaluate(() => document.documentElement.getAttribute('data-jwe-runtime-base'));
  assert.equal(Boolean(base?.startsWith('chrome-extension://')), granted, `${label}: runtime base ${base}`);
  await page.close();
  console.log(`ok ${label}: ${granted ? 'runtime active' : `failed: ${entry.components.runtime.detail}`}`);
}

async function checkMultipleTabs(context, worker, base) {
  const first = await context.newPage();
  await first.goto(`${base}/lab`, { waitUntil: 'load' });
  const second = await context.newPage();
  await second.goto(`${base}/lab`, { waitUntil: 'load' });
  await waitForStatuses(worker, base, 2);
  for (const page of [first, second]) {
    await waitForTools(page);
    assert.equal((await getContext(page)).success, true, `${base}: get_context before closing a tab`);
  }
  await first.close();
  await until(async () => (await readStatuses(worker, base)).length === 1, `tab status cleanup for ${base}`);
  assert.equal((await getContext(second)).success, true, `${base}: remaining tab stopped answering after a tab closed`);
  await second.close();
  console.log(`ok ${base} (two tabs)`);
}

async function checkReload(context, worker, base) {
  const page = await context.newPage();
  await page.goto(`${base}/lab`, { waitUntil: 'load' });
  await waitForStatuses(worker, base);
  await waitForTools(page);
  await page.evaluate(() => {
    window.__jweBeforeReload = true;
  });
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.__jweBeforeReload), undefined, `${base}: page did not reload`);
  await waitForStatuses(worker, base);
  await sleep(3000);
  assert.equal((await readStatuses(worker, base)).length, 1, `${base}: reload duplicated tab status`);
  await waitForTools(page);
  assert.equal((await getContext(page)).success, true, `${base}: get_context after reload`);
  await page.close();
  console.log(`ok ${base} (reload)`);
}

async function runSuite(webmcpFlag) {
  const { context, worker, extensionId } = await launch(webmcpFlag);
  try {
    for (const base of urls) {
      await checkPage(context, worker, extensionId, base, { webmcpFlag });
    }
    await checkNotEnabled(context, urls[0]);
    if (webmcpFlag) {
      for (const base of urls) {
        await checkNonJupyterPage(context, worker, base);
        await checkIframe(context, worker, base, { allowTools: false });
        await checkIframe(context, worker, base, { allowTools: true });
        await checkMultipleTabs(context, worker, base);
        await checkReload(context, worker, base);
      }
    }
  } finally {
    await context.close();
  }
}

// Removing the runtime bundle must not break JupyterLab itself, and the failure must be reported as a failed
// runtime status (shown in the popup and on the badge).
async function runMissingRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'jwe-dist-noruntime-'));
  cpSync(dist, dir, { recursive: true });
  const staticDir = join(dir, 'runtime', 'static');
  for (const file of readdirSync(staticDir)) {
    if (file.startsWith('remoteEntry')) {
      rmSync(join(staticDir, file));
    }
  }
  const { context, worker, extensionId } = await launch(true, dir);
  try {
    const base = urls[0];
    await enable(context, extensionId, base);
    const page = await context.newPage();
    await page.goto(`${base}/lab`, { waitUntil: 'load' });
    await sleep(15_000);
    assert.ok(await page.evaluate(() => !!document.querySelector('.jp-LabShell, #jp-main-split-panel')), `${base}: JupyterLab shell not rendered without the runtime`);
    const failed = await until(
      async () => (await readStatuses(worker, base)).find(item => item.components.runtime?.state === 'failed'),
      `runtime failure status for ${base}`
    );
    assert.match(failed.components.runtime.detail ?? '', /failed to load/, `${base}: runtime failure detail`);
    assert.deepEqual(await toolNames(page), [], `${base}: tools without the runtime`);
    await page.close();
    console.log(`ok ${base} (runtime missing: failed runtime status, no tools)`);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function startParentServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, PARENT_ORIGIN);
    if (url.pathname !== PARENT_PATH) {
      res.writeHead(404).end();
      return;
    }
    const src = url.searchParams.get('src');
    const allow = url.searchParams.get('allow') === '1' ? ' allow="tools"' : '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><iframe src="${src}"${allow}></iframe>`);
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(PARENT_PORT, '127.0.0.1', () => resolveStart(server));
  });
}

async function runCrossOrigin() {
  const lites = [];
  for (const base of urls) {
    if (await isLite(base)) {
      lites.push(base);
    }
  }
  if (lites.length === 0) {
    return;
  }
  const parentServer = await startParentServer();
  const { context, worker, extensionId } = await launch(true);
  try {
    for (const child of lites) {
      await enable(context, extensionId, child);
    }
    for (const child of lites) {
      await checkCrossOrigin(context, worker, child, { allowTools: true, parentEnabled: false });
      await checkCrossOrigin(context, worker, child, { allowTools: false, parentEnabled: false });
    }
    await enable(context, extensionId, PARENT_ORIGIN);
    for (const child of lites) {
      await checkCrossOrigin(context, worker, child, { allowTools: true, parentEnabled: true });
      await checkCrossOrigin(context, worker, child, { allowTools: false, parentEnabled: true });
    }
  } finally {
    await context.close();
    parentServer.close();
  }
}

// The served CSP has no chrome-extension: source, yet the runtime still loads: Chrome does not apply the page's
// script-src to a web-accessible extension resource. The check records that the runtime works under this policy.
async function runStrictCsp() {
  const { context, worker, extensionId } = await launch(true);
  try {
    await enable(context, extensionId, cspUrl);
    const page = await context.newPage();
    const response = await page.goto(`${cspUrl}/lab`, { waitUntil: 'load' });
    const csp = response.headers()['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src ')) ?? '';
    assert.ok(scriptSrc, `${cspUrl}: strict CSP has no script-src directive`);
    assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, `${cspUrl}: script-src allows 'unsafe-inline'`);
    assert.doesNotMatch(csp, /chrome-extension:/, `${cspUrl}: CSP allows chrome-extension:`);
    await waitForStatuses(worker, cspUrl);
    assert.ok(await page.evaluate(() => !!document.querySelector('.jp-LabShell, #jp-main-split-panel')), `${cspUrl}: JupyterLab shell not rendered under strict CSP`);
    const names = await waitForTools(page);
    assert.ok(REQUIRED_TOOLS.every(name => names.includes(name)), `${cspUrl}: required tools missing under strict CSP`);
    await page.close();
    console.log(`ok ${cspUrl} (strict CSP: runtime loads, status and tools present)`);
  } finally {
    await context.close();
  }
}

try {
  execFileSync('npm', ['run', 'build:e2e'], { cwd: root, stdio: 'inherit' });
  await runSuite(true);
  await runSuite(false);
  await runMissingRuntime();
  await runCrossOrigin();
  if (cspUrl) {
    await runStrictCsp();
  }
  console.log('e2e passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
