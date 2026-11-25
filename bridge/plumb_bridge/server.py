"""The bridge's link to the Plumb page: a WebSocket on this PC only (127.0.0.1), for Plumb's own pages, after pairing.

Who may connect, since the bridge runs tests (and their Python) on this PC:
  - it listens on 127.0.0.1 only, so nothing on the network reaches it;
  - a browser must come from Plumb's own origin (the hosted page, or a local server on 8774 or 8771), so another
    website open in the same browser can't drive it;
  - the page must give the pairing code the bridge prints when it starts (kept in bridge/.pairing, so a page pairs
    once and stays paired until the file is deleted).
The bridge never fetches a bench itself: the page sends the bench it shows, and the bridge runs exactly that text.

Messages, JSON both ways:
  page → bridge: hello {token}, load {bench: {id, name, defs, script}}, run {ids, hash}, abort, answer {id, value},
                 attach (try the targets again)
  bridge → page: ready {version, targets}, loaded {hash, targets}, the runner's events (log, step, test, current,
                 run), ask {id, msg, choices}, error {msg}
A page that closes doesn't stop a run: the run carries on (only Abort or Ctrl+C stops it, and cleanup still runs),
and a page that comes back gets the run's events so far and any question still waiting.
"""
import asyncio
import hashlib
import json
import os
import secrets
import signal
import threading

from . import __version__
from .runner import Abort, Runner

PORT = 47615
ORIGINS = {'https://chrismessick-dpd.github.io', 'http://localhost:8774', 'http://127.0.0.1:8774',
           'http://localhost:8771', 'http://127.0.0.1:8771'}
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def say(text):
    """The console: never lets a character the console can't show (→, µ, °) break a run."""
    try:
        print(text, flush=True)
    except Exception:
        try:
            print(text.encode('ascii', 'replace').decode(), flush=True)
        except Exception:
            pass


def bench_hash(defs, script):
    return hashlib.sha256((defs + '\n\u0000\n' + script).encode('utf-8')).hexdigest()


def pairing_code():
    p = os.path.join(HERE, '.pairing')
    if os.path.exists(p):
        code = open(p).read().strip()
        if code:
            return code
    code = '%06d' % secrets.randbelow(10 ** 6)
    open(p, 'w').write(code)
    return code


