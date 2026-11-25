"""The runner: runs a bench's tests against real (or simulated) targets, as the page's runner does in the browser.

A port of runTest, execBlock, and execStep in assets/app.js, with the same rules: a block's cleanup registers when
the block starts, so it runs after a failure or an Abort; a test's own cleanups run before those of the tests it
called; `$name` is a for or repeat variable, else a value kept earlier; `todo` makes the test skip; Abort stops at
the next step but never skips a cleanup. Only Abort (or Ctrl+C) stops a run: a page closing doesn't.

Everything it does goes out as events through `emit(dict)`: log lines, step results (by line index, as the page's
rows are), and test results. Operator steps wait on `operator(text, choices)`, a coroutine the caller supplies
(the page, the console, or a fixed answer).
"""
import asyncio
import re
import threading
import time
import traceback

from . import ifaces, lang
from .lang import cond_pass, cond_text, fmt_qty, parse_qty, parse_step, trim_num


class Abort(Exception):
    pass


class Stop(Exception):
    pass


def _fmt_v(r):
    if not r:
        return ''
    v = r['v']
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return fmt_qty(v, r.get('unit', ''))
    s = str(v)
    return str(len(s.split('\n'))) + ' lines' if '\n' in s else '"' + s + '"'


class BridgeCalls:
    """What a `script on bridge` step reaches as `bridge`. Calls a bench doesn't provide fail clearly."""

    def __init__(self, provided=None):
        self._provided = provided or {}

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        if name in self._provided:
            return self._provided[name]

        def missing(*a, **k):
            raise ifaces.BridgeError('bridge.%s is not on this bench' % name)
        return missing


