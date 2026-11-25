# A real pytest acceptance suite in Plumb: survey and plan

Status: Chris's decisions are recorded under *Decided* (2026-11-24). The suite plumbing (section 6) is the first
slice; nothing else below is built yet.

Plumb's first real workload is an existing acceptance suite for a client device: pytest, driving the board over its
USB CDC port, with debug probes for what has no wire representation. This page compares that kind of suite with
Plumb's model and proposes how Plumb takes it on. It's written in generic terms on purpose. The real mapping (the
device's fields, commands, and rows) is kept out of this public repo, in private notes and later in `plumb_data`.

## The suite, in general terms

- **About 180 test items** from about 140 functions in 14 files, each with a row id (`AREA-07b`). The docstrings
  carry the reasoning for each row, and they're the most valuable part.
- **A support package** (about 2,700 lines of Python): the wire format, a client with a background reader thread,
  debug-probe reads, a second board used as a stimulus source, the mass-storage volume, and the parameter store.
- **The wire format is text, not binary:** one line of compact JSON followed by `|` and a four-digit CRC-16. Three
  message shapes share one stream:
  - an **untagged telemetry line**, streamed by the device at 100 Hz (every field is a telemetry point);
  - **tagged diagnostic packets** (`"type": …`), streamed at a few hertz once a command turns them on;
  - **acknowledgements**, matched to the command by its message id. Some acks aren't ours (another board's
    heartbeat is mirrored onto the port), and there is no negative ack: a bad command gets silence, and several
    tests assert that silence.
- **Nothing that can be parsed from the firmware is typed in.** The telemetry field list, enums, fault-bit
  positions, and C struct layouts are parsed from the firmware source at test time, and debug-probe addresses come
  from the flashed ELF's symbols. A hand-typed copy drifts silently; the suite exists partly because one did.
- **Tiers by what's attached**, as pytest markers: board and USB only; plus the second board and its probe; rows
  that energize a load; a debug probe; a UART sniffer; a person; destructive (writes flash, reboots); reboots
  (ordered last). Profiles pick sets (factory: no destructive or slow rows; regression: everything).
- **Interventions**, how a row gets its physical change: `manual` (prompt a person), `swd` (the second board's
  probe writes the state the hardware would have made), `auto` (swd if the probe is there, else skip, **never
  manual**, since a prompt in an unattended run is a hang), or `none`. Each stimulus is a context manager, so a
  failing row still puts the board back.
- **Session fixtures** snapshot state at the start (stored parameters, a timer ceiling, limit checks) and restore
  it at the end; per-test fixtures restore a known state around a test.
- **An acceptance record** printed at the end: the unit's identity, image hash, build type, intervention mode,
  whether limits were relaxed, link health, retries. A pass is only as good as the conditions it ran under.
- **Hard-won habits:** counters are judged on increment over a window, not value; questions like "did we lose a
  sample" go to the sequence number, never a float timestamp; one command in flight; commands that reboot the
  board have no ack (the port vanishing is the success signal).

## How it maps onto Plumb

