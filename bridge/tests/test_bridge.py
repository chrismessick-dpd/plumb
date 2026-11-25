"""The bridge with no bench: the interfaces against the simulators, and the runner's rules. Run: python -m pytest bridge/tests"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest  # noqa: E402

from plumb_bridge import ifaces, lang  # noqa: E402
from plumb_bridge.runner import Runner  # noqa: E402
from plumb_bridge.sims import JsonCrcDevice, ScpiPsuSim, ThermostatModel  # noqa: E402

DEFS = '''target PSU "Supply"
  interface lan 127.0.0.1:{psu} scpi
  command output state=on|off "OUTP {{state}}"
  command set_voltage v=0..30V "VOLT {{v}}"
  command set_current_limit i=0..5A "CURR {{i}}"
  telemetry voltage V "MEAS:VOLT?"
  telemetry current A "MEAS:CURR?"

target MAIN "Main PCBA"
  interface serial socket://127.0.0.1:{dev} json-crc16
  command ping "msg ping" -> ack
  command set_point t=5..35°C "msg setPoint t={{t}}" -> ack
  command relay n=1..2 state=on|off "msg relay n={{n}} state={{state}}" -> ack
  command reboot "msg reboot"
  command bogus "msg bogus" -> ack
  telemetry state - "field state"
  telemetry uptime s "field elapsedSec"
  telemetry temp °C "field temp"
  telemetry setpoint °C "field setpoint"
  telemetry relay1 - "field relay1"
  telemetry rail_3v3 V "field rail_3v3"
  telemetry fault - "bit faultFlags 2"

target GONE "Not on this bench"
  interface lan 127.0.0.1:1 scpi
  telemetry x - "X?"
'''


@pytest.fixture
def bench():
    psu = ScpiPsuSim(load_ohms=400).start()
    dev = JsonCrcDevice(ThermostatModel()).start()
    yield DEFS.format(psu=psu.port, dev=dev.port), psu, dev
    psu.close()
    dev.close()


def run(defs, script, ids=None, operator=None, bridge_calls=None):
    events = []
    r = Runner(defs, script, emit=events.append, operator=operator, bridge_calls=bridge_calls)
    try:
        res = asyncio.run(r.run(ids))
    finally:
        r.close()
    return res, events, r


def test_crc_check_value():
    assert ifaces.crc16_ccitt_false(b'123456789') == 0x29B1


def test_frame_round_trip_and_bad_crc():
    f = ifaces.frame({'a': 1, 's': 'x|y'})
    assert ifaces.unframe(f) == {'a': 1, 's': 'x|y'}
    assert ifaces.unframe(f[:-3] + b'0\n') is None
    assert ifaces.unframe(b'{"a":1}\n') is None


def test_scpi_supply(bench):
    defs, psu, _ = bench
    t = lang.parse_defs(defs)['targets']['PSU']
    i = ifaces.make(t)
    i.open()
    i.command('set_voltage', 'VOLT 24', {}, None)
    i.command('output', 'OUTP on', {}, None)
    assert abs(i.read(t['telemetry']['voltage']) - 24) < 1e-3
    assert abs(i.read(t['telemetry']['current']) - 0.06) < 1e-4
    i.close()


def test_json_device_telemetry_acks_silence_and_restart(bench):
    defs, _, dev = bench
    t = lang.parse_defs(defs)['targets']['MAIN']
    i = ifaces.make(t)
    i.open()
    time.sleep(0.1)
    assert i.read(t['telemetry']['state']) == 'RUN'
    assert i.command('ping', 'msg ping', {}, 'ack') == 'success'
    assert i.command('set_point', 'msg setPoint t=30', {}, 'ack') == 'success'
    time.sleep(0.05)
    assert i.read(t['telemetry']['setpoint']) == 30
    assert i.read(t['telemetry']['fault']) == 0
    with pytest.raises(ifaces.BridgeError, match='no ACK'):
        i.command('bogus', 'msg bogus', {}, 'ack')
    up = i.read(t['telemetry']['uptime'])
    i.command('reboot', 'msg reboot', {}, None)
    time.sleep(0.6)
    with pytest.raises(ifaces.NoTelemetry):
        i.read(t['telemetry']['state'])
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            if i.read(t['telemetry']['uptime']) < up:
                break
        except ifaces.NoTelemetry:
            pass
        time.sleep(0.05)
    assert i.read(t['telemetry']['uptime']) < up, 'came back with a fresh uptime'
    assert i.reconnects >= 1
    i.close()


def test_a_test_passes_end_to_end(bench):
    defs = bench[0]
    script = '''suite S
  group G
    test PWR-01 Powers up
      PSU.set_current_limit 500 mA
      PSU.set_voltage 24 V
      PSU.output on
      wait until MAIN.state == "RUN" within 5 s
      check PSU.current 40 mA .. 90 mA
      check MAIN.rail_3v3 3.3 V ±3%
      cleanup
        PSU.output off
'''
    res, events, _ = run(defs, script)
    assert res['PWR-01']['verdict'] == 'pass', [e for e in events if e['type'] == 'log']
    steps = [e for e in events if e['type'] == 'step']
    assert [s['idx'] for s in steps] == [3, 4, 5, 6, 7, 8, 10], 'step results carry the line index'


def test_cleanup_order_calls_vars_and_failures(bench):
    defs = bench[0]
    script = '''suite S
  group G
    test A-01 Inner
      PSU.output on
      cleanup
        log "inner cleanup"
    test A-02 Outer
      call A-01
      measure MAIN.setpoint as sp0
      MAIN.set_point 30 °C -> ack
      check ack == "success"
      wait 50 ms
      check MAIN.setpoint == 30 °C
      check MAIN.setpoint == 31 °C
      cleanup
        log "outer cleanup"
        MAIN.set_point $sp0 °C
'''
    res, events, _ = run(defs, script, ['A-02'])
    assert res['A-02']['verdict'] == 'fail'
    logs = [e['text'] for e in events if e['type'] == 'log']
    assert logs.index('outer cleanup') < logs.index('inner cleanup'), "the test's own cleanup runs before a called test's"
    assert any('setPoint t=21' in t for t in logs), 'the kept value went back into the command'


def test_todo_skips_and_unreachable_target_skips(bench):
    defs = bench[0]
    script = '''suite S
  group G
    test T-01 Stub
      log "start"
      todo "later"
    test T-02 Gone
      check GONE.x == 1
'''
    res, _, _ = run(defs, script)
    assert res['T-01'] == dict(res['T-01'], verdict='skip', note='Not written yet')
    assert res['T-02']['verdict'] == 'skip' and 'GONE' in res['T-02']['note']


def test_python_steps_and_bridge_calls(bench):
    defs = bench[0]
    script = '''suite S
  group G
    test P-01 Python
      script
        t0 = tlm('MAIN.uptime')
        wait(200)
        record('dt', tlm('MAIN.uptime') - t0, 's')
      check dt 150 ms .. 400 ms
    test P-02 On the bridge
      script on bridge
        record('size', bridge.drive_size('MAIN'))
      check size == 7
    test P-03 Missing bridge call
      script on bridge
        bridge.nothing_here()
    test P-04 Python error
      script
        x = 1
        y = x / 0
'''
    res, events, _ = run(defs, script, bridge_calls={'drive_size': lambda name: 7})
    assert res['P-01']['verdict'] == 'pass', [e for e in events if e['type'] == 'log']
    assert res['P-02']['verdict'] == 'pass'
    assert res['P-03']['verdict'] == 'error' and 'not on this bench' in res['P-03']['note']
    assert res['P-04']['verdict'] == 'error' and 'line 19' in res['P-04']['note'] and 'ZeroDivisionError' in res['P-04']['note']


def test_operator_and_abort_runs_cleanup(bench):
    defs = bench[0]
    script = '''suite S
  group G
    test O-01 Ask
      ask "Is the LED green?"
    test O-02 Long
      PSU.output on
      wait 5 s
      cleanup
        PSU.output off
'''
    async def no(msg, choices):
        return False
    res, _, _ = run(defs, script, ['O-01'], operator=no)
    assert res['O-01']['verdict'] == 'fail'
    res, _, _ = run(defs, script, ['O-01'])
    assert res['O-01']['verdict'] == 'error' and 'No operator' in res['O-01']['note']

    events = []
    r = Runner(defs, script, emit=events.append)

    async def go():
        task = asyncio.create_task(r.run(['O-02']))
        await asyncio.sleep(0.5)
        r.abort()
        return await task
    try:
        res = asyncio.run(go())
    finally:
        r.close()
    assert res['O-02']['verdict'] == 'aborted'
    assert any(e['type'] == 'log' and 'OUTP off' in e['text'] for e in events), 'cleanup ran after Abort'
    assert bench[1].on is False
