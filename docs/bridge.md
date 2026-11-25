# The bench bridge

The bench bridge is a small Python program on the bench PC. It reaches the real targets (supplies, instruments,
and the board under test) and runs a bench's tests against them. The Plumb page sends it the open bench and shows
the run live. Without the bridge, Plumb's runs are simulated in the page.

Decided with Chris (2026-11-24):
- **The bridge runs the tests.** It has its own copy of Plumb's step language in Python, so a closed tab can't
  skip a cleanup, the same runner works with no browser, and `script on bridge` steps run where they can reach a
  debug probe, a mounted drive, or files on disk.
- **Nothing to install by hand, and no VISA.** One command sets it up the first time.

## Starting it

```
python bridge/run.py
```

The first run creates a private Python environment beside it (`bridge/.venv`, git-ignored). It installs two
pinned packages into that environment, nowhere else: `websockets` for the page's link, and `pyserial` for serial
and USB serial ports (`bridge/requirements.txt`). Later runs start at once. It needs Python 3.10 or newer.

It prints a **pairing code**. In Plumb, the bench panel's Bridge row has Connect, then Pair with that code; the
page remembers it. The code is kept in `bridge/.pairing` (git-ignored), so it stays the same between starts until
that file is deleted. Ctrl+C stops the bridge; a run that's going is meant to abort first and run its cleanup
(not yet tried on Windows, where Python delivers Ctrl+C differently: check it at the first hardware session).

Other commands: `python bridge/run.py run BENCH.json --tests PWR-01,PWR-02 --operator console` runs tests with no
browser (a bench file is what `plumb_data` keeps). `check BENCH.json` reads a bench and lists problems. `sim`
starts the simulated supply and board.

## Who may use it

The bridge runs test steps, including their Python, on the bench PC, so:
- it listens on 127.0.0.1 only, so nothing on the network reaches it;
- it takes connections only from Plumb's own pages (the hosted page, or a local server on 8774 or 8771), by the
  browser's Origin header, so another website open in the same browser can't drive it;
- the page must give the pairing code before anything else;
- it never fetches a bench itself. It runs exactly the text the page sent, and refuses a run whose text has
  changed since it was loaded (both sides compare a SHA-256 of the definitions and the script).

## How the page and the bridge talk

There is one WebSocket, `ws://127.0.0.1:47615`, with JSON messages both ways.

| From | Message | Meaning |
| --- | --- | --- |
| page | `hello {token}` | the pairing code |
| page | `load {bench: {id, name, defs, script}}` | the bench the page shows; the bridge answers `loaded {hash, targets}` |
| page | `run {ids, hash}` | runs those tests (all, in order, when `ids` is empty) |
| page | `abort` | stops at the next step; cleanup still runs |
| page | `answer {id, value}` | the operator's answer to an `ask` |
| page | `attach` | tries the targets again; answered with `targets` |
| bridge | `ready {version, running, targets}` | paired; `running` when a run is already going |
| bridge | `log`, `step`, `test`, `current`, `run` | the runner's events: log lines, a step's result by its line index, a test's result, the step running, a run starting or ending |
| bridge | `ask {id, msg, choices}` | an operator step |
| bridge | `error {msg}`, `unpaired` | |

A step's result carries its line index in the script, as the page's rows do, so the page draws the bridge's
results on the same rows. **A page that closes doesn't stop a run.** Only Abort or Ctrl+C stops it, and cleanup
still runs. A page that comes back gets the run's events so far and any question still waiting.

## Targets and interfaces

The bridge picks a driver from each target's `interface` line:

| Interface | Driver |
| --- | --- |
| `interface lan HOST:PORT scpi` | SCPI over a plain TCP socket (port 5025 on most instruments). A command whose wire text ends in `?`, or that has `-> name`, reads one line back; a telemetry point's query is sent and its answer read. |
| `interface serial PORT BAUD line` | A text line out, and a text line back for a query or a command with `-> name`. |
| `interface serial PORT json-crc16 [k=v …]` | A device that streams `{JSON}|CRC` lines (CRC-16/CCITT-FALSE, in hex). See below. |
| anything else (`usb usbtmc`, `usb sigrok`, `bridge …`) | Not yet. The target reads as unreachable and its tests skip, saying why. |

`PORT` is a COM port, `usb VID:PID` (found among the connected devices by its USB IDs), or a pyserial URL such
as `socket://127.0.0.1:9101`. A URL is how the simulators and tests reach a "device" with no hardware.

**Station addresses.** A bench's text names the addresses one station uses. Another station can give its own in
`bridge/station.json` (git-ignored), so the bench text never changes:

