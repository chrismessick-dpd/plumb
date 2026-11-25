/* Plumb lab: runs a test's script step in Python. Pyodide (CPython compiled to WebAssembly) loads once, the
   first time a script runs, and stays loaded in this Worker. A script reaches the bench only through cmd, tlm,
   wait, log, and record, each a message to the page, which does the work.

   They're plain calls: `wait(150)`, `v = tlm('MAIN.state')`, no `await`. Pyodide's run_sync blocks the Python
   while the page answers, which needs the browser's JavaScript Promise Integration (Chrome and Edge have it). Where
   it's missing, the script's own top-level calls get `await` added before they run, so simple scripts still work.

   The lab loads Pyodide from jsDelivr; the page's own CSP doesn't apply here, since a Worker takes its policy from
   its own file. */
'use strict';
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
let loading = null;
let syncOK = false;
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

// The bench calls as Python sees them. With run_sync they block and return the page's answer.
const PRELUDE_SYNC = [
  'from pyodide.ffi import run_sync as _run_sync',
  'def cmd(ref, *args): return _run_sync(_cmd(ref, *[str(a) for a in args]))',
  'def tlm(ref): return _run_sync(_tlm(ref))',
  'def wait(ms): _run_sync(_wait(ms))',
  'def log(msg): _log(str(msg))',
  'def record(name, value, unit=""): _record(str(name), value, str(unit))'
].join('\n');
const PRELUDE_ASYNC = [
  'def cmd(ref, *args): return _cmd(ref, *[str(a) for a in args])',
  'def tlm(ref): return _tlm(ref)',
  'def wait(ms): return _wait(ms)',
  'def log(msg): _log(str(msg))',
  'def record(name, value, unit=""): _record(str(name), value, str(unit))'
].join('\n');

function ready() {
  if (!loading) {
    loading = (async () => {
      const t0 = performance.now();
      importScripts(PYODIDE + 'pyodide.js');
      const py = await self.loadPyodide({ indexURL: PYODIDE });
      try { syncOK = !!py.runPython('from pyodide.ffi import can_run_sync\ncan_run_sync()'); } catch (e) { syncOK = false; }
      // can_run_sync answers for the current call; run_sync also needs the async entry, so try one for real.
      if (!syncOK) {
        try {
          const ns = py.globals.get('dict')();
          ns.set('_p', () => Promise.resolve(1));
          syncOK = (await py.runPythonAsync('from pyodide.ffi import run_sync\nrun_sync(_p())', { globals: ns })) === 1;
          ns.destroy();
        } catch (e) { syncOK = false; }
      }
      const ver = py.runPython('import sys; sys.version.split()[0]');
      self.postMessage({ type: 'loaded', ms: Math.round(performance.now() - t0), version: ver + ' (Pyodide ' + py.version + ')', sync: syncOK });
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

// Without run_sync: put `await` before the script's own top-level bench calls (not inside a def, where it can't go).
function addAwaits(code) {
  let inDef = -1;
  return code.split('\n').map((line) => {
    const ind = line.length - line.trimStart().length;
    if (inDef >= 0 && line.trim() && ind <= inDef) inDef = -1;
    if (/^\s*(async\s+)?def\s/.test(line)) { inDef = ind; return line; }
    if (inDef >= 0) return line;
    return line.replace(/(^|[^\w.])(?<!await\s)(cmd|tlm|wait)\(/g, '$1await $2(');
  }).join('\n');
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
    ns.set('_cmd', (ref, ...args) => call('cmd', [String(ref), ...args.map(String)]));
    ns.set('_tlm', (ref) => call('tlm', [String(ref)]));
    ns.set('_wait', (ms) => call('wait', [Number(ms) || 0]));
    ns.set('_log', (msg) => { tell('log', [String(msg)]); });
    ns.set('_record', (name, value, unit) => { tell('record', [String(name), typeof value === 'number' ? value : String(value), unit ? String(unit) : '']); });
    py.runPython(syncOK ? PRELUDE_SYNC : PRELUDE_ASYNC, { globals: ns });
    await py.runPythonAsync(syncOK ? m.code : addAwaits(m.code), { globals: ns });
    self.postMessage({ type: 'done', runId: m.runId });
  } catch (err) {
    self.postMessage({ type: 'error', runId: m.runId, message: pyError(err) });
  } finally {
    ns.destroy();
  }
};
