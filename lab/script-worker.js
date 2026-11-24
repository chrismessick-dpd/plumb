/* Plumb lab: runs a test's script step in Python. Pyodide (CPython compiled to WebAssembly) loads once, the
   first time a script runs, and stays loaded in this Worker. A script reaches the bench only through cmd, tlm,
   and wait (awaited) and log and record (not awaited), each a message to the page, which does the work.
   The lab loads Pyodide from jsDelivr; the page's own CSP doesn't apply here, since a Worker takes its policy
   from its own file. */
'use strict';
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
let loading = null;
const pending = new Map();
let nextId = 1;

function call(op, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    self.postMessage({ type: 'call', id, op, args });
  });
}
const tell = (op, args) => self.postMessage({ type: 'call', id: 0, op, args });

function ready() {
  if (!loading) {
    loading = (async () => {
      const t0 = performance.now();
      importScripts(PYODIDE + 'pyodide.js');
      const py = await self.loadPyodide({ indexURL: PYODIDE });
      const ver = py.runPython('import sys; sys.version.split()[0]');
      self.postMessage({ type: 'loaded', ms: Math.round(performance.now() - t0), version: ver + ' (Pyodide ' + py.version + ')' });
      return py;
    })();
  }
  return loading;
}

// Python's traceback ends with the line that matters, such as "NameError: name 'x' is not defined".
function pyError(err) {
  const lines = String((err && err.message) || err).trim().split('\n');
  const last = lines[lines.length - 1];
  const at = lines.slice().reverse().find((l) => /File "<exec>", line \d+/.test(l));
  const n = at && /line (\d+)/.exec(at)[1];
  return (n ? 'line ' + n + ': ' : '') + last;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    return;
  }
  if (m.type === 'load') {
    try { await ready(); } catch (err) { self.postMessage({ type: 'loadfail', message: String(err && err.message || err) }); }
    return;
  }
  if (m.type !== 'run') return;
  let py;
  try { py = await ready(); } catch (err) { self.postMessage({ type: 'error', message: 'Python didn\'t load: ' + (err && err.message || err) }); return; }
  const ns = py.globals.get('dict')();
  try {
    ns.set('cmd', (ref, ...args) => call('cmd', [String(ref), ...args.map(String)]));
    ns.set('tlm', (ref) => call('tlm', [String(ref)]));
    ns.set('wait', (ms) => call('wait', [Number(ms) || 0]));
    ns.set('log', (msg) => { tell('log', [String(msg)]); });
    ns.set('record', (name, value, unit) => { tell('record', [String(name), typeof value === 'number' ? value : String(value), unit ? String(unit) : '']); });
    await py.runPythonAsync(m.code, { globals: ns });
    self.postMessage({ type: 'done', runId: m.runId });
  } catch (err) {
    self.postMessage({ type: 'error', runId: m.runId, message: pyError(err) });
  } finally {
    ns.destroy();
  }
};
