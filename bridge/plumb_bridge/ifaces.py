"""Interfaces: how the bridge reaches each target, chosen by the target's `interface` line.

    interface lan HOST:PORT scpi           SCPI over a plain TCP socket (port 5025 on most instruments); no VISA
    interface serial PORT BAUD line        a text line out, a text line back, for a query or a command with -> name
    interface serial PORT json-crc16 [k=v …]   {JSON}|CRC-16 lines both ways: streamed telemetry, acks matched by id

PORT is a COM port, `usb VID:PID` (found by its USB IDs), or any pyserial URL such as socket://127.0.0.1:9101
(how the simulators and tests reach a device with no hardware). A station file can give each target its address
on this bench (station.json beside the bridge, git-ignored: {"PSU": "10.0.0.7:5025", "GEN": "COM5"}), so a
bench's text stays the same at every station.

Each interface has open(), close(), command(cmd, wire, wire_vals, returns) and read(point): blocking calls the
runner makes from a worker thread.
"""
import json
import re
import socket
import threading
import time

from .lang import parse_qty


class BridgeError(Exception):
    pass


class NoTelemetry(BridgeError):
    """Nothing fresh to read: the device isn't streaming (or has dropped off USB). `wait until` keeps polling."""


def crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def frame(obj) -> bytes:
    body = json.dumps(obj, separators=(',', ':')).encode()
    return body + b'|%04X\n' % crc16_ccitt_false(body)


def unframe(line: bytes):
    """One received line → the object, or None if the framing or CRC is bad."""
    line = line.rstrip(b'\r\n')
    i = line.rfind(b'|')
    if i < 0 or len(line) - i - 1 != 4:
        return None
    body, crc = line[:i], line[i + 1:]
    try:
        if int(crc, 16) != crc16_ccitt_false(body):
            return None
        return json.loads(body)
    except ValueError:
        return None


def number_or_text(s):
    s = s.strip()
    try:
        return float(s) if re.match(r'^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$', s) else s
    except ValueError:
        return s


def resolve_port(port):
    """A COM port, a pyserial URL, or `usb VID:PID` found among the connected devices."""
    m = re.match(r'^usb\s+([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})$', port)
    if not m:
        return port
    from serial.tools import list_ports
    vid, pid = int(m.group(1), 16), int(m.group(2), 16)
    for p in list_ports.comports():
        if p.vid == vid and p.pid == pid:
            return p.device
    raise BridgeError('No USB device %s:%s connected' % (m.group(1).upper(), m.group(2).upper()))


# ---------------------------------------------------------------- SCPI over LAN
class ScpiLan:
    def __init__(self, address, timeout=2.0):
        host, _, port = address.rpartition(':')
        self.addr = (host or address, int(port) if port.isdigit() else 5025)
        self.timeout, self.sock, self.buf, self.lock = timeout, None, b'', threading.Lock()

    def open(self):
        if self.sock is None:
            self.sock = socket.create_connection(self.addr, timeout=self.timeout)
            self.buf = b''

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _line(self):
        while b'\n' not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise BridgeError('%s:%d closed the connection' % self.addr)
            self.buf += chunk
        line, _, self.buf = self.buf.partition(b'\n')
        return line.decode(errors='replace').strip()

    def query(self, text, answer):
        with self.lock:
            try:
                self.open()
                self.sock.sendall(text.encode() + b'\n')
                return self._line() if answer else None
            except (OSError, socket.timeout) as e:
                self.close()
                raise BridgeError('%s:%d: %s' % (self.addr[0], self.addr[1], e)) from None

    def command(self, cmd, wire, vals, returns):
        r = self.query(wire, bool(returns) or wire.rstrip().endswith('?'))
        return number_or_text(r) if r is not None else None

    def read(self, point):
        return number_or_text(self.query(point['query'], True))