class Runner:
    def __init__(self, defs_text, script_text, station=None, emit=None, operator=None, bridge_calls=None):
        self.defs = lang.parse_defs(defs_text)
        self.tree = lang.parse_script(script_text)
        self.text = script_text
        self.station = station or {}
        out = emit or (lambda e: None)

        def safe_emit(ev):          # a listener that fails (a closed page, a console) never stops a test
            try:
                out(ev)
            except Exception:
                pass
        self.emit = safe_emit
        self.operator = operator
        self.bridge_calls = BridgeCalls(bridge_calls)
        self.ifaces, self.iface_err = {}, {}
        self.abort_flag = False
        self.in_cleanup = False
        self.running = False
        self.results = {}

    # ------------------------------------------------------------ targets
    async def iface(self, name):
        if name in self.ifaces:
            return self.ifaces[name]
        t = self.defs['targets'].get(name)
        if not t:
            raise ifaces.BridgeError('No target ' + name)
        i = ifaces.make(t, self.station)
        await asyncio.to_thread(i.open)
        self.ifaces[name] = i
        return i

    async def attach(self, names):
        """Opens what it can; returns {name: reason} for the targets it can't reach."""
        missing = {}
        for n in names:
            try:
                await self.iface(n)
            except Exception as e:
                missing[n] = str(e)
        return missing

    def close(self):
        for i in self.ifaces.values():
            try:
                i.close()
            except Exception:
                pass
        self.ifaces = {}

    # ------------------------------------------------------------ the pieces a step uses
    def log(self, kind, text):
        self.emit({'type': 'log', 'kind': kind, 'text': text, 't': time.time()})

    def step_res(self, n, r):
        self.emit(dict({'type': 'step', 'idx': n['idx']}, **r))

    async def abortable(self, sec):
        end = time.monotonic() + sec
        while True:
            if self.abort_flag and not self.in_cleanup:
                raise Abort('Aborted')
            left = end - time.monotonic()
            if left <= 0:
                return
            await asyncio.sleep(min(0.04, left))

    async def send_command(self, text, ctx):
        s = parse_step(text)
        if s['kind'] != 'command':
            raise ifaces.BridgeError('Not a command: ' + text)
        t = self.defs['targets'].get(s['target'])
        if not t:
            raise ifaces.BridgeError('No target ' + s['target'])
        c = t['commands'].get(s['cmd'])
        if not c:
            raise ifaces.BridgeError(s['target'] + ' has no command ' + s['cmd'])
        if len(s['args']) != len(c['params']):
            raise ifaces.BridgeError(s['cmd'] + ' takes ' + str(len(c['params'])) + ' parameters')
        vals, wire_vals = {}, {}
        for p, a in zip(c['params'], s['args']):
            if p['kind'] == 'choice':
                if a not in p['choices']:
                    raise ifaces.BridgeError(p['name'] + ' is one of ' + ', '.join(p['choices']))
                vals[p['name']] = wire_vals[p['name']] = a
            elif p['kind'] == 'range':
                q = parse_qty(a)
                if not q:
                    raise ifaces.BridgeError("Can't read " + a)
                if p['unit'] and q['unit'] and q['unit'] != p['unit']:
                    raise ifaces.BridgeError(p['name'] + ' is in ' + p['unit'])
                if q['v'] < p['range'][0] or q['v'] > p['range'][1]:
                    raise ifaces.BridgeError('%s %s is outside %s to %s%s' % (p['name'], fmt_qty(q['v'], p['unit']), lang.js_num_str(p['range'][0]),
                                                                            lang.js_num_str(p['range'][1]), ' ' + p['unit'] if p['unit'] else ''))
                vals[p['name']] = q['v']
                wire_vals[p['name']] = trim_num(q['v'], 6)
            else:
                vals[p['name']] = wire_vals[p['name']] = a
        wire = re.sub(r'\{(\w+)\}', lambda m: str(wire_vals.get(m.group(1), 'undefined')), c['wire'])
        self.log('tx', s['target'] + ' → ' + (wire or s['cmd']))
        i = await self.iface(s['target'])
        r = await asyncio.to_thread(i.command, s['cmd'], wire, vals, c['returns'])
        if s['into'] and ctx is not None:
            ctx['vars'][s['into']] = {'v': r, 'unit': ''}
        if r is not None:
            self.log('rx', s['target'] + ' ← ' + (fmt_qty(r) if isinstance(r, (int, float)) else '"' + str(r) + '"'))
        return r

    async def read_ref(self, ref, ctx, quiet=False):
        if '.' not in ref:
            if ref not in ctx['vars']:
                raise ifaces.BridgeError('Nothing recorded ' + ref)
            return ctx['vars'][ref]
        tn, item = ref.split('.', 1)
        t = self.defs['targets'].get(tn)
        if not t:
            raise ifaces.BridgeError('No target ' + tn)
        p = t['telemetry'].get(item)
        if not p:
            raise ifaces.BridgeError(tn + ' has no telemetry ' + item)
        i = await self.iface(tn)
        v = await asyncio.to_thread(i.read, p)
        if isinstance(v, bool):
            v = int(v)
        if not quiet:
            self.log('rx', tn + ' ← ' + p['query'] + ' ' + (fmt_qty(v, p['unit']) if isinstance(v, (int, float)) else '"' + str(v) + '"'))
        return {'v': v, 'unit': p['unit']}

    async def ask_operator(self, msg, choices):
        if not self.operator:
            raise ifaces.BridgeError('No operator here to answer: ' + msg)
        self.log('op', 'Waiting for the operator: ' + msg)
        return await self.operator(msg, choices)

    # ------------------------------------------------------------ steps
    async def exec_block(self, nodes, ctx, vars_):
        for n in nodes:
            if n['kind'] == 'step' and n['step']['kind'] == 'cleanup':
                ctx['cleanups'].append({'nodes': n.children, 'vars': vars_, 'depth': ctx['depth'], 'seq': len(ctx['cleanups'])})
        for n in nodes:
            if n['kind'] != 'step' or n['step']['kind'] == 'cleanup':
                continue
            if self.abort_flag and not self.in_cleanup:
                raise Abort('Aborted')
            self.emit({'type': 'current', 'idx': n['idx']})
            await self.exec_step(n, ctx, vars_)

    async def exec_step(self, n, ctx, vars_):
        kept = {k: (x['v'] if isinstance(x, dict) and 'v' in x else x) for k, x in ctx['vars'].items()}
        kept.update(vars_)
        text = re.sub(r'\$([a-z_]\w*)', lambda m: (lang.js_num_str(float(kept[m.group(1)])) if isinstance(kept[m.group(1)], (int, float)) and not isinstance(kept[m.group(1)], bool)
                                                    else str(kept[m.group(1)])) if m.group(1) in kept else m.group(0), n['text'], flags=re.A)
        s = parse_step(text)
        t0 = time.monotonic()
        try:
            k = s['kind']
            if k == 'command':
                r = await self.send_command(text, ctx)
                unit = (ctx['vars'].get(s['into']) or {}).get('unit', '') if s['into'] else ''
                val = fmt_qty(r, unit) if isinstance(r, (int, float)) and not isinstance(r, bool) else ((str(len(str(r).split('\n'))) + ' lines') if s['into'] else '')
                self.step_res(n, {'verdict': 'done', 'value': val})
            elif k == 'wait':
                await self.abortable(s['sec'])
                self.step_res(n, {'verdict': 'done', 'value': fmt_qty(s['sec'], 's')})
            elif k == 'until':
                end = time.monotonic() + s['timeout']
                last = None
                while True:
                    try:
                        last = await self.read_ref(s['ref'], ctx, True)
                        if cond_pass(s['cond'], last['v']):
                            break
                    except Abort:
                        raise
                    except Exception:
                        last = {'v': '(no answer)'}
                    if time.monotonic() > end:
                        self.step_res(n, {'verdict': 'fail', 'value': _fmt_v(last), 'limit': cond_text(s['cond']), 'note': 'Timed out after ' + fmt_qty(s['timeout'], 's')})
                        self.log('fail', 'Timed out: ' + text)
                        raise Stop('timeout')
                    await self.abortable(0.1)
                took = fmt_qty(time.monotonic() - t0, 's')
                self.log('rx', s['ref'] + ' = ' + _fmt_v(last) + ' after ' + took)
                self.step_res(n, {'verdict': 'pass', 'value': _fmt_v(last), 'limit': cond_text(s['cond']), 'note': 'after ' + took})
            elif k == 'check':
                v = await self.read_ref(s['ref'], ctx)
                ok = cond_pass(s['cond'], v['v'])
                self.step_res(n, {'verdict': 'pass' if ok else 'fail', 'value': _fmt_v(v), 'limit': cond_text(s['cond'])})
                ctx['measurements'].append({'name': s['ref'], 'value': v['v'], 'unit': v.get('unit', ''), 'limit': cond_text(s['cond']), 'ok': ok})
                if not ok:
                    ctx['failed'] = True
                    self.log('fail', 'Failed: ' + text + ' (read ' + _fmt_v(v) + ')')
            elif k == 'measure':
                v = await self.read_ref(s['ref'], ctx)
                ctx['vars'][s['as']] = v
                self.step_res(n, {'verdict': 'done', 'value': _fmt_v(v)})
            elif k == 'log':
                self.log('info', s['msg'])
                self.step_res(n, {'verdict': 'done'})
            elif k == 'todo':
                ctx['todo'] = True
                self.log('skip', 'Not written yet: ' + s['msg'])
                self.step_res(n, {'verdict': 'skip', 'note': s['msg']})
            elif k == 'tell':
                await self.ask_operator(s['msg'], [['OK', True]])
                self.step_res(n, {'verdict': 'done'})
            elif k == 'ask':
                ok = bool(await self.ask_operator(s['msg'], [['Yes', True], ['No', False]]))
                self.log('pass' if ok else 'fail', 'Operator: ' + ('yes' if ok else 'no') + ' to "' + s['msg'] + '"')
                self.step_res(n, {'verdict': 'pass' if ok else 'fail', 'value': 'Yes' if ok else 'No'})
                if not ok:
                    ctx['failed'] = True
            elif k == 'call':
                t = self.tree['tests'].get(s['id'])
                if not t:
                    raise ifaces.BridgeError('No test ' + s['id'])
                if ctx['depth'] > 8:
                    raise ifaces.BridgeError('Calls nest too deep')
                self.log('info', 'Call ' + s['id'] + ' ' + t['title'])
                ctx['depth'] += 1
                try:
                    await self.exec_block(t.children, ctx, {})
                finally:
                    ctx['depth'] -= 1
                self.step_res(n, {'verdict': 'done', 'value': s['id']})
            elif k == 'repeat':
                for i in range(s['n']):
                    await self.exec_block(n.children, ctx, dict(vars_, i=i + 1))
                self.step_res(n, {'verdict': 'done', 'value': '%d times' % s['n']})
            elif k == 'for':
                for it in s['items']:
                    await self.exec_block(n.children, ctx, dict(vars_, **{s['v']: it}))
                self.step_res(n, {'verdict': 'done', 'value': '%d items' % len(s['items'])})
            elif k == 'script':
                recs = await self.run_script(n, ctx, bool(s.get('bridge')))
                self.step_res(n, {'verdict': 'done', 'value': recs})
            else:
                raise ifaces.BridgeError("Can't read this step")
        except (Abort, Stop):
            raise
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            self.step_res(n, {'verdict': 'error', 'note': msg})
            self.log('error', msg)
            raise Stop(msg)

    async def run_script(self, n, ctx, on_bridge):
        """A script step's Python, in a worker thread whose bench calls block on this loop."""
        lines = self.tree['lines']
        code = '\n'.join(' ' * max(0, lines[i]['lead'] - n['lead'] - 2) + lines[i]['text'] for i in n.body)
        loop = asyncio.get_running_loop()
        recs = []

        def call(coro):
            if self.abort_flag and not self.in_cleanup:
                coro.close()
                raise Abort('Aborted')
            return asyncio.run_coroutine_threadsafe(coro, loop).result()

        def record(name, value, unit=''):
            ctx['vars'][str(name)] = {'v': value, 'unit': str(unit)}
            recs.append(str(name) + ' = ' + (fmt_qty(value, str(unit)) if isinstance(value, (int, float)) else str(value)))

        ns = {
            'cmd': lambda ref, *args: call(self.send_command(ref + ' ' + ' '.join(str(a) for a in args), ctx)),
            'tlm': lambda ref: call(self.read_ref(ref, ctx))['v'],
            'wait': lambda ms: call(self.abortable(ms / 1000.0)),
            'log': lambda msg: loop.call_soon_threadsafe(self.log, 'info', str(msg)),
            'record': record,
            '__name__': '__plumb_script__',
        }
        if on_bridge:
            ns['bridge'] = self.bridge_calls

        def work():
            exec(compile(code, '<script>', 'exec'), ns)

        try:
            await asyncio.to_thread(work)
        except Abort:
            raise
        except Exception as e:
            ln = None
            for fr in traceback.extract_tb(e.__traceback__):
                if fr.filename == '<script>':
                    ln = fr.lineno
            if isinstance(e, SyntaxError) and e.filename == '<script>':
                ln = e.lineno
            where = 'line %d' % (n.body[ln - 1] + 1) if ln and 0 < ln <= len(n.body) else 'script'
            raise ifaces.BridgeError('Python %s: %s: %s' % (where, e.__class__.__name__, e)) from None
        return ', '.join(recs)

    # ------------------------------------------------------------ tests and runs
    async def run_test(self, test):
        need = sorted(lang.needs_of(test, self.tree))
        missing = await self.attach(need)
        if missing:
            note = 'Needs ' + ', '.join(missing) + (", which aren't" if len(missing) > 1 else ", which isn't") + ' reachable'
            res = {'verdict': 'skip', 'note': note, 'why': missing, 'at': time.time()}
            self.results[test['id']] = res
            self.emit({'type': 'test', 'id': test['id'], 'result': res})
            self.log('skip', test['id'] + ' skipped: ' + note + ' (' + '; '.join('%s: %s' % kv for kv in missing.items()) + ')')
            return res
        ctx = {'vars': {}, 'cleanups': [], 'measurements': [], 'failed': False, 'depth': 0, 'todo': False}
        t0 = time.monotonic()
        self.emit({'type': 'test', 'id': test['id'], 'result': {'verdict': 'running'}})
        self.log('head', test['id'] + ' ' + test['title'])
        verdict, note = 'pass', ''
        try:
            await self.exec_block(test.children, ctx, {})
            if ctx['failed']:
                verdict = 'fail'
            elif ctx['todo']:
                verdict, note = 'skip', 'Not written yet'
        except Abort:
            verdict, note = 'aborted', 'Aborted'
        except Stop as e:
            if str(e) == 'timeout':
                verdict = 'fail'
            else:
                verdict, note = 'error', str(e)
        if ctx['cleanups']:
            self.in_cleanup = True
            self.log('info', 'Cleanup (always runs)')
            ctx['cleanups'].sort(key=lambda c: (c['depth'], -c['seq']))
            for c in ctx['cleanups']:
                try:
                    await self.exec_block(c['nodes'], ctx, c['vars'])
                except Exception as e:
                    self.log('error', 'Cleanup: ' + str(e))
                    if verdict == 'pass':
                        verdict, note = 'error', 'Cleanup: ' + str(e)
            self.in_cleanup = False
        ms = (time.monotonic() - t0) * 1000
        res = {'verdict': verdict, 'note': note, 'ms': ms, 'at': time.time(), 'measurements': ctx['measurements']}
        self.results[test['id']] = res
        self.emit({'type': 'current', 'idx': None})
        self.emit({'type': 'test', 'id': test['id'], 'result': res})
        self.log('pass' if verdict == 'pass' else 'skip' if verdict == 'aborted' else 'fail',
                 test['id'] + ' ' + verdict.upper() + ' in ' + fmt_qty(ms / 1000, 's'))
        return res

    async def run(self, ids=None):
        """Runs the tests named (all, in order, when None). Returns {id: result}."""
        if self.running:
            raise ifaces.BridgeError('A run is already going')
        tests = [self.tree['tests'][i] for i in ids] if ids else lang.tests_under(self.tree['root'])
        self.running, self.abort_flag = True, False
        self.emit({'type': 'run', 'state': 'started', 'tests': [t['id'] for t in tests]})
        try:
            for t in tests:
                if self.abort_flag:
                    break
                await self.run_test(t)
        finally:
            self.running = False
            self.emit({'type': 'run', 'state': 'ended', 'results': {k: v['verdict'] for k, v in self.results.items()}})
        return self.results

    def abort(self):
        if self.running:
            self.abort_flag = True
            self.log('info', 'Abort: stopping, then cleanup')
