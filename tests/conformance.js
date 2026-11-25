// The page's parser against the bench bridge's (bridge/plumb_bridge/lang.py): both read tests/conformance/corpus.json,
// and python.json is the bridge's answer (python -m plumb_bridge conformance). Any difference fails here.
window.PlumbConformance = async function (ok) {
  const L = window.PLUMB.lang;
  const get = (f) => fetch('conformance/' + f + '?nc=' + Date.now()).then((r) => r.json());
  const [c, py] = await Promise.all([get('corpus.json'), get('python.json')]);
  // Normalize as the bridge does: drop undefined, ±Infinity and NaN as strings.
  const norm = (x) => {
    if (typeof x === 'number') return isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : x;
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') { const o = {}; Object.keys(x).forEach((k) => { if (x[k] !== undefined) o[k] = norm(x[k]); }); return o; }
    return x === undefined ? null : x;
  };
  const scriptOut = (text, defsText) => {
    const tree = L.parseScript(text), defs = L.parseDefs(defsText);
    const nodes = tree.nodes.map((n) => {
      const o = { idx: n.idx, lead: n.lead, kind: n.kind, parent: n.parent.idx };
      ['name', 'id', 'title', 'reqs', 'step'].forEach((k) => { if (k in n) o[k] = n[k]; });
      if (n.body) o.body = n.body;
      return o;
    });
    const issues = L.lint(tree, defs), needs = {};
    Object.keys(tree.tests).sort().forEach((id) => { needs[id] = [...L.needsOf(tree.tests[id], tree)].sort(); });
    const iss = {}; Object.keys(issues).sort((a, b) => a - b).forEach((k) => { iss[k] = issues[k]; });
    return { lines: tree.lines, nodes, tests: Object.keys(tree.tests).sort(), issues: iss, needs, ends: tree.nodes.map((n) => L.subtreeEnd(tree.lines, n.idx)), exact: L.serialize(tree.lines) === text };
  };
  const benches = [{ name: 'demo', defs: L.DEFAULT_DEFS, script: L.DEFAULT_SCRIPT }].concat(c.benches);
  const js = norm({
    qty: c.qty.map((s) => L.parseQty(s)),
    cond: c.cond.map((s) => L.parseCond(s)),
    condText: c.cond.map((s) => L.condText(L.parseCond(s))),
    condPass: c.condPass.map(([s, v]) => L.condPass(L.parseCond(s), v)),
    steps: c.steps.map((s) => L.parseStep(s)),
    fmt: c.fmt.map(([v, u]) => L.fmtQty(v, u)),
    trim: c.trim.map(([v, d]) => L.trimNum(v, d)),
    benches: benches.map((b) => ({ name: b.name, defs: L.parseDefs(b.defs), script: scriptOut(b.script, b.defs) }))
  });
  // Deep compare, numbers to a relative 1e-12; report the first few differences by path.
  const diffs = [];
  const cmp = (a, b, path) => {
    if (diffs.length > 12) return;
    if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))) diffs.push(path + ': page ' + a + ', bridge ' + b); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(path + ': shapes differ'); return; }
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => cmp(a[k], b[k], path + '.' + k));
      return;
    }
    if (a !== b && !(a == null && b == null)) diffs.push(path + ': page ' + JSON.stringify(a) + ', bridge ' + JSON.stringify(b));
  };
  ['qty', 'cond', 'condText', 'condPass', 'steps', 'fmt', 'trim', 'benches'].forEach((k) => {
    const before = diffs.length; cmp(js[k], py[k], k);
    ok(diffs.length === before, 'the bridge parses ' + k + ' as the page does', diffs.slice(before).join('; '));
  });
};
