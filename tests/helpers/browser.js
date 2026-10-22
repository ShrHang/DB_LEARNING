import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(operation, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; } catch { /* page navigation can replace the execution context */ }
    await sleep(100);
  }
  throw new Error(`等待超时：${message}`);
}

export async function openBrowser(origin, errors = []) {
  const profile = await mkdtemp(join(tmpdir(), 'questionnaire-browser-'));
  let browser, socket;
  async function close() {
    socket?.close();
    if (browser?.pid && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await exited;
    }
    // Chromium child processes may finish writing just after the main process
    // exits. Retry that directory race; still surface persistent cleanup errors.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    browser = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let launchError;
    browser.on('error', error => { launchError = error; });
    const debug = await until(async () => {
      if (launchError) throw launchError;
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return `http://127.0.0.1:${port}`;
    }, 'Chromium 调试端口');
    if (launchError) throw launchError;
    const targets = await (await fetch(`${debug}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    });
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function navigate(path) {
      await cdp('Page.navigate', { url: `${origin}${path}` });
      await until(() => evaluate(`location.pathname === ${JSON.stringify(path.split('?')[0])} && document.readyState === 'complete'`), path);
    }
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    return { cdp, evaluate, navigate, close };
  } catch (error) { await close(); throw error; }
}
