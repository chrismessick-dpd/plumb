# Plumb

Bench tests for the Dovetail Signoff suite: targets (instruments and the board under test), each with an
interface, commands, and telemetry, and test suites from unit level to system level.

Open `index.html` from a local server that serves the whole tools folder (it loads the hub's sign-in, People,
and sidebar foot from `../signoff/assets/`), or `index.html?demo` for the made-up Smart Thermostat bench (Acme
Climate): a power supply, an oscilloscope, a logic analyzer, and the Main PCBA. A **bench** (a Plumb project) is one
station's targets and tests, linked to the Signoff EE board it tests, kept in the browser and synced with the
private `plumb_data` repo when signed in to GitHub. Runs are simulated in the page, or run on real targets by the
**bench bridge** (`python bridge/run.py`; see `docs/bridge.md`).

- **Tests** are plain text, one step per line (`PSU.set_voltage 24 V`, `wait until MAIN.state == "RUN" within 5 s`,
  `check MAIN.rail_3v3 3.3 V ±3%`, `call`, `for`, `ask`, `cleanup`, and `script`), shown as rows that edit the same
  lines. A test needs the targets its steps use; cleanup always runs, on failure and on Abort.
- **Script steps are Python**, run in the page by Pyodide in a Worker, or by the bench bridge. `script on bridge`
  steps run only in the bridge, where they can reach a debug probe, a mounted drive, or files on disk.
- **Telemetry and commands** lists every point and command and plots any telemetry point.
- **Research** compares COSMOS, TestStand, OpenTAP, OpenHTF, HardPy, and others, and lists open decisions.

Benches live in the private `plumb_data` repo (`projects/<id>.json`); stored runs come later. Tests: `tests/test.html`
and `python -m pytest bridge/tests`.
