# Plumb: notes for Claude

Read `C:/Dovetail/tools/CLAUDE.md` first (the suite's hard rules). Plumb is the suite's bench-test tool: targets
(instruments and the board under test), each with an interface, commands, and telemetry, and tests written one
step per line. This repo is **public**: the demo is the made-up Smart Thermostat (Acme Climate), and no client
names, fields, commands, or numbers go here, in code, docs, tests, or commit messages.

Use American English and the serial comma. Chris is colorblind: use the suite's hatch tokens, never hue alone.

## Layout (2026-11-24: the lab became the tool)

- `index.html`: the page (was `lab/plumb.html`; `lab/plumb.html` now redirects to `index.html?demo`).
- `assets/app.js`: the whole UI and the simulated bench (was `lab/plumb.js`).
- `assets/styles.css`: Plumb's styles over the suite's `assets/suite.css`.
- `assets/script-worker.js`: Pyodide (Python) for `script` steps, loaded from jsDelivr inside the Worker.
- `assets/store.js`: benches in this browser, the Signoff EE board list, sync with `plumb_data`, and the dry run.
- `assets/vendor/`: `model.js`, `github.js`, `localstore.js`, and `auth.js` from Signoff EE; `assets/suite.css`
  is EE's `styles.css`. All by `python tools/sync_vendor.py` (`--check` to test), Fabcheck's script, so Plumb
  follows Fabcheck (Chris, 2026-11-24: Fabcheck's plumbing to EE is the tested one; Pincheck is still in
  development). People, invitations, and the sidebar foot load from the hub (`../signoff/assets/`).
- `tools/stamp_version.py`: writes `assets/version.js` (`PLUMB.VERSION`); an open page reloads itself when the
  site serves another (`checkForUpdate`). Run it after any change to `index.html` or `assets/`.
- `tests/test.html`: sync tests against `tests/fake-github.js` (copied from Fabcheck). Serve the tools folder
  (preview `signoff-suite-alt`, port 8774); the page title becomes PASS, FAIL, or ERROR. 24 tests.
- `docs/generator-suite.md`: the survey of a real pytest acceptance suite against Plumb, the plan, and Chris's
  decisions. The real mapping (client names) is private: `C:/Dovetail/scratch/plumb-generator/mapping.md`.

## Benches (Plumb projects)

Chris, 2026-11-24: a Plumb project is its own thing, stored on GitHub, associated with **one Signoff EE board**
(optional); stored runs come later. In the UI a project is a **bench**. The sidebar groups benches by client
project; the page head links the board in Signoff EE (`?project=<id>`).

- **File:** `plumb_data/projects/<id>.json`, `{ schema: 1, id, meta: { name, project, board: { id, name } | null,
  deleted, updatedAt, updatedBy }, bench: { defs, script }, summary }`. `bench` is the truth; `summary`
  (`tool: 'plumb'`, counts, board) is derived at write and not kept in the browser.
- **Browser:** localStorage `plumb.v1.projects`, `bases`, `cache`, `lastSync`; UI prefs `plumb.v1.ui.*`. The demo
  uses `plumb.demo.*` and never syncs. Text-sized documents, so no IndexedDB yet.
- **Sync** (`store.sync`): the engine's `GitHubStore.sync` with a whole-document three-way merge by stamp, as Loom's
  systems: each bench's stamp as of the last sync is kept in `bases` (written only when a sync ends). Not edited
  here: GitHub's copy is taken, nothing written. Both moved on: the newer wins and the other is kept as
  "(conflict copy)". Deleting writes a tombstone (`meta.deleted`).
- **Dry run** (`store.sync({ dry: true })`, the sync sheet's Preview): the very sync, with a fetch that reads GitHub
  for real and records the commit instead of sending it (`dryFetch`). A test proves its files equal what the real
  sync then writes.
- **The EE board list** comes from Signoff EE's working copy in this browser (`SignoffLocal.store('signoff.v1.')`,
  `signoff.demo.` in the demo), as Fabcheck's Send lists boards. Open Signoff EE once, signed in, to fill it.
- **Edits** go through `reparse()` → `persist()` → `store.update`, which stamps only a real change.
- **Only Sync now writes.** The page's automatic sync (on load and sign-in, `syncNow(true)`, `pullOnly`) skips
  whenever any bench is edited, so nothing reaches `plumb_data` that Chris didn't press. A bench made and deleted
  before it ever synced is never written. An edit made while a sync runs keeps its old base unless GitHub now has
  the very copy it started from, so the next sync makes a conflict copy rather than overwriting.
- **No bench switch during a run** (`openProject`, Delete bench, and sync refuse): a running test's cleanup reads
  the open bench's targets.

**Not yet written to `plumb_data`** (Chris, 2026-11-24: the first real write waits for a dry run he has seen).
The repo has only its README. The sync sheet's Preview shows that dry run in his own browser.

## Next (to sequence with Chris)

1. The first real sync, after Chris has seen Preview.
2. **Send to Signoff EE**, after Fabcheck's Send (`pcb_dfm/assets/repo.js`, `signoff.js`): on request, store a run in
   the linked board's repo (`plumb/<board id>/runs/<run id>.json`) and put each test's verdict on the requirements
   it names (`[REQ-004]`) in EE's working copy, for EE's Sync to push, labeled with its run conditions (Chris:
   relaxed-limit and probe-stimulus runs count, labeled).
3. Stored runs in `plumb_data`.
4. The step-language growth in `docs/generator-suite.md` section 3, and pytest import and export (section 1).
5. The bench bridge (Python, localhost WebSocket); the bridge always owns the device's port (Chris).
6. A hub link only when Chris says so.
7. Sign out leaves `plumb.v1.*` benches in the browser. Adding `plumb.v1.` to `SUITE_NS` means changing EE's
   `app.js` and the hub's `sidefoot.js` together (keep them in step); for Chris to sequence.

## Open decisions (from the lab's Research tab)

Where Pyodide comes from (host it, or allow jsDelivr); the bridge's job; whether a failed check stops a test.
