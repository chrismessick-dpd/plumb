"""The bridge's WebSocket side, against the simulators, as the page uses it. Run with the bridge's own Python:

    bridge/.venv/Scripts/python bridge/tests/server_check.py      (bridge/.venv/bin/python elsewhere)

Checks: Origin and pairing refusals; a script's log() reaching the page; Abort during an operator question (the
test aborts, its cleanup runs, the page is told the question is gone); a page that disconnects mid-run and comes
back (the run carries on, its events replay, a waiting question is asked again).
"""
import asyncio
import json
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from websockets.asyncio.client import connect  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

from plumb_bridge.server import Bridge  # noqa: E402
from plumb_bridge.sims import JsonCrcDevice, ScpiPsuSim, ThermostatModel  # noqa: E402

ORIGIN = 'http://localhost:8774'
CODE = '424242'
FAILS = []


def ok(cond, name, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else ': ' + str(detail)), flush=True)
    if not cond:
        FAILS.append(name)


async def recv_until(ws, pred, timeout=15):
    seen = []
    async def loop():
        while True:
            m = json.loads(await ws.recv())
            seen.append(m)
            if pred(m):
                return m
    try:
        return await asyncio.wait_for(loop(), timeout), seen
    except asyncio.TimeoutError:
        return None, seen


async def hello(port):
    ws = await connect('ws://127.0.0.1:%d' % port, origin=ORIGIN)
    await ws.send(json.dumps({'type': 'hello', 'token': CODE}))
    return ws


async def load(ws, defs, script):
    await ws.send(json.dumps({'type': 'load', 'bench': {'id': 'b', 'name': 'b', 'defs': defs, 'script': script}}))
    m, _ = await recv_until(ws, lambda m: m['type'] == 'loaded')
    return m


async def main():
    psu, dev = ScpiPsuSim().start(), JsonCrcDevice(ThermostatModel()).start()
    defs = '''target PSU "Supply"
  interface lan 127.0.0.1:%d scpi
  command output state=on|off "OUTP {state}"
  telemetry current A "MEAS:CURR?"
target MAIN "Board"
  interface serial socket://127.0.0.1:%d json-crc16
  telemetry state - "field state"
target LATER "A board not on USB yet"
  interface serial socket://127.0.0.1:1 json-crc16
  telemetry state - "field state"
''' % (psu.port, dev.port)
    script = '''suite S
  group G
    test L-01 Logs from Python
      script
        log('hello from python')
    test A-01 Abort while asking
      PSU.output on
      ask "Waiting forever?"
      cleanup
        PSU.output off
    test D-01 Survives a disconnect
      wait 2 s
      ask "Still there?"
      check MAIN.state == "RUN"
'''
    b = Bridge(CODE, {})
    b.loop, b.loop_thread = asyncio.get_running_loop(), threading.get_ident()
    async with serve(b.connection, '127.0.0.1', 0) as srv:
        port = srv.sockets[0].getsockname()[1]

        try:
            async with connect('ws://127.0.0.1:%d' % port, origin='https://elsewhere.example') as ws:
                await ws.recv()
            ok(False, 'another origin is refused')
        except Exception as e:
            ok('4403' in str(e), 'another origin is refused', e)
        async with connect('ws://127.0.0.1:%d' % port, origin=ORIGIN) as ws:
            await ws.send(json.dumps({'type': 'hello', 'token': '000000'}))
            ok(json.loads(await ws.recv())['type'] == 'unpaired', 'a wrong pairing code is refused')

        ws = await hello(port)
        ready, _ = await recv_until(ws, lambda m: m['type'] == 'ready')
        ok(ready is not None, 'paired')
        loaded = await load(ws, defs, script)
        t = loaded['targets']
        ok(t['MAIN']['ok'] and not t['MAIN']['waiting'], 'a connected device reads as connected', t['MAIN'])
        ok(t['LATER']['ok'] and t['LATER']['waiting'], 'a device not on USB yet reads as waiting, not missing', t['LATER'])

        await ws.send(json.dumps({'type': 'run', 'ids': ['L-01'], 'hash': loaded['hash']}))
        end, seen = await recv_until(ws, lambda m: m['type'] == 'run' and m['state'] == 'ended')
        ok(any(m['type'] == 'log' and m['text'] == 'hello from python' for m in seen), "a script's log() reaches the page")

        await ws.send(json.dumps({'type': 'run', 'ids': ['A-01'], 'hash': loaded['hash']}))
        ask, _ = await recv_until(ws, lambda m: m['type'] == 'ask')
        await ws.send(json.dumps({'type': 'abort'}))
        end, seen = await recv_until(ws, lambda m: m['type'] == 'run' and m['state'] == 'ended')
        ok(end and end['results'].get('A-01') == 'aborted', 'Abort ends a test waiting on a question', end)
        ok(any(m['type'] == 'ask-done' and m['id'] == ask['id'] for m in seen), 'the page is told the question is gone')
        ok(any(m['type'] == 'log' and 'OUTP off' in m['text'] for m in seen) and not psu.on, 'its cleanup ran')

        await ws.send(json.dumps({'type': 'run', 'ids': ['D-01'], 'hash': loaded['hash']}))
        await recv_until(ws, lambda m: m['type'] == 'test' and m['result']['verdict'] == 'running')
        await ws.close()                                   # the page goes away mid-test
        await asyncio.sleep(2.5)                           # the run reaches its question meanwhile
        ws = await hello(port)
        ready, seen = await recv_until(ws, lambda m: m['type'] == 'ask')
        ok(any(m['type'] == 'ready' and m['running'] for m in seen), 'a returning page hears a run is going')
        ok(any(m['type'] == 'step' for m in seen), "and gets the run's events so far")
        ok(ready is not None and ready['msg'] == 'Still there?', 'and the waiting question again', ready)
        await ws.send(json.dumps({'type': 'answer', 'id': ready['id'], 'value': True}))
        end, _ = await recv_until(ws, lambda m: m['type'] == 'run' and m['state'] == 'ended')
        ok(end and end['results'].get('D-01') == 'pass', 'and the run finishes', end)
        await ws.close()
    if b.runner:
        b.runner.close()
    psu.close()
    dev.close()
    print('%d failed' % len(FAILS))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
