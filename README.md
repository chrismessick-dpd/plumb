# Plumb

Bench tests for the Dovetail Signoff suite: targets (instruments and the board under test), each with an
interface, commands, and telemetry, and test suites from unit level to system level.

Plumb is a lab for now. Open `lab/plumb.html` from a local server that serves the whole tools folder (it loads
the hub's `../../signoff/assets/suite.css`). Everything in the lab is simulated on the made-up Smart Thermostat
bench (Acme Climate): a power supply, an oscilloscope, a logic analyzer, and the Main PCBA.

- **Tests** are plain text, one step per line (`PSU.set_voltage 24 V`, `wait until MAIN.state == "RUN" within 5 s`,
  `check MAIN.rail_3v3 3.3 V ±3%`, `call`, `for`, `ask`, `cleanup`, and `script`), shown as rows that edit the same
  lines. A test needs the targets its steps use; cleanup always runs, on failure and on Abort.
- **Script steps are Python**, run in the page by Pyodide in a Worker. The bench bridge and the headless runner
  are planned in Python too.
- **Telemetry and commands** lists every point and command and plots any telemetry point.
- **Research** compares COSMOS, TestStand, OpenTAP, OpenHTF, HardPy, and others, and lists open decisions.

Data will live in the private `plumb_data` repo.