def load_station():
    p = os.path.join(HERE, 'station.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


class Bridge:
    def __init__(self, code, station):
        self.code, self.station = code, station
        self.client = None
        self.runner, self.bench, self.hash = None, None, None
        self.run_task = None
        self.events = []             # the current run's events, replayed to a page that reconnects
        self.asks, self.next_ask = {}, 1
        self.loop, self.loop_thread = None, None

    # ------------------------------------------------------------ to the page
    async def send(self, msg):
        c = self.client
        if c:
            try:
                await c.send(json.dumps(msg, default=str))
            except Exception:
                pass

    def emit(self, ev):
        if self.loop and threading.get_ident() != self.loop_thread:
            self.loop.call_soon_threadsafe(self.emit, ev)
            return
        if self.run_task:
            self.events.append(ev)
            if len(self.events) > 5000:
                del self.events[:1000]
        self.loop.create_task(self.send(ev))
        if ev['type'] == 'log':
            say('[%s] %s' % (ev['kind'], ev['text']))

    async def operator(self, msg, choices):
        i = self.next_ask
        self.next_ask += 1
        fut = asyncio.get_running_loop().create_future()
        self.asks[i] = (fut, {'type': 'ask', 'id': i, 'msg': msg, 'choices': choices})
        await self.send(self.asks[i][1])
        try:
            return await fut
        finally:
            self.asks.pop(i, None)
            await self.send({'type': 'ask-done', 'id': i})

    # ------------------------------------------------------------ from the page
    async def targets(self):
        if not self.runner:
            return {}
        names = sorted(self.runner.defs['targets'])
        missing = await self.runner.attach(names)
        out = {}
        for n in names:
            i = self.runner.ifaces.get(n)
            waiting = bool(i is not None and getattr(i, 'connected', True) is False)
            out[n] = {'ok': n not in missing, 'waiting': waiting,
                      'reason': missing.get(n, '') or ('Waiting for the device: not connected yet (a test powers it up)' if waiting else '')}
        return out

    async def handle(self, m):
        t = m.get('type')
        if t == 'load':
            b = m.get('bench') or {}
            defs, script = b.get('defs', ''), b.get('script', '')
            h = bench_hash(defs, script)
            if self.run_task and not self.run_task.done():
                if h != self.hash:
                    return await self.send({'type': 'error', 'msg': 'A run is going on another copy of the bench; it loads when the run ends'})
            else:
                if self.runner:
                    self.runner.close()
                self.runner = Runner(defs, script, station=self.station, emit=self.emit, operator=self.operator)
                self.bench, self.hash = b, h
            await self.send({'type': 'loaded', 'hash': self.hash, 'name': b.get('name', ''), 'targets': await self.targets()})
        elif t == 'attach':
            await self.send({'type': 'targets', 'targets': await self.targets()})
        elif t == 'run':
            if not self.runner:
                return await self.send({'type': 'error', 'msg': 'Load a bench first'})
            if m.get('hash') != self.hash:
                return await self.send({'type': 'error', 'msg': 'The bench changed since it was loaded; it loads again before a run'})
            if self.run_task and not self.run_task.done():
                return await self.send({'type': 'error', 'msg': 'A run is already going'})
            self.events = []
            self.run_task = asyncio.get_running_loop().create_task(self.runner.run(m.get('ids') or None))
        elif t == 'abort':
            if self.runner:
                self.runner.abort()
                if not self.runner.in_cleanup:
                    for i, (fut, _) in list(self.asks.items()):
                        if not fut.done():
                            fut.set_exception(Abort('Aborted'))
        elif t == 'answer':
            a = self.asks.get(m.get('id'))
            if a and not a[0].done():
                a[0].set_result(m.get('value'))

    async def connection(self, ws):
        origin = ws.request.headers.get('Origin')
        if origin not in ORIGINS:
            await ws.close(4403, 'This page may not use the bench bridge')
            return
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), 10))
        except Exception:
            return
        if hello.get('type') != 'hello' or not secrets.compare_digest(str(hello.get('token', '')), self.code):
            await ws.send(json.dumps({'type': 'unpaired'}))
            await ws.close(4401, 'Pairing code needed')
            return
        old, self.client = self.client, ws
        if old:
            await old.close(4000, 'Another page took over the bridge')
        running = bool(self.run_task and not self.run_task.done())
        await self.send({'type': 'ready', 'version': __version__, 'running': running, 'hash': self.hash,
                         'bench': (self.bench or {}).get('id'), 'targets': await self.targets() if self.runner and not running else {}})
        if running:
            for ev in list(self.events):
                await self.send(ev)
        for _, (_, ask) in list(self.asks.items()):
            await self.send(ask)
        try:
            async for raw in ws:
                try:
                    await self.handle(json.loads(raw))
                except Exception as e:
                    await self.send({'type': 'error', 'msg': str(e)})
        finally:
            if self.client is ws:
                self.client = None


async def serve(port=PORT):
    from websockets.asyncio.server import serve as ws_serve
    code = pairing_code()
    station = load_station()
    b = Bridge(code, station)
    b.loop, b.loop_thread = asyncio.get_running_loop(), threading.get_ident()
    print('Plumb bench bridge %s on ws://127.0.0.1:%d' % (__version__, port), flush=True)
    print('Pairing code: %s  (enter it once in Plumb: Bench bridge, Pair)' % code, flush=True)
    if station:
        print('Station addresses (station.json): ' + ', '.join('%s=%s' % kv for kv in station.items()), flush=True)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
        except (NotImplementedError, RuntimeError):
            pass
    async with ws_serve(b.connection, '127.0.0.1', port, max_size=2 ** 22):
        try:
            await stop
        except asyncio.CancelledError:
            pass
        finally:
            await shutdown(b)


async def shutdown(b):
    """Ctrl+C: a run that's going is aborted and its cleanup runs before the bridge exits."""
    if b.run_task and not b.run_task.done():
        print('Stopping: aborting the run, then cleanup …', flush=True)
        b.runner.abort()
        for _, (fut, _) in list(b.asks.items()):
            if not fut.done():
                fut.set_result(False)
        try:
            await asyncio.wait_for(b.run_task, 60)
        except Exception:
            pass
    if b.runner:
        b.runner.close()