```json
{ "PSU": "10.0.0.7:5025", "GEN": "COM5" }
```

**A target that can't be reached** makes its tests skip ("Needs PSU, which isn't reachable"), with the reason in
the log and on the bench panel's chips. A target that answers wrongly fails or errors the test.

**A device that isn't on USB yet** (a board the bench supply powers) is not missing: the bridge keeps looking for
it, its chip shows `… GEN` ("waiting for the device"), and its tests run, since their first steps usually power it
up.

### The JSON + CRC device

The JSON key names are the device's own, given as options after `json-crc16`; these are the defaults:

| Option | Default | The key that |
| --- | --- | --- |
| `cmd=` | `cmd` | names the command |
| `id=` | `id` | carries the command's number |
| `ack=` | `ack` | an ack answers that number with |
| `status=` | `status` | holds the ack's result |
| `reply=` | `msg` | holds the ack's text |
| `tag=` | `stream` | names a tagged stream |

So a device whose acks are `{"answer": 7, …}` is `interface serial COM5 json-crc16 ack=answer`.

A reader thread keeps the latest of everything the device streams:
- **Telemetry lines** (no tag, no ack key): every key is a field.
- **Tagged lines** (`"stream": "status"` and so on): kept per stream.
- **Acks**: matched to the command's number.

A command's wire text `msg NAME k={k} …` is sent as `{"cmd": NAME, "id": n, "k": value, …}` (with the device's
key names). A value made of several `a=b` words (`"setpoint=45 slope=40"`) spreads into its fields. With
`-> ack` the command waits up to 1 s for its ack and returns the result (such as `success` or `error`); with
`-> id` it returns the ack's text. Without a return it doesn't wait (a restart command, whose answer is the board
leaving USB).

Point queries:

| Query | Reads |
| --- | --- |
| `field X` | the latest `X` |
| `field X ÷N` | `X` divided by N (a value sent as N times itself) |
| `field X & 0xMASK` | `X` with the mask applied |
| `bit X N` | bit N of `X`, as 0 or 1 |
| `T X` | `X` from the latest line of stream `T`, such as `status linkUp` |

**Staleness and restarts.** A value older than 0.5 s doesn't read as live: a read waits up to that long for a
fresh line, then fails with "No telemetry". `wait until` keeps polling through that, and `check` fails. When the
device drops off USB (a restart, a power cycle), the reader forgets everything it had and reopens the port as soon
as the device is back. A command waits up to 3 s for it to come back.

## Kept in step with the page

`bridge/plumb_bridge/lang.py` is a line-for-line port of the page's parser. `tests/conformance/corpus.json`
holds the cases: the demo bench, synthetic benches, steps, conditions, quantities, and number formats.
`python -m plumb_bridge conformance` (run from `bridge/`) writes the bridge's answers to
`tests/conformance/python.json`, and the page's test page (`tests/test.html`) checks that its own answers are the
same. **After a change to the step language on either side, change the other, rerun conformance, and rerun the
test page.**

## Tests

- `python -m pytest bridge/tests`: CRC, the SCPI and JSON drivers against the simulators (a restart and
  reconnect too), and the runner's rules (cleanup order, `call`, `$name`, `todo`, operator steps, Python steps,
  Abort running cleanup, an unreachable target skipping). Run it with a Python that has pytest; the bridge's own
  `.venv` doesn't.
- `bridge/.venv/Scripts/python bridge/tests/server_check.py`: the WebSocket side as the page uses it, against the
  simulators (origin and pairing refusals, a script's `log()` reaching the page, Abort during an operator question,
  and a page that disconnects mid-run and comes back). 13 checks.
- `tests/test.html`: the page's sync tests and the conformance check.

Everything so far has run against simulators only. The first hardware session should check: the hosted page
connecting to the bridge (Chrome may ask to allow access to devices on the local network), a real COM port
appearing and disappearing with the supply, Ctrl+C on Windows, and the real instruments' SCPI.

## Not yet

- The **Bench** and **Telemetry and commands** tabs still read the page's simulation. They should read the bridge
  (live points, and a command sender) while it's connected.
- USB instruments (USBTMC), sigrok logic analyzers, and debug probes. `script on bridge` steps can use them through
  `bridge.*` calls once a bench provides them; a call a bench doesn't provide fails, saying so.
- Stored runs, and a run record carrying the conditions it ran under.

The page itself never drives real hardware: it simulates, or it hands the run to the bridge. So a test that
energizes a load always runs in the bridge, where closing a tab can't skip its cleanup.
