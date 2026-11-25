"""Simulated instruments and devices, so the bridge runs end to end with no bench.

    ScpiPsuSim       a bench supply speaking SCPI on a TCP port (OUTP, VOLT, CURR, MEAS:VOLT?, MEAS:CURR?)
    JsonCrcDevice    a device streaming {JSON}|CRC-16 telemetry over TCP, answering commands with acks; the
                     behavior is a model object, so a bench can bring its own (ThermostatModel is the made-up demo)

A device reached at socket://127.0.0.1:PORT looks to the bridge exactly like one on a COM port. A model's
`reboot()` drops the connection and refuses new ones for a while, as a board restarting off USB would.
"""
import socket
import threading
import time

from .ifaces import frame, unframe


class _Server:
    def __init__(self, port, host='127.0.0.1'):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._accept, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.stop.set()
        try:
            self.sock.close()
        except OSError:
            pass

    def _accept(self):
        while not self.stop.is_set():
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(c,), daemon=True).start()


class ScpiPsuSim(_Server):
    """A supply with a resistive load (`load_ohms`, or a callable for a load that changes) and a current limit."""

    def __init__(self, port=0, load_ohms=400.0):
        super().__init__(port)
        self.on, self.v, self.ilim, self.load = False, 0.0, 3.0, load_ohms

    def out(self):
        if not self.on:
            return 0.0, 0.0
        r = self.load() if callable(self.load) else self.load
        i = self.v / r if r > 0 else self.ilim
        if i > self.ilim:                       # constant current: the voltage sags
            return self.ilim * r, self.ilim
        return self.v, i

    def _serve(self, c):
        f = c.makefile('rwb', buffering=0)
        try:
            for raw in f:
                cmd = raw.decode().strip()
                u = cmd.upper()
                if u.startswith('OUTP '):
                    self.on = u.split()[1] in ('ON', '1')
                elif u.startswith('VOLT '):
                    self.v = float(cmd.split()[1])
                elif u.startswith('CURR '):
                    self.ilim = float(cmd.split()[1])
                elif u == 'MEAS:VOLT?':
                    f.write(b'%.4f\n' % self.out()[0])
                elif u == 'MEAS:CURR?':
                    f.write(b'%.5f\n' % self.out()[1])
                elif u == '*IDN?':
                    f.write(b'Plumb,SimPSU,0,1.0\n')
        except OSError:
            pass
        finally:
            c.close()


class JsonCrcDevice(_Server):
    """Streams model.telemetry() every `period` s to the connected host, and answers each command line."""

    def __init__(self, model, port=0, period=0.01):
        super().__init__(port)
        self.model, self.period, self.client, self.down_until, self.lock = model, period, None, 0.0, threading.Lock()
        model.device = self
        threading.Thread(target=self._stream, daemon=True).start()

    def reboot(self, off_for=1.5):
        """Drop off USB and come back: the connection closes and new ones are refused until the board is up."""
        self.down_until = time.monotonic() + off_for
        c, self.client = self.client, None
        if c:
            try:
                c.shutdown(socket.SHUT_RDWR)
                c.close()
            except OSError:
                pass

    def _serve(self, c):
        if time.monotonic() < self.down_until:
            c.close()
            return
        with self.lock:
            if self.client:
                try:
                    self.client.close()
                except OSError:
                    pass
            self.client = c
        buf = b''
        try:
            while True:
                chunk = c.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b'\n' in buf:
                    line, _, buf = buf.partition(b'\n')
                    obj = unframe(line)
                    if not isinstance(obj, dict):
                        continue
                    ack = self.model.command(obj)
                    if ack is not None:
                        self.send(ack)
        except OSError:
            pass
        finally:
            if self.client is c:
                self.client = None
            try:
                c.close()
            except OSError:
                pass

    def send(self, obj):
        c = self.client
        if c:
            try:
                with self.lock:
                    c.sendall(frame(obj))
            except OSError:
                pass

    def _stream(self):
        while not self.stop.is_set():
            t = time.monotonic()
            if time.monotonic() >= self.down_until:
                self.model.tick()
                if self.client:
                    self.send(self.model.telemetry())
                    for s in self.model.streams():
                        self.send(s)
            time.sleep(max(0.0, self.period - (time.monotonic() - t)))


class ThermostatModel:
    """The made-up Smart Thermostat's main board (Acme Climate), for the demo and the bridge's own tests."""

    def __init__(self):
        self.device = None
        self.boot = time.monotonic()
        self.setpoint, self.temp, self.relays, self.fault = 21.0, 22.5, [0, 0], 0

    def tick(self):
        self.temp += (self.setpoint - self.temp) * 0.001

    def telemetry(self):
        return {'elapsedSec': round(time.monotonic() - self.boot, 3), 'state': 'RUN', 'temp': round(self.temp, 2),
                'setpoint': self.setpoint, 'relay1': self.relays[0], 'relay2': self.relays[1], 'rail_3v3': 3.301,
                'faultFlags': self.fault}

    def streams(self):
        return []

    def command(self, m):
        t, i = m.get('cmd'), m.get('id')
        ok = lambda msg='': {'ack': i, 'status': 'success', 'msg': msg}  # noqa: E731
        if t == 'ping':
            return ok('pong')
        if t == 'setPoint':
            self.setpoint = float(m.get('t', self.setpoint))
            return ok()
        if t == 'relay':
            self.relays[int(m.get('n', 1)) - 1] = 1 if str(m.get('state')) in ('on', '1') else 0
            return ok()
        if t == 'reboot':
            self.boot = time.monotonic() + 1.0
            self.device.reboot(1.0)
            return None
        return None        # unknown: silence, as many devices do
