"""The bench bridge's command line (normally started through bridge/run.py).

    serve                         the bridge for the Plumb page (the default)
    run BENCH.json [--tests A,B] [--operator console|yes|no]
                                  runs tests with no browser; a bench file is what plumb_data keeps
    check BENCH.json              reads a bench as the page would and lists any problems
    sim [--psu PORT] [--dev PORT] the simulated supply and thermostat board, for trying the bridge with no bench
    conformance                   writes tests/conformance/python.json (the page's test page compares with it)
"""
import asyncio
import json
import sys

from . import lang


def _bench(path):
    d = json.load(open(path, encoding='utf-8'))
    b = d.get('bench', d)
    return d.get('meta', {}).get('name', path), b.get('defs', ''), b.get('script', '')


def _opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        v = argv[i + 1] if i + 1 < len(argv) else default
        del argv[i:i + 2]
        return v
    return default


def check(path):
    name, defs, script = _bench(path)
    d, tree = lang.parse_defs(defs), lang.parse_script(script)
    issues = lang.lint(tree, d)
    print('%s: %d targets, %d tests' % (name, len(d['targets']), len(tree['tests'])))
    for e in d['errors']:
        print('  definitions line %d: %s' % (e['line'], e['msg']))
    for idx, msgs in sorted(issues.items()):
        print('  script line %d: %s (%s)' % (idx + 1, '; '.join(msgs), tree['lines'][idx]['text']))
    return 1 if d['errors'] or issues else 0


def run(path, argv):
    from .runner import Runner
    from .server import load_station
    ids = _opt(argv, '--tests')
    mode = _opt(argv, '--operator', 'console')
    name, defs, script = _bench(path)

    async def operator(msg, choices):
        if mode == 'yes':
            return choices[0][1]
        if mode == 'no':
            return choices[-1][1]
        labels = '/'.join(c[0] for c in choices)
        while True:
            a = (await asyncio.to_thread(input, '\n>>> %s [%s] ' % (msg, labels))).strip().lower()
            for lab, val in choices:
                if a and lab.lower().startswith(a):
                    return val

    def emit(ev):
        if ev['type'] == 'log':
            from .server import say
            say('[%s] %s' % (ev['kind'], ev['text']))

    r = Runner(defs, script, station=load_station(), emit=emit, operator=operator)

    async def go():
        task = asyncio.create_task(r.run(ids.split(',') if ids else None))
        try:
            return await asyncio.shield(task)
        except (KeyboardInterrupt, asyncio.CancelledError):
            r.abort()
            return await task
    try:
        res = asyncio.run(go())
    finally:
        r.close()
    print('\n%s:' % name)
    for tid, v in res.items():
        print('  %-10s %-8s %s' % (tid, v['verdict'].upper(), v.get('note', '')))
    return 0 if all(v['verdict'] in ('pass', 'skip') for v in res.values()) else 1


def sim(argv):
    import time
    from .sims import JsonCrcDevice, ScpiPsuSim, ThermostatModel
    psu = ScpiPsuSim(int(_opt(argv, '--psu', '5025'))).start()
    dev = JsonCrcDevice(ThermostatModel(), int(_opt(argv, '--dev', '9101'))).start()
    print('Simulated supply (SCPI) on 127.0.0.1:%d; thermostat board (json-crc16) on socket://127.0.0.1:%d' % (psu.port, dev.port))
    print('Ctrl+C stops them.', flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main(argv=None):
    for f in (sys.stdout, sys.stderr):
        try:
            f.reconfigure(errors='replace')
        except Exception:
            pass
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv.pop(0) if argv else 'serve'
    if cmd == 'serve':
        from .server import serve
        try:
            asyncio.run(serve())
        except KeyboardInterrupt:
            pass
        return
    if cmd == 'conformance':
        from . import conformance
        conformance.main()
        return
    if cmd == 'check' and argv:
        sys.exit(check(argv[0]))
    if cmd == 'run' and argv:
        path = argv.pop(0)
        sys.exit(run(path, argv))
    if cmd == 'sim':
        return sim(argv)
    print(__doc__)