| Suite concept | Plumb today | Fit |
| --- | --- | --- |
| The board under test | A target with an interface | Fits |
| USB CDC port | `interface serial COMx baud line`, Web Serial from the page | Fits, but needs a codec (below) |
| JSON + CRC line framing | Text lines, one reply per query | **Gap:** a line codec (frame, unframe, CRC) |
| Telemetry streamed at 100 Hz | Telemetry polled by a query per point | **Gap:** streamed points, the latest line read, not a query sent |
| Tagged packets | none | **Gap:** a stream picked by a tag field; turning it on is a command |
| Acks matched by id, retried on the same id | Commands with an optional `-> value` reply | **Gap:** ack matching, a structured ack result (`ack.status`) |
| Silence as the expected result | none | **Gap:** `expect silence 500 ms` |
| Named command fields | Positional parameters | **Gap:** `name=value` arguments |
| Commands that reboot; the port drops and comes back | none | **Gap:** a reboot outcome and a `connected` condition, reopen on return |
| Telemetry field list from firmware source | Typed into the definitions | **Gap:** generated definitions (by the bridge), checked against source |
| Debug-probe reads by ELF symbol | none | **Gap:** a probe target whose points are symbols; needs the bridge |
| The second board as a stimulus | none | **Gap:** stimuli as scoped blocks (`with X.link_down`) that restore on exit |
| Intervention mode | `ask` and `tell` for operator steps | Partly: needs a bench setting (auto, probe, manual, none) and the never-fall-back rule |
| Tiers and markers | Needs come from the targets a test uses | Partly: needs fit tiers by target; also needs tags (`destructive`, `reboots`, `slow`, `debug build`) and run profiles |
| Profiles (factory, regression) | none | **Gap:** a profile picks tags to run or skip |
| Session fixtures with restore | `cleanup` per test | **Gap:** suite-level setup and cleanup |
| Parametrized rows | `for` over values | Partly: `for` can't name a command by variable |
| Windows: 20 s in band, low peak-to-peak, not constant | One reading per `check` | **Gap:** `watch X for 20 s as w`, then `w.min`, `w.max`, `w.p2p`, `w.changes`, `w.rate` (Plumb's ring buffers already keep the samples) |
| Counters judged on increment | none | **Gap:** `w.delta` over a window |
| Bit masks (fault flags) | `==`, ranges, `contains` | **Gap:** bit conditions with named bits |
| Source-level checks (no hardware) | none | Python only, outside the page |
| Mass-storage volume, SD logs | none | Bridge only (no browser API reaches a mounted drive) |
| Acceptance record | Per-test measurements | **Gap:** run conditions recorded with every run |
| pytest-timeout per test | none | **Gap:** a per-test time limit |

Six rows of different shapes were written out in Plumb's step language (privately). They confirm the gaps above:
the streaming and window rows read naturally once `watch` exists; the stimulus rows need scoped `with` blocks; the
reboot rows need named fields, structured acks, and reconnect; the source-level, symbol, and mass-storage rows are
plain Python and gain nothing from steps.

## What can't run in the page

Pyodide runs pure Python, so the suite's parsers (framing, CRC, the field list from source) could run there. The
client can't: it relies on a reader thread, pyserial, a J-Link library, and pyOCD, and the source checks need the
firmware tree on disk. So:

- **Web Serial from the page** can open the CDC port and show live telemetry, send commands, and run step-language
  tests. Flasher already does Web Serial.
- **The second board's probe is an ST-Link**, which Flasher drives over WebUSB. Possible from the page later, but
  the stimulus code is the suite's own Python.
- **The J-Link, ELF symbols, the mass-storage volume, and the firmware source need the local Python bridge.**
- **Only one process owns a COM port on Windows.** When the bridge runs tests, the page gets telemetry through the
  bridge; the page and the bridge never both open the port.
- **A browser tab can't promise cleanup.** Closing it skips every `finally`. Rows that energize a load, or write
  flash, must run in the bridge or the headless runner, never in the page.

## Proposal

### 1. Re-write the tests in Plumb's steps, with pytest import and export

Chris (2026-11-24): the existing tests are hard to use, so they're re-written as Plumb steps. Plumb steps are the
source; pytest is a format Plumb reads and writes, not a second home for the tests.

**Export.** A suite exports as one pytest module per group, every step one Python statement of a fixed shape, run
by a small `plumb` Python package (the same one the bridge and the headless runner use):

```python
import plumb

@plumb.test("PWR-01", "Powers up at 24 V", verifies=["REQ-004"], tags=["t0"])
def test_pwr_01(b):
    with b.cleanup():                    # cleanup
        b.PSU.output("off")
    b.PSU.set_current_limit("500 mA")    # PSU.set_current_limit 500 mA
    b.PSU.set_voltage("24 V")
    b.PSU.output("on")
    b.wait_until("MAIN.state", "==", "RUN", within="5 s")
    b.check("PSU.current", "40 mA .. 90 mA")
    b.check("MAIN.rail_3v3", "3.3 V ±3%")
```

So an exported suite runs anywhere pytest does (`python -m pytest`), with Plumb's targets, limits, and run record.
A `script` step exports as its Python, as is.

**Import.** Plumb reads a module back with Python's own parser (`ast`, in Pyodide or the bridge). Statements in the
fixed shapes become their steps; anything else (a helper call, a loop over computed values) becomes a `script`
step holding that code unchanged, so nothing is lost and nothing is guessed. Plumb → pytest → Plumb is exact;
pytest → Plumb → pytest keeps every line that wasn't in a fixed shape.

**The existing suite** is free-form pytest, so it won't import into neat steps by itself. It's converted once, row
by row, with Claude working from the suite and Plumb's step reference: row ids kept, each docstring's reasoning
kept as the test's notes, thresholds written as the suite writes them, and every converted row checked against
the original on the bench before the original is retired.

**The parse-from-source rule survives.** The device's telemetry fields, enums, and fault bits stay out of the tests
and out of hand-typed definitions: the bench's device target is generated from the firmware source (section 2),
and Plumb's lint flags every step that names a field, command, or bit the regenerated definitions no longer have.
A renamed field fails loudly at lint instead of passing silently.

### 2. Generate the bench from the firmware, with the suite's own parsers

A generator script (Python, in the bridge or run by hand) builds the device target's definitions (every telemetry
field, enum, and fault bit) from the firmware source with the existing suite's parsers, so the Telemetry and
commands tab and the steps read the firmware's truth. The bench file
in `plumb_data` keeps only what can't be derived (interfaces, limits, titles).