# ---------------------------------------------------------------- a text line each way over serial
class SerialLine:
    def __init__(self, port, baud=115200, timeout=2.0):
        self.port, self.baud, self.timeout, self.ser, self.lock = port, baud, timeout, None, threading.Lock()

    def open(self):
        if self.ser is None:
            import serial
            self.ser = serial.serial_for_url(resolve_port(self.port), baudrate=self.baud, timeout=self.timeout)

    def close(self):
        if self.ser:
            try:
                self.ser.close()
            finally:
                self.ser = None

    def query(self, text, answer):
        with self.lock:
            try:
                self.open()
                self.ser.reset_input_buffer()
                self.ser.write(text.encode() + b'\n')
                if not answer:
                    return None
                line = self.ser.readline()
                if not line:
                    raise BridgeError('%s: no answer to %s' % (self.port, text))
                return line.decode(errors='replace').strip()
            except OSError as e:
                self.close()
                raise BridgeError('%s: %s' % (self.port, e)) from None

    def command(self, cmd, wire, vals, returns):
        r = self.query(wire, bool(returns))
        return number_or_text(r) if r is not None else None

    def read(self, point):
        return number_or_text(self.query(point['query'], True))


# ---------------------------------------------------------------- {JSON}|CRC-16 lines, streamed telemetry
class JsonCrc:
    """A device that streams telemetry lines and answers each command with an ack carrying the command's id.

    The JSON key names are the device's own, given on the interface line, with these defaults:
      cmd=cmd      the key naming the command          id=id        the key carrying the command's number
      ack=ack      the key an ack answers that number  status=status, reply=msg  the ack's result and text
      tag=stream   the key naming a tagged stream
    Untagged lines are telemetry (every key a field); tagged lines are kept per stream; acks are matched to the
    command's number. A reader thread keeps the latest of each and reopens the port if the device drops off USB (a
    restart), clearing what it knew so nothing stale reads as live.

    Point queries: `field X`, `field X ÷N` (sent as N times its value), `field X & 0xMASK`, `bit X N`, and
    `T X` for stream T. A command's wire `msg NAME k={k} …` becomes {cmd: NAME, id: n, "k": value, …}; a value of
    several `a=b` words ("a=1 b=2") spreads into its fields.
    """
    KEYS = {'cmd': 'cmd', 'id': 'id', 'ack': 'ack', 'status': 'status', 'reply': 'msg', 'tag': 'stream'}
    STALE = 0.5      # s: a field older than this isn't read as live
    ACK_WAIT = 1.0   # s

    def __init__(self, port, baud=115200, keys=None):
        self.port, self.baud = port, baud
        self.k = dict(self.KEYS, **(keys or {}))
        self.ser, self.thread, self.stop = None, None, threading.Event()
        self.lock, self.cond = threading.Lock(), threading.Condition()
        self.fields, self.at, self.streams, self.acks = {}, 0.0, {}, {}
        self.next_id, self.bad_frames, self.reconnects, self.wlock = 1, 0, 0, threading.Lock()
        self.connected = False

    def open(self):
        if self.thread is None:
            self.stop.clear()
            self.thread = threading.Thread(target=self._reader, name='json-crc16 ' + self.port, daemon=True)
            self.thread.start()
        # Never fails: a board the bench supply powers isn't on USB until a test turns the supply on. A short wait
        # catches one that's already there; after that the reader keeps trying, and `connected` says which.
        deadline = time.monotonic() + 0.5
        while not self.connected and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(2)
        self.thread = None
        self._drop()

    def _drop(self):
        s, self.ser = self.ser, None
        if s:
            try:
                s.close()
            except Exception:
                pass
        if self.connected:
            self.connected = False
            with self.cond:
                self.fields, self.at, self.streams = {}, 0.0, {}

    def _reader(self):
        import serial
        buf = b''
        while not self.stop.is_set():
            if self.ser is None:
                try:
                    self.ser = serial.serial_for_url(resolve_port(self.port), baudrate=self.baud, timeout=0.05)
                    self.connected, buf = True, b''
                except Exception:
                    time.sleep(0.25)
                    continue
            try:
                chunk = self.ser.read(4096)
            except Exception:
                self._drop()
                self.reconnects += 1
                continue
            if not chunk:
                continue
            buf += chunk
            while b'\n' in buf:
                line, _, buf = buf.partition(b'\n')
                self._line(line)

    def _line(self, line):
        obj = unframe(line)
        if not isinstance(obj, dict):
            self.bad_frames += 1
            return
        now = time.monotonic()
        with self.cond:
            if self.k['ack'] in obj:
                self.acks[obj[self.k['ack']]] = obj
            elif self.k['tag'] in obj:
                self.streams[obj[self.k['tag']]] = (obj, now)
            else:
                self.fields, self.at = obj, now
            self.cond.notify_all()

    RECONNECT_WAIT = 3.0  # s: a command waits this long for a device that's coming back on USB

    def _send(self, obj):
        deadline = time.monotonic() + self.RECONNECT_WAIT
        while self.ser is None and time.monotonic() < deadline:
            time.sleep(0.02)
        with self.wlock:
            if self.ser is None:
                raise BridgeError('%s is not connected' % self.port)
            try:
                self.ser.write(frame(obj))
            except Exception as e:
                self._drop()
                raise BridgeError('%s: %s' % (self.port, e)) from None

    @staticmethod
    def _value(v):
        if isinstance(v, (int, float)):
            return v
        q = parse_qty(v) if isinstance(v, str) else None
        if q and not q['unit']:
            f = q['v']
            return int(f) if f == int(f) and re.match(r'^[-+]?\d+$', v.strip()) else f
        return v

    def command(self, cmd, wire, vals, returns):
        m = re.match(r'^msg\s+(\w+)\s*(.*)$', wire)
        if not m:
            raise BridgeError('%s: a json-crc16 command is written "msg NAME k={k}", not %r' % (self.port, wire))
        with self.lock:
            msg_id = self.next_id
            self.next_id += 1
        obj = {self.k['cmd']: m.group(1), self.k['id']: msg_id}
        for tok in re.findall(r'(\w+)=("[^"]*"|\S+)', m.group(2)):
            k, v = tok[0], tok[1].strip('"')
            obj[k] = self._value(v)
        self._send(obj)
        if not returns:
            return None
        deadline = time.monotonic() + self.ACK_WAIT
        with self.cond:
            while msg_id not in self.acks:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise BridgeError('%s: no ACK to %s' % (self.port, m.group(1)))
                self.cond.wait(left)
            ack = self.acks.pop(msg_id)
        return ack.get(self.k['reply'], '') if returns == 'id' else ack.get(self.k['status'], '')

    def read(self, point):
        q = point['query'].strip()
        m = re.match(r'^(\w+)\s+(\w+)(?:\s*÷\s*(\d+(?:\.\d+)?))?(?:\s*&\s*(0x[0-9A-Fa-f]+|\d+))?$', q)
        b = re.match(r'^bit\s+(\w+)\s+(\d+)$', q)
        if b:
            v = self._field('field', b.group(1))
            return (int(v) >> int(b.group(2))) & 1
        if not m:
            raise BridgeError('Can\'t read the query "%s"' % q)
        src, key, div, mask = m.groups()
        v = self._field(src, key)
        if mask:
            v = int(v) & int(mask, 0)
        if div:
            v = v / float(div)
        return v

    def _field(self, src, key):
        # Wait up to the stale window for a fresh line (just after connecting, or between lines), then judge.
        deadline = time.monotonic() + self.STALE
        with self.cond:
            while True:
                obj, at = (self.fields, self.at) if src == 'field' else self.streams.get(src, ({}, 0.0))
                now = time.monotonic()
                if (obj and now - at <= self.STALE) or now >= deadline:
                    break
                self.cond.wait(min(0.05, deadline - now))
        if not obj or now - at > self.STALE:
            raise NoTelemetry('No %s from %s' % ('telemetry' if src == 'field' else src + ' packets', self.port))
        if key not in obj:
            raise BridgeError('%s sends no %s' % (self.port, key))
        return obj[key]


def make(target, station=None):
    """The interface for a target from its definition, with the station's address if it gives one."""
    iface = target.get('iface')
    if not iface:
        raise BridgeError(target['name'] + ' has no interface line')
    kind, parts = iface['type'], [p for p in iface['parts'] if p]
    addr = (station or {}).get(target['name'])
    if kind == 'lan' and parts[-1:] == ['scpi']:
        return ScpiLan(addr or parts[0])
    if kind == 'serial':
        if 'json-crc16' in parts:
            at = parts.index('json-crc16')
            keys = dict(p.split('=', 1) for p in parts[at + 1:] if '=' in p)
            bad = sorted(set(keys) - set(JsonCrc.KEYS))
            if bad:
                raise BridgeError('%s: json-crc16 has no option %s' % (target['name'], ', '.join(bad)))
            return JsonCrc(addr or ' '.join(parts[:at]), keys=keys)
        mode = parts[-1] if parts else ''
        if mode == 'line':
            port = addr or parts[0]
            baud = int(parts[1]) if len(parts) > 2 and parts[1].isdigit() else 115200
            return SerialLine(port, baud)
    raise BridgeError('%s: this bridge has no driver for "interface %s" yet' % (target['name'], iface['text'].strip()))