### 3. Grow the step language to carry the suite

The conversion needs these, in this order:
1. a **line codec** and **streamed telemetry** on serial interfaces (`json-crc16`; tagged streams; acks by id);
2. **named command fields**, **structured acks**, and `expect silence`;
3. **windows**: `watch X for 20 s as w` with `min`, `max`, `mean`, `p2p`, `changes`, `delta`, and `rate`;
4. **scoped stimuli** (`with TARGET.stimulus … `) restored on exit, and the intervention setting;
5. **tags, profiles, suite-level setup and cleanup, and per-test time limits**;
6. **reboot and reconnect** (`wait until X.connected within 40 s`);
7. **notes** on a test (the reasoning a docstring carries now), and **bit conditions** with named bits;
8. **Python-only rows** (source checks, probe symbols, the mass-storage volume) as `script` steps that run in the
   bridge (`script on bridge`), since Pyodide can't reach those.

**The bridge owns the device's port during every run** (Chris, 2026-11-24), and forwards telemetry and commands to
the page, so closing the tab can't skip a cleanup that turns a load off.

### 4. Where things live

- **`plumb_data` (private):** a bench per station (`benches/<id>.json`: targets, interfaces, limits, attachments),
  suites written in Plumb steps (`suites/<id>.plumb`), a pointer to an external pytest suite (repo, path, options),
  and one file per run (`runs/<bench>/<run id>.json`).
- **Exported pytest modules** can live wherever a team wants them (CI, the firmware repo); Plumb records the commit
  of the suite it ran.
- **Real names never go in the public `plumb` repo.** Its demo stays the made-up thermostat.

### 5. Runs as evidence in Signoff

A Plumb test (or a pytest row, by its id) lists the requirements it verifies. A run becomes evidence on those
requirements in Signoff EE or FW, and **the evidence carries its run conditions**: build type, image hash,
intervention mode (a probe-written stimulus proves the firmware reacts, not that the connector works), relaxed
limits, and which tiers were attached. A pass under relaxed limits or a simulated stimulus must never read as
production evidence. Chris (2026-11-24): such runs **count, labeled**: the evidence says it isn't production
evidence and why.

### 6. Becoming a suite tool

Grow `plumb/` from `lab/` into the tool proper, as Flasher and Pincheck did:
- vendor `model.js`, `github.js`, `auth.js`, and `localstore.js` into `assets/vendor/`, and `styles.css` as
  `assets/suite.css`, with `tools/sync_vendor.py`, `sync_suite_css.py`, and `stamp_version.py`;
- Sign in with GitHub, sync benches, suites, and runs with `plumb_data`, People & access, the sidebar foot, and
  the home-screen manifest lines;
- a hub link only when Chris says so.

**Built (2026-11-24), following Fabcheck rather than Pincheck** (Chris: Fabcheck's plumbing to Signoff EE is the
tested one): `index.html` and `assets/`, Fabcheck's `sync_vendor.py` and `stamp_version.py`, Sign in with GitHub
and the sidebar foot from the hub, and benches (Plumb projects) linked to an EE board and synced with `plumb_data`
with a dry run. See `CLAUDE.md`. Next: Send to Signoff EE on request, as Fabcheck's Send.

## Decided (Chris, 2026-11-24)

1. **Re-write the tests in Plumb's steps** ("the current tests are very difficult for me to use"), with a clean
   pytest import and export (section 1).
2. **First slice: the suite plumbing** (section 6). Sync to `plumb_data` waits for Chris's OK on what to write there.
3. **The bridge always owns the device's port** during a run, and forwards telemetry to the page.
4. **Relaxed-limit and probe-stimulus runs count as evidence, labeled** with their run conditions.
5. **A Plumb project is linked to one EE board** (optional), as Fabcheck's runs are. Send to Signoff EE goes to that
   board; Signoff PL sees the results through the board's review.
6. **Projects are stored like Loom's harnesses:** one file per project in `plumb_data`, `projects/<id>.json` (name,
   client project, the linked EE board, the bench's target definitions, and the test text), synced through the
   engine's `GitHubStore` with a whole-document three-way merge. Runs come later, as their own files.
7. **The first real write to `plumb_data`** waits for a dry run Chris has seen; until then sync is tried against a
   fake GitHub and `?demo`.
