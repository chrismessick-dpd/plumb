/* Plumb lab. Everything is simulated; nothing here touches serial, USB, the network, or GitHub.
   Sections: quantities, target definitions, the test script (parse, serialize, steps, lint), the simulated
   bench, the runner, and the page. */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => performance.now();

  /* ---------- Quantities: "40 mA" is 0.040 in amps ---------- */

  const BASE = ['V', 'A', 'Hz', 's', 'W', 'Ω', '°C', '%', 'baud'];
  const PREFIX = { n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, M: 1e6 };
  const SCALED = ['V', 'A', 'Hz', 's', 'W', 'Ω'];

  function unitOf(u) {
    if (!u) return { unit: '', mult: 1 };
    if (BASE.includes(u)) return { unit: u, mult: 1 };
    const p = PREFIX[u[0]], rest = u.slice(1);
    if (p && SCALED.includes(rest)) return { unit: rest, mult: p };
    return null;
  }
  function parseQty(str) {
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(\S*)$/i.exec(String(str).trim());
    if (!m) return null;
    const u = unitOf(m[2]);
    if (!u) return null;
    return { v: parseFloat(m[1]) * u.mult, unit: u.unit };
  }
  function trimNum(x, digits) {
    let s = Number(x).toPrecision(digits || 4);
    if (s.includes('e')) return String(Number(s));
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function fmtQty(v, unit) {
    if (typeof v !== 'number') return String(v);
    if (!unit) return trimNum(v);
    if (!SCALED.includes(unit) || v === 0) return trimNum(v) + ' ' + unit;
    const a = Math.abs(v);
    const [p, d] = a >= 1e6 ? ['M', 1e6] : a >= 1e3 && unit === 'Hz' ? ['k', 1e3] : a >= 1 ? ['', 1] : a >= 1e-3 ? ['m', 1e-3] : ['µ', 1e-6];
    return trimNum(v / d) + ' ' + p + unit;
  }

  /* ---------- Target definitions ---------- */

  const DEFAULT_DEFS = `# Bench targets. Limits are in base units (V, A, Hz, °C).

target PSU "Bench power supply"
  interface lan 192.168.1.40:5025 scpi
  command output state=on|off "OUTP {state}"
  command set_voltage v=0..30V "VOLT {v}"
  command set_current_limit i=0..3A "CURR {i}"
  telemetry voltage V "MEAS:VOLT?"
  telemetry current A "MEAS:CURR?" yellow 0..0.4 red 0..0.5

target SCOPE "Oscilloscope"
  interface usb usbtmc 1AB1:04CE
  command measure ch=1..4 what=vpp|freq|mean|duty ":MEAS:ITEM? {what},CHAN{ch}" -> value
  command autoscale ":AUT"
  telemetry ch1_vpp V ":MEAS:ITEM? VPP,CHAN1" yellow 0..0.04 red 0..0.05
  telemetry ch2_freq Hz ":MEAS:ITEM? FREQ,CHAN2"

target LOGIC "Logic analyzer"
  interface usb sigrok fx2lafw
  command arm proto=uart|i2c rate "arm {proto} {rate}"
  command read "read" -> text

target MAIN "Main PCBA (board under test)"
  interface serial COM7 115200 line
  command relay n=1..2 state=on|off "relay {n} {state}"
  command set_point t=5..35°C "setpoint {t}"
  command reboot "reboot"
  telemetry state - "status?"
  telemetry fw_version - "version?"
  telemetry rail_3v3 V "status?" yellow 3.2..3.4 red 3.1..3.5
  telemetry temp °C "status?" yellow 0..45 red 0..60
  telemetry relay1 - "status?"
  telemetry relay2 - "status?"
`;

  function parseRange(s) {
    const m = /^(-?[\d.]*)\.\.(-?[\d.]*)$/.exec(s);
    if (!m) return null;
    return [m[1] === '' ? -Infinity : +m[1], m[2] === '' ? Infinity : +m[2]];
  }

  function parseDefs(text) {
    const targets = {}, errors = [];
    let cur = null;
    text.split('\n').forEach((raw, i) => {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#')) return;
      const n = i + 1;
      let m;
      if ((m = /^target\s+([A-Z][A-Z0-9_]*)\s+"([^"]*)"$/.exec(line))) {
        cur = targets[m[1]] = { name: m[1], title: m[2], iface: null, commands: {}, telemetry: {}, order: [] };
      } else if (!cur) {
        errors.push({ line: n, msg: 'Start with a target line' });
      } else if ((m = /^interface\s+(\S+)\s*(.*)$/.exec(line))) {
        const parts = m[2].split(/\s+/);
        cur.iface = { type: m[1], parts, text: m[1] + ' ' + m[2] };
      } else if ((m = /^command\s+([A-Za-z_]\w*)\s*(.*?)(?:\s*->\s*(\w+))?$/.exec(line))) {
        const rest = m[2];
        const wm = /"([^"]*)"\s*$/.exec(rest);
        const specs = (wm ? rest.slice(0, wm.index) : rest).trim().split(/\s+/).filter(Boolean);
        const params = specs.map((s) => {
          const [name, spec] = s.split('=');
          if (!spec) return { name, kind: 'any' };
          if (spec.includes('|')) return { name, kind: 'choice', choices: spec.split('|') };
          const um = /^(-?[\d.]*\.\.-?[\d.]*)(\S*)$/.exec(spec);
          const r = um && parseRange(um[1]);
          if (!r) { errors.push({ line: n, msg: 'Can\'t read parameter ' + s }); return { name, kind: 'any' }; }
          return { name, kind: 'range', range: r, unit: um[2] || '' };
        });
        cur.commands[m[1]] = { name: m[1], params, wire: wm ? wm[1] : '', returns: m[3] || null };
      } else if ((m = /^telemetry\s+([A-Za-z_]\w*)\s+(\S+)\s+"([^"]*)"\s*(.*)$/.exec(line))) {
        const t = { name: m[1], unit: m[2] === '-' ? '' : m[2], query: m[3], yellow: null, red: null };
        const lm = m[4].match(/(yellow|red)\s+(\S+)/g) || [];
        lm.forEach((x) => { const [k, r] = x.split(/\s+/); t[k] = parseRange(r); if (!t[k]) errors.push({ line: n, msg: 'Can\'t read limit ' + x }); });
        cur.telemetry[m[1]] = t; cur.order.push(m[1]);
      } else {
        errors.push({ line: n, msg: 'Can\'t read this line' });
      }
    });
    return { targets, errors };
  }

  function ifacePath(iface) {
    if (!iface) return { label: 'No interface', path: '' };
    const p = iface.parts;
    if (iface.type === 'serial') return { label: 'Serial ' + p[0] + ' · ' + p[1] + ' baud', path: 'Web Serial · direct' };
    if (iface.type === 'lan') return { label: 'LAN ' + p[0] + (p[1] ? ' · ' + p[1].toUpperCase() : ''), path: 'TCP · via the local bridge' };
    if (iface.type === 'usb' && p[0] === 'usbtmc') return { label: 'USB USBTMC ' + (p[1] || ''), path: 'WebUSB · direct (WinUSB driver)' };
    if (iface.type === 'usb' && p[0] === 'sigrok') return { label: 'USB sigrok ' + (p[1] || ''), path: 'sigrok · via the local bridge' };
    return { label: iface.text, path: '' };
  }

  function limitState(t, v) {
    if (typeof v !== 'number' || !t) return 'none';
    if (t.red && (v < t.red[0] || v > t.red[1])) return 'red';
    if (t.yellow && (v < t.yellow[0] || v > t.yellow[1])) return 'yellow';
    return t.red || t.yellow ? 'ok' : 'none';
  }

  /* ---------- The test script ---------- */

  const DEFAULT_SCRIPT = `# Smart Thermostat · Main PCBA bench tests (made-up demo)
# One step per line; indent to nest. The rows and this text are the same thing.

suite Main PCBA
  group Power
    test PWR-01 Powers up at 24 V [REQ-004]
      PSU.set_current_limit 500 mA
      PSU.set_voltage 24 V
      PSU.output on
      wait until MAIN.state == "RUN" within 5 s
      check PSU.current 40 mA .. 90 mA
      check MAIN.rail_3v3 3.3 V ±3%
      cleanup
        PSU.output off
    test PWR-02 3V3 ripple with both relays on [REQ-005]
      call PWR-01
      MAIN.relay 1 on
      MAIN.relay 2 on
      wait 200 ms
      SCOPE.measure 1 vpp -> ripple
      check ripple < 50 mV
      cleanup
        MAIN.relay 1 off
        MAIN.relay 2 off
    test PWR-03 Brown-out threshold [REQ-006]
      call PWR-01
      script
        # Step the supply down until the board stops answering RUN.
        v = 24.0
        while v > 6:
            v -= 0.5
            cmd('PSU.set_voltage', f'{v} V')
            wait(150)
            try:
                state = tlm('MAIN.state')
            except Exception:
                state = 'OFF'
            if state != 'RUN':
                break
        record('brownout', v, 'V')
        log(f'Board dropped out at {v} V')
      check brownout < 9 V
      cleanup
        PSU.set_voltage 24 V
  group Firmware
    test FW-01 Boot banner on the debug UART [REQ-011]
      LOGIC.arm uart 115200
      call PWR-01
      LOGIC.read -> banner
      check banner contains "self-test OK"
      check MAIN.fw_version == "1.4.2"
    test FW-02 Relays follow commands [REQ-012]
      call PWR-01
      for n in 1, 2
        MAIN.relay $n on
        wait 50 ms
        check MAIN.relay$n == "closed"
        MAIN.relay $n off
        wait 50 ms
        check MAIN.relay$n == "open"
    test FW-03 Backlight PWM frequency
      call PWR-01
      SCOPE.measure 2 freq -> pwm
      check pwm 20 kHz ±5%
  group Operator
    test UI-01 Display shows the set point [REQ-020]
      call PWR-01
      MAIN.set_point 21.5 °C
      ask "Does the display read 21.5 °C?"
    test UI-02 Board temperature after warm-up
      call PWR-01
      wait 2 s
      measure MAIN.temp as board_temp
      check board_temp < 45 °C
`;

  // A script is a flat list of lines, each with its leading spaces; the tree is derived. Serializing writes the
  // lines back, so text → rows → text is exact.
  function parseScript(text) {
    const lines = text.replace(/\r/g, '').split('\n').map((raw) => {
      const t = raw.replace(/\s+$/, '');
      const lead = t.length - t.trimStart().length;
      return { lead, text: t.trimStart() };
    });
    if (lines.length && lines[lines.length - 1].text === '' && text.endsWith('\n')) lines.pop();
    return buildTree(lines);
  }
  function serialize(lines) { return lines.map((l) => (l.text ? ' '.repeat(l.lead) + l.text : '')).join('\n') + '\n'; }

  function buildTree(lines) {
    const root = { kind: 'root', lead: -1, children: [], idx: -1 };
    const stack = [root];
    const tests = {}, nodes = [];
    let scriptLead = null;
    lines.forEach((l, idx) => {
      if (scriptLead != null) {
        if (!l.text || l.lead > scriptLead) { if (l.text) stack[stack.length - 1].body.push(idx); return; }
        scriptLead = null; stack.pop();
      }
      if (!l.text || l.text.startsWith('#')) return;
      while (stack.length > 1 && stack[stack.length - 1].lead >= l.lead) stack.pop();
      const parent = stack[stack.length - 1];
      const node = { idx, lead: l.lead, text: l.text, children: [], parent };
      const w = l.text.split(/\s+/)[0];
      if (w === 'suite' || w === 'group') { node.kind = w; node.name = l.text.slice(w.length).trim(); }
      else if (w === 'test') {
        node.kind = 'test';
        const m = /^test\s+(\S+)\s*(.*?)\s*(?:\[([^\]]*)\])?$/.exec(l.text);
        node.id = m ? m[1] : '?'; node.title = m ? m[2] : ''; node.reqs = m && m[3] ? m[3].split(/[,\s]+/).filter(Boolean) : [];
        tests[node.id] = node;
      } else { node.kind = 'step'; node.step = parseStep(l.text); }
      parent.children.push(node); nodes.push(node);
      if (node.kind === 'step' && node.step.kind === 'script') { node.body = []; scriptLead = l.lead; stack.push(node); return; }
      stack.push(node);
    });
    return { lines, root, tests, nodes };
  }

  const REF = '([A-Z][A-Z0-9_]*\\.[A-Za-z_][\\w$]*|[a-z_]\\w*)';
  function parseCond(s) {
    s = s.trim().replace(/\s*(?:\+\/-|\+-)\s*/g, ' ± '); // +/- and +- are ± for keyboards without it
    let m;
    if ((m = /^contains\s+"(.*)"$/.exec(s))) return { op: 'contains', a: m[1] };
    if ((m = /^(==|=)\s*"(.*)"$/.exec(s))) return { op: '==', a: m[2], str: true };
    if ((m = /^(<=|>=|<|>|==|=)\s*(.+)$/.exec(s))) { const q = parseQty(m[2]); return q ? { op: m[1] === '=' ? '==' : m[1], a: q.v, unit: q.unit } : null; }
    if ((m = /^(.+?)\s*\.\.\s*(.+)$/.exec(s))) { const a = parseQty(m[1]), b = parseQty(m[2]); return a && b ? { op: 'range', a: a.v, b: b.v, unit: b.unit || a.unit } : null; }
    if ((m = /^(.+?)\s*±\s*(.+)$/.exec(s))) {
      const nom = parseQty(m[1]); if (!nom) return null;
      const tm = /^([\d.]+)\s*%$/.exec(m[2].trim());
      const tol = tm ? Math.abs(nom.v) * (+tm[1] / 100) : (parseQty(m[2]) || {}).v;
      if (tol == null || isNaN(tol)) return null;
      return { op: 'range', a: nom.v - tol, b: nom.v + tol, unit: nom.unit, nom: nom.v };
    }
    return null;
  }
  function condText(c) {
    if (!c) return '';
    const f = (v) => fmtQty(v, c.unit);
    if (c.op === 'range') return f(c.a) + ' to ' + f(c.b);
    if (c.op === 'contains') return 'contains "' + c.a + '"';
    if (c.str) return '"' + c.a + '"';
    return c.op + ' ' + f(c.a);
  }
  function condPass(c, v) {
    if (c.op === 'contains') return typeof v === 'string' && v.includes(c.a);
    if (c.str || typeof v === 'string') return c.op === '==' && String(v) === String(c.a);
    if (typeof v !== 'number' || isNaN(v)) return false;
    switch (c.op) {
      case 'range': return v >= c.a - 1e-12 && v <= c.b + 1e-12;
      case '<': return v < c.a; case '<=': return v <= c.a;
      case '>': return v > c.a; case '>=': return v >= c.a;
      case '==': return Math.abs(v - c.a) < 1e-9;
    }
    return false;
  }

  const KIND_LABEL = {
    command: 'Command', wait: 'Wait', until: 'Wait until', check: 'Check', measure: 'Measure', ask: 'Ask operator',
    tell: 'Tell operator', log: 'Log', todo: 'To do', call: 'Call', repeat: 'Repeat', for: 'For each', script: 'Script', cleanup: 'Cleanup', bad: '?'
  };

  function parseStep(text) {
    let m;
    if ((m = new RegExp('^wait until ' + REF + '\\s+(.+?)\\s+within\\s+(.+)$').exec(text))) {
      const t = parseQty(m[3]);
      return { kind: 'until', ref: m[1], cond: parseCond(m[2]), timeout: t && t.unit === 's' ? t.v : null };
    }
    if ((m = /^wait\s+(.+)$/.exec(text))) { const q = parseQty(m[1]); return { kind: 'wait', sec: q && q.unit === 's' ? q.v : null }; }
    if ((m = new RegExp('^check ' + REF + '\\s+(.+)$').exec(text))) return { kind: 'check', ref: m[1], cond: parseCond(m[2]) };
    if ((m = new RegExp('^measure ' + REF + '\\s+as\\s+([a-z_]\\w*)$').exec(text))) return { kind: 'measure', ref: m[1], as: m[2] };
    if ((m = /^(ask|tell|log)\s+"(.*)"$/.exec(text))) return { kind: m[1], msg: m[2] };
    if ((m = /^todo\s+"(.*)"$/.exec(text))) return { kind: 'todo', msg: m[1] };
    if ((m = /^call\s+(\S+)$/.exec(text))) return { kind: 'call', id: m[1] };
    if ((m = /^repeat\s+(\d+)$/.exec(text))) return { kind: 'repeat', n: +m[1] };
    if ((m = /^for\s+([a-z_]\w*)\s+in\s+(.+)$/.exec(text))) return { kind: 'for', v: m[1], items: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
    if (text === 'script') return { kind: 'script' };
    if (text === 'script on bridge') return { kind: 'script', bridge: true };
    if (text === 'cleanup') return { kind: 'cleanup' };
    if ((m = /^([A-Z][A-Z0-9_]*)\.([A-Za-z_][\w$]*)\s*(.*?)(?:\s*->\s*([a-z_]\w*))?$/.exec(text))) {
      return { kind: 'command', target: m[1], cmd: m[2], args: tokenize(m[3]), into: m[4] || null };
    }
    return { kind: 'bad' };
  }
  function tokenize(s) {
    const raw = s.match(/"[^"]*"|\S+/g) || [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i], nx = raw[i + 1];
      if (/^(?:[-+]?[\d.]+|\$[a-z_]\w*)$/.test(t) && nx && unitOf(nx) && unitOf(nx).unit) { out.push(t + ' ' + nx); i++; } else out.push(t.replace(/^"|"$/g, ''));
    }
    return out;
  }

  // Which targets a test touches, through its calls and its scripts.
  function needsOf(test, tree, seen) {
    seen = seen || new Set();
    const out = new Set();
    if (seen.has(test.id)) return out;
    seen.add(test.id);
    const walk = (n) => {
      n.children.forEach((c) => {
        if (c.kind !== 'step') return;
        const s = c.step;
        if (s.kind === 'command') out.add(s.target);
        if ((s.kind === 'check' || s.kind === 'until' || s.kind === 'measure') && s.ref.includes('.')) out.add(s.ref.split('.')[0]);
        if (s.kind === 'call' && tree.tests[s.id]) needsOf(tree.tests[s.id], tree, seen).forEach((x) => out.add(x));
        if (s.kind === 'script') c.body.forEach((i) => (tree.lines[i].text.match(/['"]([A-Z][A-Z0-9_]*)\./g) || []).forEach((x) => out.add(x.slice(1, -1))));
        walk(c);
      });
    };
    walk(test);
    return out;
  }

  function lint(tree, defs) {
    const issues = {};
    const add = (n, msg) => { (issues[n.idx] = issues[n.idx] || []).push(msg); };
    const vars = new Set();
    tree.nodes.forEach((n) => {
      if (n.kind !== 'step') return;
      if (n.step.into) vars.add(n.step.into);
      if (n.step.kind === 'measure') vars.add(n.step.as);
      if (n.step.kind === 'script') n.body.forEach((i) => { const m = /record\(['"](\w+)['"]/.exec(tree.lines[i].text); if (m) vars.add(m[1]); });
    });
    const T = defs.targets;
    tree.nodes.forEach((n) => {
      if (n.kind === 'test' && !(n.parent && n.parent.kind === 'group' || n.parent.kind === 'suite')) add(n, 'A test sits under a suite or a group');
      if (n.kind !== 'step') return;
      const s = n.step;
      if (!n.parent || n.parent.kind === 'root' || n.parent.kind === 'suite' || n.parent.kind === 'group') add(n, 'A step belongs inside a test');
      if (s.kind === 'bad') return add(n, 'Can\'t read this step');
      if (s.kind === 'command') {
        const t = T[s.target];
        if (!t) return add(n, 'No target ' + s.target);
        const c = t.commands[s.cmd.replace(/\$\w+/g, '1')];
        if (!c) return add(n, s.target + ' has no command ' + s.cmd);
        if (s.args.length !== c.params.length) add(n, s.cmd + ' takes ' + c.params.length + ' parameter' + (c.params.length === 1 ? '' : 's'));
      }
      if (s.kind === 'check' || s.kind === 'until' || s.kind === 'measure') {
        if (s.ref.includes('.')) {
          const [tn, item] = s.ref.split('.');
          if (!T[tn]) add(n, 'No target ' + tn);
          else if (!T[tn].telemetry[item.replace(/\$\w+/g, '1')]) add(n, tn + ' has no telemetry ' + item);
          else if (s.cond && s.cond.unit && T[tn].telemetry[item.replace(/\$\w+/g, '1')].unit !== s.cond.unit) add(n, 'Unit ' + s.cond.unit + ' doesn\'t match ' + (T[tn].telemetry[item.replace(/\$\w+/g, '1')].unit || 'a value without a unit'));
        } else if (!vars.has(s.ref)) add(n, 'Nothing records ' + s.ref + ' before this');
        if (s.kind !== 'measure' && !s.cond) add(n, 'Can\'t read the limit');
      }
      if (s.kind === 'until' && s.timeout == null) add(n, 'Give a time: within 5 s');
      if (s.kind === 'wait' && s.sec == null) add(n, 'Give a time: wait 200 ms');
      if (s.kind === 'call' && !tree.tests[s.id]) add(n, 'No test ' + s.id);
    });
    return issues;
  }

  /* ---------- The simulated bench ---------- */

  const sim = {
    attached: { PSU: true, SCOPE: true, LOGIC: true, MAIN: true },
    fault: 'none',
    psu: { on: false, v: 0, ilim: 3 },
    main: { bootAt: null, relays: [false, false], setpoint: 20 },
    logic: null,
    powered() { return this.psu.on && this.psu.v >= (this.fault === 'brownout' ? 10 : 7.5); },
    bootTime() { return this.fault === 'slowboot' ? 6000 : 1200; },
    update() {
      const p = this.powered();
      if (p && this.main.bootAt == null) {
        this.main.bootAt = now();
        if (this.logic) this.logic.lines.push({ at: now() + 150, text: 'Acme Climate SmartTherm main 1.4.2' }, { at: now() + this.bootTime() - 200, text: 'rails ok 3V3=3.30' }, { at: now() + this.bootTime(), text: 'self-test OK' });
      }
      if (!p) { this.main.bootAt = null; this.main.relays = [false, false]; }
    },
    state() {
      this.update();
      if (!this.powered()) return 'OFF';
      return now() - this.main.bootAt < this.bootTime() ? 'BOOT' : 'RUN';
    },
    relaysOn() { return this.main.relays.filter((r, i) => r && !(i === 1 && this.fault === 'relay2')).length; },
    noise(s) { return (Math.random() + Math.random() + Math.random() - 1.5) * s; },
    current() {
      if (!this.psu.on || this.psu.v <= 0) return 0;
      if (!this.powered()) return 0.008 + this.noise(0.0005);
      const w = (this.fault === 'idle' ? 3.4 : 1.5) + this.relaysOn() * 0.84 + (this.state() === 'RUN' ? 0.2 : 0);
      return Math.min(this.psu.ilim, w / this.psu.v + this.noise(0.0012));
    },
    read(target, item) {
      if (!this.attached[target]) throw new Error(target + ' isn\'t attached');
      const st = this.state();
      if (target === 'PSU') {
        if (item === 'voltage') return this.psu.on ? this.psu.v - this.current() * 0.05 + this.noise(0.002) : 0;
        if (item === 'current') return this.current();
      }
      if (target === 'SCOPE') {
        if (item === 'ch1_vpp') return this.powered() ? 0.018 + this.relaysOn() * 0.009 + this.noise(0.0015) : 0.002 + this.noise(0.0004);
        if (item === 'ch2_freq') return st === 'RUN' ? 20000 * (1 + this.noise(0.002)) : 0;
      }
      if (target === 'MAIN') {
        if (st === 'OFF') throw new Error('MAIN didn\'t answer within 500 ms');
        if (item === 'state') return st;
        if (item === 'fw_version') return '1.4.2';
        if (item === 'rail_3v3') return 3.302 - this.relaysOn() * 0.009 + this.noise(0.004);
        if (item === 'temp') return 24 + Math.min(12, (now() - this.main.bootAt) / 1000 * 2.5) + this.relaysOn() * 1.5 + this.noise(0.2);
        if (item === 'relay1' || item === 'relay2') { const i = +item.slice(-1) - 1; return this.main.relays[i] && !(i === 1 && this.fault === 'relay2') ? 'closed' : 'open'; }
      }
      throw new Error(target + ' has no telemetry ' + item);
    },
    command(target, cmd, vals) {
      if (!this.attached[target]) throw new Error(target + ' isn\'t attached');
      if (target === 'PSU') {
        if (cmd === 'output') this.psu.on = vals.state === 'on';
        if (cmd === 'set_voltage') this.psu.v = vals.v;
        if (cmd === 'set_current_limit') this.psu.ilim = vals.i;
        this.update(); return 'OK';
      }
      if (target === 'SCOPE') {
        if (cmd === 'measure') {
          const ch = vals.ch, w = vals.what;
          if (ch === 1 && w === 'vpp') return this.read('SCOPE', 'ch1_vpp');
          if (ch === 2 && w === 'freq') return this.read('SCOPE', 'ch2_freq');
          if (w === 'mean') return ch === 1 ? (this.powered() ? 3.3 : 0) : 0;
          return 0;
        }
        return 'OK';
      }
      if (target === 'LOGIC') {
        if (cmd === 'arm') { this.logic = { proto: vals.proto, lines: [] }; return 'armed'; }
        if (cmd === 'read') {
          if (!this.logic) throw new Error('LOGIC isn\'t armed');
          const t = now(); const out = this.logic.lines.filter((l) => l.at <= t).map((l) => l.text).join('\n');
          this.logic = null; return out;
        }
      }
      if (target === 'MAIN') {
        if (this.state() === 'OFF') throw new Error('MAIN didn\'t answer within 500 ms');
        if (cmd === 'relay') this.main.relays[vals.n - 1] = vals.state === 'on';
        if (cmd === 'set_point') this.main.setpoint = vals.t;
        if (cmd === 'reboot') this.main.bootAt = now();
        return 'OK';
      }
      return 'OK';
    }
  };
  const LATENCY = { serial: 18, lan: 8, usb: 14 };

  /* ---------- App state ---------- */

  const S = {
    defsText: DEFAULT_DEFS, defs: null,
    text: DEFAULT_SCRIPT, tree: null, issues: {},
    view: 'side', open: new Set(['PWR-01']), results: {}, steps: {},
    running: false, abort: false, current: null, log: [], hist: {}
  };
  try { const v = localStorage.getItem('plumb.v1.ui.view'); if (v) S.view = v; } catch (e) { /* storage off */ }

  function reparse(fromText) {
    if (fromText) S.form = null; // typed in the Script view: an open form's line may have moved
    S.tree = parseScript(S.text);
    S.issues = lint(S.tree, S.defs);
    if (!fromText) $('#script').value = S.text;
    renderCodeBg(S.tree);
    renderRows(); renderLint(); renderRoundTrip(); renderEvidence(); renderSummary();
    persist();
  }
  // Script view: a picture of the text behind the transparent text box, tinting each script step's Python lines and
  // labeling the step. Same font, padding, and scroll as the box, so the tints sit under their lines.
  function renderCodeBg(tree) {
    const lines = tree.lines, py = new Map();
    tree.nodes.forEach((n) => {
      if (n.kind !== 'step' || n.step.kind !== 'script') return;
      py.set(n.idx, 'head');
      const last = n.body.length ? n.body[n.body.length - 1] : n.idx;
      for (let i = n.idx + 1; i <= last; i++) py.set(i, 'body');
    });
    const pk = S.pick != null && lines[S.pick] && lines[S.pick].text ? [S.pick, subtreeEnd(lines, S.pick)] : null;
    $('#script-bg').innerHTML = lines.map((l, i) => {
      const k = py.get(i), txt = esc(l.text ? ' '.repeat(l.lead) + l.text : '') || ' ';
      const on = pk && i >= pk[0] && i < pk[1];
      return '<span class="tb-bl' + (k ? ' py-' + k : '') + (on ? ' pick' + (i === pk[0] ? ' pick-first' : '') + (i === pk[1] - 1 ? ' pick-last' : '') : '') + '">' + txt + (k === 'head' ? '<span class="tb-py-label">Python</span>' : '') + '</span>';
    }).join('');
    syncCodeBg();
  }
  // Picking: a row picked marks its lines in the script, and the caret in the script picks its row (Side by side).
  function nodeAtLine(tree, line) {
    let best = null;
    tree.nodes.forEach((n) => {
      if (n.kind !== 'test' && n.kind !== 'step') return;
      if (n.idx <= line && line < subtreeEnd(tree.lines, n.idx) && (!best || n.idx > best.idx)) best = n;
    });
    return best;
  }
  function testOf(n) { while (n && n.kind !== 'test') n = n.parent; return n; }
  function scrollScriptTo(line) {
    const ta = $('#script'); if (!ta || !ta.offsetParent) return;
    const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 19, top = parseFloat(cs.paddingTop) + line * lh;
    if (top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight) { ta.scrollTop = Math.max(0, top - ta.clientHeight / 3); syncCodeBg(); }
  }
  function pickFromRows(idx) {
    if (S.pick === idx) return;
    S.pick = idx; renderCodeBg(S.tree); scrollScriptTo(idx);
    document.querySelectorAll('#rows .picked').forEach((x) => x.classList.remove('picked'));
    const el = document.querySelector('#rows [data-pick="' + idx + '"]'); if (el) el.classList.add('picked');
  }
  function pickFromScript() {
    const ta = $('#script'); if (!S.tree || ta.value !== S.text) return;
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const n = nodeAtLine(S.tree, line), idx = n ? n.idx : null;
    if (idx === S.pick) return;
    S.pick = idx; renderCodeBg(S.tree);
    if (!n) { document.querySelectorAll('#rows .picked').forEach((x) => x.classList.remove('picked')); return; }
    const t = testOf(n); if (t && !S.open.has(t.id)) S.open.add(t.id);
    renderRows();
    const el = document.querySelector('#rows [data-pick="' + idx + '"]');
    if (el && $('#rows').offsetParent) el.scrollIntoView({ block: 'nearest' });
  }
  function syncCodeBg() { const ta = $('#script'), bg = $('#script-bg'); bg.scrollTop = ta.scrollTop; bg.scrollLeft = ta.scrollLeft; }
  function setLines(lines) { S.text = serialize(lines); reparse(false); }

  /* ---------- Running ---------- */

  function log(kind, text) {
    const t = new Date();
    S.log.push({ kind, text, t: t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0') });
    if (S.log.length > 400) S.log.shift();
    renderLog();
  }

  class Abort extends Error {}
  class Stop extends Error {}

  function abortable(ms) {
    return new Promise((res, rej) => {
      const end = now() + ms;
      const tick = () => { if (S.abort && !S.inCleanup) return rej(new Abort('Aborted')); if (now() >= end) return res(); setTimeout(tick, Math.min(40, end - now())); };
      tick();
    });
  }

  async function sendCommand(text, ctx) {
    const s = parseStep(text);
    if (s.kind !== 'command') throw new Error('Not a command: ' + text);
    const t = S.defs.targets[s.target];
    if (!t) throw new Error('No target ' + s.target);
    const c = t.commands[s.cmd];
    if (!c) throw new Error(s.target + ' has no command ' + s.cmd);
    if (s.args.length !== c.params.length) throw new Error(s.cmd + ' takes ' + c.params.length + ' parameters');
    const vals = {}, wireVals = {};
    c.params.forEach((p, i) => {
      const a = s.args[i];
      if (p.kind === 'choice') { if (!p.choices.includes(a)) throw new Error(p.name + ' is one of ' + p.choices.join(', ')); vals[p.name] = a; wireVals[p.name] = a; }
      else if (p.kind === 'range') {
        const q = parseQty(a);
        if (!q) throw new Error('Can\'t read ' + a);
        if (p.unit && q.unit && q.unit !== p.unit) throw new Error(p.name + ' is in ' + p.unit);
        if (q.v < p.range[0] || q.v > p.range[1]) throw new Error(p.name + ' ' + fmtQty(q.v, p.unit) + ' is outside ' + p.range[0] + ' to ' + p.range[1] + (p.unit ? ' ' + p.unit : ''));
        vals[p.name] = q.v; wireVals[p.name] = trimNum(q.v, 6);
      } else { vals[p.name] = a; wireVals[p.name] = a; }
    });
    const wire = c.wire.replace(/\{(\w+)\}/g, (m, k) => wireVals[k]);
    log('tx', s.target + ' → ' + (wire || s.cmd));
    await abortable(LATENCY[t.iface && t.iface.type] || 10);
    const r = sim.command(s.target, s.cmd, vals);
    if (c.returns) {
      log('rx', s.target + ' ← ' + (typeof r === 'number' ? trimNum(r, 5) : JSON.stringify(r)));
      if (s.into && ctx) ctx.vars[s.into] = { v: r, unit: unitFor(s.target, s.cmd, vals) };
    }
    return r;
  }
  function unitFor(target, cmd, vals) {
    if (target === 'SCOPE' && cmd === 'measure') return { vpp: 'V', mean: 'V', freq: 'Hz', duty: '%' }[vals.what] || '';
    return '';
  }
  async function readRef(ref, ctx, quiet) {
    if (!ref.includes('.')) {
      if (!(ref in ctx.vars)) throw new Error('Nothing recorded ' + ref);
      return ctx.vars[ref];
    }
    const [tn, item] = ref.split('.');
    const t = S.defs.targets[tn];
    if (!t) throw new Error('No target ' + tn);
    const tl = t.telemetry[item];
    if (!tl) throw new Error(tn + ' has no telemetry ' + item);
    await abortable(LATENCY[t.iface && t.iface.type] || 10);
    const v = sim.read(tn, item);
    if (!quiet) log('rx', tn + ' ← ' + tl.query + ' ' + (typeof v === 'number' ? fmtQty(v, tl.unit) : '"' + v + '"'));
    return { v, unit: tl.unit };
  }

  function stepRes(n, r) {
    const prev = S.steps[n.idx];
    if (prev && prev.run === S.runId) { prev.list.push(r); Object.assign(prev, r); } else S.steps[n.idx] = Object.assign({ run: S.runId, list: [r] }, r);
    renderRows();
  }
  const sub = (text, vars) => text.replace(/\$([a-z_]\w*)/g, (m, k) => (k in vars ? vars[k] : m));

  // A block's cleanup is registered when the block starts, wherever it's written, so it runs even when a
  // step before it fails or the run is aborted.
  async function execBlock(nodes, ctx, vars) {
    nodes.forEach((n) => { if (n.kind === 'step' && n.step.kind === 'cleanup') ctx.cleanups.push({ nodes: n.children, vars, node: n, depth: ctx.depth, seq: ctx.cleanups.length }); });
    for (const n of nodes) {
      if (n.kind !== 'step' || n.step.kind === 'cleanup') continue;
      if (S.abort && !S.inCleanup) throw new Abort('Aborted');
      S.current = n.idx; renderRows();
      await execStep(n, ctx, vars);
    }
  }

  async function execStep(n, ctx, vars) {
    const kept = {};
    Object.keys(ctx.vars).forEach((k) => { const x = ctx.vars[k]; kept[k] = x && typeof x === 'object' && 'v' in x ? x.v : x; });
    const text = sub(n.text, Object.assign(kept, vars));
    const s = parseStep(text);
    const t0 = now();
    try {
      switch (s.kind) {
        case 'command': { const r = await sendCommand(text, ctx); stepRes(n, { verdict: 'done', value: typeof r === 'number' ? fmtQty(r, (ctx.vars[s.into] || {}).unit) : (s.into ? (String(r).split('\n').length + ' lines') : '') }); break; }
        case 'wait': await abortable(s.sec * 1000); stepRes(n, { verdict: 'done', value: fmtQty(s.sec, 's') }); break;
        case 'until': {
          const end = now() + s.timeout * 1000; let last = null;
          for (;;) {
            try { last = await readRef(s.ref, ctx, true); if (condPass(s.cond, last.v)) break; } catch (e) { if (e instanceof Abort) throw e; last = { v: '(no answer)' }; }
            if (now() > end) {
              stepRes(n, { verdict: 'fail', value: fmtV(last), limit: condText(s.cond), note: 'Timed out after ' + fmtQty(s.timeout, 's') });
              log('fail', 'Timed out: ' + text);
              throw new Stop('timeout');
            }
            await abortable(100);
          }
          log('rx', s.ref + ' = ' + fmtV(last) + ' after ' + fmtQty((now() - t0) / 1000, 's'));
          stepRes(n, { verdict: 'pass', value: fmtV(last), limit: condText(s.cond), note: 'after ' + fmtQty((now() - t0) / 1000, 's') });
          break;
        }
        case 'check': {
          const v = await readRef(s.ref, ctx);
          const ok = condPass(s.cond, v.v);
          stepRes(n, { verdict: ok ? 'pass' : 'fail', value: fmtV(v), limit: condText(s.cond) });
          ctx.measurements.push({ name: s.ref, value: v.v, unit: v.unit, limit: condText(s.cond), ok });
          if (!ok) { ctx.failed = true; log('fail', 'Failed: ' + text + ' (read ' + fmtV(v) + ')'); }
          break;
        }
        case 'measure': { const v = await readRef(s.ref, ctx); ctx.vars[s.as] = v; stepRes(n, { verdict: 'done', value: fmtV(v) }); break; }
        case 'log': log('info', s.msg); stepRes(n, { verdict: 'done' }); break;
        case 'todo': ctx.todo = true; log('skip', 'Not written yet: ' + s.msg); stepRes(n, { verdict: 'skip', note: s.msg }); break;
        case 'tell': await operator(s.msg, [['OK', true]]); stepRes(n, { verdict: 'done' }); break;
        case 'ask': {
          const ok = await operator(s.msg, [['Yes', true], ['No', false]]);
          log(ok ? 'pass' : 'fail', 'Operator: ' + (ok ? 'yes' : 'no') + ' to "' + s.msg + '"');
          stepRes(n, { verdict: ok ? 'pass' : 'fail', value: ok ? 'Yes' : 'No' });
          if (!ok) ctx.failed = true;
          break;
        }
        case 'call': {
          const t = S.tree.tests[s.id];
          if (!t) throw new Error('No test ' + s.id);
          if (ctx.depth > 8) throw new Error('Calls nest too deep');
          log('info', 'Call ' + s.id + ' ' + t.title);
          ctx.depth++;
          try { await execBlock(t.children, ctx, {}); } finally { ctx.depth--; }
          stepRes(n, { verdict: 'done', value: s.id });
          break;
        }
        case 'repeat': for (let i = 0; i < s.n; i++) await execBlock(n.children, ctx, Object.assign({}, vars, { i: i + 1 })); stepRes(n, { verdict: 'done', value: s.n + ' times' }); break;
        case 'for': for (const it of s.items) await execBlock(n.children, ctx, Object.assign({}, vars, { [s.v]: it })); stepRes(n, { verdict: 'done', value: s.items.length + ' items' }); break;
        case 'script': { const recs = await runScript(n, ctx); stepRes(n, { verdict: 'done', value: recs }); break; }
        default: throw new Error('Can\'t read this step');
      }
    } catch (e) {
      if (e instanceof Abort || e instanceof Stop) throw e;
      stepRes(n, { verdict: 'error', note: e.message });
      log('error', e.message);
      throw new Stop(e.message);
    }
  }
  function fmtV(r) { if (!r) return ''; return typeof r.v === 'number' ? fmtQty(r.v, r.unit) : (r.v.includes && r.v.includes('\n') ? r.v.split('\n').length + ' lines' : '"' + r.v + '"'); }

  // The escape hatch is Python, run by Pyodide in a Worker that stays alive so Python loads once. It reaches the
  // bench only through these calls. Abort ends the Worker (Python can't be interrupted mid-line), so the next
  // script loads Python again.
  const PY = { w: null, state: 'off', handler: null };
  function pyWorker() {
    if (PY.w) return PY.w;
    PY.w = new Worker('assets/script-worker.js?v=' + ((window.PLUMB || {}).VERSION || '4'));
    PY.state = 'loading'; renderPy();
    PY.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'loaded') { PY.state = 'ready'; PY.version = m.version; PY.sync = m.sync; log('info', 'Python ' + m.version + ' loaded in ' + fmtQty(m.ms / 1000, 's') + (m.sync ? '' : '. This browser can’t pause Python for the bench, so cmd, tlm, and wait work only at a script’s top level, not inside a def')); renderPy(); return; }
      if (m.type === 'loadfail') { PY.state = 'failed'; log('error', 'Python didn\'t load: ' + m.message); renderPy(); return; }
      if (PY.handler) PY.handler(m);
    };
    PY.w.onerror = (e) => { e.preventDefault(); if (PY.handler) PY.handler({ type: 'error', message: e.message || 'the script runner failed to start' }); };
    return PY.w;
  }
  function pyStop() { if (PY.w) PY.w.terminate(); PY.w = null; PY.state = 'off'; PY.handler = null; renderPy(); }
  function renderPy() {
    const el = $('#py-state'); if (!el) return;
    el.className = 'tb-py st-' + PY.state;
    el.textContent = { off: 'Python not loaded', loading: 'Loading Python…', ready: 'Python ' + (PY.version || '') + ' ready', failed: 'Python failed to load' }[PY.state];
  }
  function runScript(n, ctx) {
    const code = n.body.map((i) => S.tree.lines[i]).map((l) => ' '.repeat(Math.max(0, l.lead - n.lead - 2)) + l.text).join('\n');
    return new Promise((resolve, reject) => {
      if (PY.state !== 'ready') log('info', PY.state === 'loading' ? 'Waiting for Python to load…' : 'Loading Python (about 10 MB, once)…');
      const w = pyWorker();
      const recs = [];
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearInterval(watch); PY.handler = null; fn(v); };
      const watch = setInterval(() => { if (S.abort) { pyStop(); finish(reject, new Abort('Aborted')); } }, 50);
      PY.handler = async (m) => {
        if (m.type === 'done') return finish(resolve, recs.join(', '));
        // Python counts lines from the script's first line; say the line in the whole test file instead.
        if (m.type === 'error') return finish(reject, new Error('Python ' + m.message.replace(/^line (\d+)/, (x, k) => (n.body[k - 1] != null ? 'line ' + (n.body[k - 1] + 1) : x))));
        let result, error;
        try {
          if (m.op === 'cmd') result = await sendCommand(m.args[0] + ' ' + m.args.slice(1).join(' '), ctx);
          else if (m.op === 'tlm') result = (await readRef(m.args[0], ctx)).v;
          else if (m.op === 'wait') { await abortable(m.args[0]); result = true; }
          else if (m.op === 'log') { log('info', String(m.args[0])); result = true; }
          else if (m.op === 'record') { ctx.vars[m.args[0]] = { v: m.args[1], unit: m.args[2] || '' }; recs.push(m.args[0] + ' = ' + fmtQty(m.args[1], m.args[2] || '')); result = true; }
        } catch (err) { if (err instanceof Abort) return finish(reject, err); error = err.message; }
        if (!done && m.id) w.postMessage({ type: 'reply', id: m.id, result, error });
      };
      w.postMessage({ type: 'run', code });
    });
  }

  function operator(msg, buttons) {
    return new Promise((resolve, reject) => {
      $('#modal-text').textContent = msg;
      const box = $('#modal-btns');
      box.innerHTML = buttons.map(([l], i) => '<button class="btn ' + (i === 0 ? 'btn-primary' : '') + '" data-i="' + i + '">' + esc(l) + '</button>').join('');
      $('#modal').hidden = false;
      log('op', 'Waiting for the operator: ' + msg);
      const watch = setInterval(() => { if (S.abort) { close(); reject(new Abort('Aborted')); } }, 50);
      const close = () => { clearInterval(watch); $('#modal').hidden = true; box.onclick = null; };
      box.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; close(); resolve(buttons[+b.dataset.i][1]); };
    });
  }

  function bridgeIn(nodes) { return nodes.some((n) => (n.kind === 'step' && n.step.kind === 'script' && n.step.bridge) || bridgeIn(n.children || [])); }
  async function runTest(test) {
    if (bridgeIn(test.children)) {
      S.results[test.id] = { verdict: 'skip', note: 'Runs in the bench bridge', at: Date.now() };
      log('skip', test.id + ' skipped: it runs in the bench bridge, which reaches what the page can\u2019t');
      renderRows(); return;
    }
    const need = [...needsOf(test, S.tree)];
    const missing = need.filter((t) => !S.defs.targets[t] || !sim.attached[t]);
    if (missing.length) {
      S.results[test.id] = { verdict: 'skip', note: 'Needs ' + missing.join(', ') + (missing.length > 1 ? ', which aren\'t' : ', which isn\'t') + ' attached', at: Date.now() };
      log('skip', test.id + ' skipped: ' + S.results[test.id].note);
      renderRows(); return;
    }
    S.runId = (S.runId || 0) + 1;
    const ctx = { vars: {}, cleanups: [], measurements: [], failed: false, depth: 0 };
    const t0 = now();
    S.results[test.id] = { verdict: 'running' };
    X.marks.push({ t: now(), label: test.id }); if (X.marks.length > 200) X.marks.shift();
    log('head', test.id + ' ' + test.title);
    renderRows();
    let verdict = 'pass', note = '';
    try { await execBlock(test.children, ctx, {}); if (ctx.failed) verdict = 'fail'; else if (ctx.todo) { verdict = 'skip'; note = 'Not written yet'; } }
    catch (e) {
      if (e instanceof Abort) { verdict = 'aborted'; note = 'Aborted'; }
      else if (e.message === 'timeout') verdict = 'fail';
      else { verdict = 'error'; note = e.message; }
    }
    if (ctx.cleanups.length) {
      S.inCleanup = true;
      log('info', 'Cleanup (always runs)');
      // The test's own cleanup first, then those of the tests it called (a call's cleanup undoes what that test set
      // up, such as power, which the caller's cleanup may still need); within one level, last registered first.
      ctx.cleanups.sort((a, b) => a.depth - b.depth || b.seq - a.seq);
      for (const c of ctx.cleanups) {
        try { await execBlock(c.nodes, ctx, c.vars); } catch (e) { log('error', 'Cleanup: ' + e.message); if (verdict === 'pass') { verdict = 'error'; note = 'Cleanup: ' + e.message; } }
      }
      S.inCleanup = false;
    }
    S.current = null;
    S.results[test.id] = { verdict, note, ms: now() - t0, at: Date.now(), measurements: ctx.measurements };
    log(verdict === 'pass' ? 'pass' : verdict === 'aborted' ? 'skip' : 'fail', test.id + ' ' + verdict.toUpperCase() + ' in ' + fmtQty((now() - t0) / 1000, 's'));
    renderRows(); renderEvidence(); renderSummary();
  }

  async function run(tests) {
    if (S.running) return;
    if (brLive()) return brRun(tests);
    S.running = true; S.abort = false;
    $('#abort').disabled = false; $('#run-all').disabled = true; $('#script').readOnly = true;
    renderRows();
    try { for (const t of tests) { if (S.abort) break; await runTest(t); } }
    finally {
      S.running = false; S.abort = false; S.current = null;
      $('#abort').disabled = true; $('#run-all').disabled = false; $('#script').readOnly = false;
      renderRows(); renderSummary();
    }
  }
  const testsUnder = (n) => (n.kind === 'test' ? [n] : n.children.flatMap(testsUnder));


  /* ---------- The bench bridge: real targets, run by the Python bridge on this PC (bridge/run.py) ---------- */
  // The page sends the open bench and asks for a run; the bridge runs it and sends back what the rows show. A run
  // goes on if this page closes, and a page that comes back gets its events so far and any question still waiting.
  const BRIDGE_URL = 'ws://127.0.0.1:47615', BRIDGE_TOKEN = 'plumb.v1.bridge.token';
  const BR = { ws: null, state: 'off', want: false, targets: {}, hash: null, loadWait: null, running: false, retry: 0 };
  function brToken() { try { return localStorage.getItem(BRIDGE_TOKEN) || ''; } catch (e) { return ''; } }
  function brSend(m) { if (BR.ws && BR.ws.readyState === 1) BR.ws.send(JSON.stringify(m)); }
  function brLive() { return BR.state === 'live'; }
  async function brHash(defs, script) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(defs + '\n\u0000\n' + script));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function brSetState(st) { BR.state = st; renderBridge(); renderAttach(); }
  function brConnect() {
    BR.want = true;
    if (BR.ws && BR.ws.readyState <= 1) return;
    brSetState('connecting');
    let ws;
    try { ws = new WebSocket(BRIDGE_URL); } catch (e) { brSetState('off'); return; }
    BR.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: brToken() }));
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } brMsg(m); };
    ws.onclose = (e) => {
      if (BR.ws !== ws) return;
      BR.ws = null;
      if (e.code === 4401 || BR.state === 'pair') { brSetState('pair'); return; }
      if (BR.running) log('info', 'Lost the bench bridge; the run carries on there. Reconnecting…');
      brSetState(BR.want ? 'connecting' : 'off');
      if (BR.want) { clearTimeout(BR.retry); BR.retry = setTimeout(brConnect, 3000); }
    };
  }
  function brDisconnect() {
    BR.want = false; clearTimeout(BR.retry);
    if (BR.ws) { const w = BR.ws; BR.ws = null; w.close(); }
    brSetState('off');
  }
  function brPair(code) {
    try { localStorage.setItem(BRIDGE_TOKEN, String(code).trim()); } catch (e) { /* storage off */ }
    brSetState('connecting'); brConnect();
  }
  function brLoad() {
    if (!brLive() || !CUR) return Promise.resolve(null);
    return new Promise((resolve) => {
      BR.loadWait = resolve;
      brSend({ type: 'load', bench: { id: CUR, name: (ST.get(CUR) || { meta: {} }).meta.name, defs: S.defsText, script: S.text } });
    });
  }
  let brLoadTimer = 0;
  function brLoadSoon() { if (!brLive() || BR.running) return; clearTimeout(brLoadTimer); brLoadTimer = setTimeout(brLoad, 600); }
  function brRunStarted() {
    BR.running = true; S.running = true; S.abort = false;
    $('#abort').disabled = false; $('#run-all').disabled = true; $('#script').readOnly = true;
    renderRows();
  }
  // The bridge answered its own question (Abort, or the run ended): the dialog goes without sending an answer.
  function brCloseAsk() { BR.ask = null; $('#modal').hidden = true; $('#modal-btns').onclick = null; }
  function brRunEnded() {
    if (BR.ask != null) brCloseAsk();
    BR.running = false; S.running = false; S.abort = false; S.current = null;
    $('#abort').disabled = true; $('#run-all').disabled = false; $('#script').readOnly = false;
    renderRows(); renderSummary(); renderEvidence();
  }
  async function brRun(tests) {
    const loaded = await brLoad();
    if (!loaded) return;
    const mine = await brHash(S.defsText, S.text);
    if (mine !== BR.hash) { toast('The bridge has another copy of this bench; try again'); return; }
    brSend({ type: 'run', ids: tests.map((t) => t.id), hash: mine });
  }
  function brMsg(m) {
    switch (m.type) {
      case 'unpaired': BR.state = 'pair'; renderBridge(); break;
      case 'ready':
        brSetState('live'); log('info', 'Bench bridge ' + m.version + ' connected: runs go to the real targets');
        if (m.running) brRunStarted(); else brLoad();
        break;
      case 'loaded': case 'targets':
        BR.targets = m.targets || {}; if (m.hash) BR.hash = m.hash; renderAttach();
        if (BR.loadWait) { const r = BR.loadWait; BR.loadWait = null; r(m); }
        break;
      case 'log': log(m.kind, m.text); break;
      case 'current': S.current = m.idx; renderRows(); break;
      case 'step': { const n = S.tree && S.tree.nodes.find((x) => x.idx === m.idx); if (n) stepRes(n, { verdict: m.verdict, value: m.value, limit: m.limit, note: m.note }); break; }
      case 'test': {
        const r = Object.assign({}, m.result);
        if (r.verdict === 'running') { S.runId = (S.runId || 0) + 1; X.marks.push({ t: now(), label: m.id }); }
        if (r.at) r.at = Math.round(r.at * 1000);
        S.results[m.id] = r; renderRows(); if (r.verdict !== 'running') { renderEvidence(); renderSummary(); }
        break;
      }
      case 'run': if (m.state === 'started') brRunStarted(); else brRunEnded(); break;
      case 'ask': BR.ask = m.id; operator(m.msg, m.choices).then((v) => { BR.ask = null; brSend({ type: 'answer', id: m.id, value: v }); }, () => {}); break;
      case 'ask-done': if (BR.ask === m.id) brCloseAsk(); break;
      case 'error': toast('Bench bridge: ' + m.msg); log('error', 'Bench bridge: ' + m.msg); break;
    }
  }
  function renderBridge() {
    const el = $('#bridge-row'); if (!el) return;
    const st = BR.state;
    const label = { off: 'Not connected', connecting: 'Connecting…', pair: 'Needs pairing', live: 'Connected' }[st];
    el.innerHTML = '<span class="tb-chip' + (st === 'live' ? '' : ' off') + '" title="The bench bridge runs tests on real targets from this PC: python bridge/run.py">' + (st === 'live' ? '✓ ' : '') + label + '</span>' +
      (st === 'pair' ? '<input class="tb-pin tb-bridge-code" id="bridge-code" placeholder="Code" inputmode="numeric" autocomplete="off" title="The pairing code the bridge printed when it started"><button class="btn btn-plain" id="bridge-pair">Pair</button>' : '') +
      '<button class="btn btn-plain" id="bridge-btn">' + (st === 'off' ? 'Connect' : 'Disconnect') + '</button>';
    $('.tb-labctl-head').textContent = st === 'live' ? 'Bench bridge' : 'Simulated bench';
    $('#ctl-fault-row').hidden = st === 'live';
    $('#runs-note').textContent = st === 'live' ? 'Runs go to the real targets through the bench bridge' : 'Runs are simulated until you connect the bench bridge';
  }

  /* ---------- Rendering: rows ---------- */

  const VERDICT = { pass: ['Pass', '✓'], fail: ['Fail', '✕'], error: ['Error', '!'], skip: ['Skipped', '–'], aborted: ['Aborted', '■'], running: ['Running', '●'], done: ['Done', '·'] };
  function badge(v, small) {
    if (!v) return '<span class="tb-v tb-v-none' + (small ? ' sm' : '') + '">' + (small ? '' : 'Not run') + '</span>';
    const [l, g] = VERDICT[v] || [v, ''];
    return '<span class="tb-v tb-v-' + v + (small ? ' sm' : '') + '" title="' + l + '"><i>' + g + '</i>' + (small ? '' : l) + '</span>';
  }

  const FOLD_KEY = 'plumb.v1.ui.folded';
  function foldedSet() {
    try { const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return new Set(all[CUR] || []); } catch (e) { return new Set(); }
  }
  function saveFolded(set) {
    try { const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); if (set.size) all[CUR] = [...set]; else delete all[CUR]; localStorage.setItem(FOLD_KEY, JSON.stringify(all)); } catch (e) { /* storage off */ }
  }
  function groupsUnder(n) { return n.kind === 'group' ? [n] : (n.children || []).flatMap(groupsUnder); }

  function renderRows() {
    const tree = S.tree; if (!tree) return;
    const wrap = $('#rows');
    const scroll = wrap.scrollTop;
    let h = '';
    const kids = tree.root.children;
    if (!kids.length) h = '<p class="tb-empty">No tests yet. Start with <code>suite</code>, <code>group</code>, and <code>test</code> lines in the script.</p>';
    kids.forEach((n) => { h += nodeHtml(n); });
    wrap.innerHTML = h;
    wrap.scrollTop = scroll;
  }

  function counts(n) {
    const c = { pass: 0, fail: 0, error: 0, skip: 0, total: 0 };
    testsUnder(n).forEach((t) => { c.total++; const r = S.results[t.id]; if (r && c[r.verdict] != null) c[r.verdict]++; });
    return c;
  }
  function countsHtml(c) {
    return '<span class="tb-counts">' + c.total + ' test' + (c.total === 1 ? '' : 's') +
      (c.pass ? ' · <b class="cp">' + c.pass + ' passed</b>' : '') + (c.fail ? ' · <b class="cf">' + c.fail + ' failed</b>' : '') +
      (c.error ? ' · <b class="cf">' + c.error + ' errors</b>' : '') + (c.skip ? ' · ' + c.skip + ' skipped' : '') + '</span>';
  }

  function nodeHtml(n, folded) {
    folded = folded || foldedSet();
    if (n.kind === 'group') {
      const shut = folded.has(n.name);
      return '<div class="tb-group' + (shut ? ' folded' : '') + '"><div class="tb-group-head" data-act="fold" data-name="' + esc(n.name) + '" title="' + (shut ? 'Show' : 'Hide') + ' this group\u2019s tests">' +
        '<span class="tb-chev">' + (shut ? '▸' : '▾') + '</span><span class="tb-kind">group</span><b>' + esc(n.name) + '</b>' +
        countsHtml(counts(n)) + '<span class="tb-grow"></span>' +
        '<button class="btn btn-plain" data-act="add-test" data-idx="' + n.idx + '">+ Test</button>' +
        '<button class="btn btn-plain" data-act="run" data-idx="' + n.idx + '"' + (S.running ? ' disabled' : '') + '>▶ Run</button></div>' +
        (shut ? '' : n.children.map((c) => nodeHtml(c, folded)).join('')) + '</div>';
    }
    if (n.kind === 'suite') {
      const gs = groupsUnder(n), allShut = gs.length && gs.every((g) => folded.has(g.name));
      return '<div class="tb-suite"><div class="tb-suite-head"><span class="tb-kind">suite</span><b>' + esc(n.name) + '</b>' +
        countsHtml(counts(n)) + '<span class="tb-grow"></span>' +
        (gs.length ? '<button class="btn btn-plain tb-foldall" data-act="fold-all" data-idx="' + n.idx + '" data-to="' + (allShut ? 'open' : 'shut') + '" title="' + (allShut ? 'Expand every group' : 'Collapse every group') + '">' +
          (allShut ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/><path d="M4 2.5l4 4 4-4" opacity=".5"/></svg>Expand all' : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/><path d="M4 13.5l4-4 4 4" opacity=".5"/></svg>Collapse all') + '</button>' : '') +
        '<button class="btn btn-plain" data-act="run" data-idx="' + n.idx + '"' + (S.running ? ' disabled' : '') + '>▶ Run</button></div>' +
        n.children.map((c) => nodeHtml(c, folded)).join('') + '</div>';
    }
    if (n.kind === 'test') return testHtml(n);
    return '<div class="tb-orphan">' + esc(n.text) + ' <span class="tb-lintmark">✕ ' + esc((S.issues[n.idx] || []).join('; ')) + '</span></div>';
  }

  function testHtml(t) {
    const r = S.results[t.id];
    const open = S.open.has(t.id);
    const need = [...needsOf(t, S.tree)];
    const nIssues = countIssues(t);
    const meas = r && r.measurements ? r.measurements.slice(-2).map((m) => '<span class="tb-meas' + (m.ok ? '' : ' bad') + '">' + esc(m.name.replace(/^[A-Z]+\./, '')) + ' ' + esc(typeof m.value === 'number' ? fmtQty(m.value, m.unit) : m.value) + '</span>').join('') : '';
    let h = '<div class="tb-test' + (open ? ' open' : '') + (r && r.verdict === 'running' ? ' running' : '') + '">' +
      '<div class="tb-test-row' + (S.pick === t.idx ? ' picked' : '') + '" data-act="toggle" data-id="' + esc(t.id) + '" data-pick="' + t.idx + '">' +
      '<span class="tb-chev">' + (open ? '▾' : '▸') + '</span>' + badge(r && r.verdict) +
      '<span class="tb-id">' + esc(t.id) + '</span><span class="tb-ttl">' + esc(t.title) + (nIssues ? ' <span class="tb-lintmark" title="' + nIssues + ' line' + (nIssues > 1 ? 's' : '') + ' to fix">✕ ' + nIssues + '</span>' : '') + '</span>' +
      '<span class="tb-needs">' + need.map((x) => '<span class="tb-chip' + (sim.attached[x] && S.defs.targets[x] ? '' : ' off') + '" title="' + (sim.attached[x] ? 'Uses ' : 'Needs, not attached: ') + x + '">' + esc(x) + '</span>').join('') + '</span>' +
      '<span class="tb-reqs">' + t.reqs.map((q) => '<span class="tb-req">' + esc(q) + '</span>').join('') + '</span>' +
      '<span class="tb-mcol">' + (r && r.note ? '<span class="tb-note-s">' + esc(r.note) + '</span>' : meas) + '</span>' +
      '<span class="tb-time">' + (r && r.ms ? fmtQty(r.ms / 1000, 's') : '') + '</span>' +
      '<button class="btn btn-plain tb-run1" data-act="run" data-idx="' + t.idx + '"' + (S.running ? ' disabled' : '') + ' title="Run this test">▶</button></div>';
    if (open) {
      const endForm = S.form && S.form.mode !== 'edit' && S.form.after == null && S.form.test === t.idx;
      h += '<div class="tb-steps">' + t.children.map((c) => stepHtml(c, 0)).join('') +
        (endForm ? '<div class="tb-sform-wrap" style="--d:0">' + formHtml() + '</div>' : '') +
        '<div class="tb-addrow"><select class="tb-select" data-act="add-step" data-idx="' + t.idx + '"' + (S.running ? ' disabled' : '') + '><option value="">+ Add step…</option>' +
        FORM_KINDS.map((k) => '<option value="' + k + '">' + KIND_LABEL[k] + '</option>').join('') + '</select>' +
        '<span class="tb-dim">Click a step’s kind for a form. Drag ⠿ to move, or Alt+↑ and Alt+↓.</span></div></div>';
    }
    return h + '</div>';
  }
  function countIssues(n) { let c = S.issues[n.idx] ? 1 : 0; n.children.forEach((k) => { c += countIssues(k); }); return c; }

  function stepHtml(n, depth) {
    if (n.kind !== 'step') return '';
    const s = n.step, res = S.steps[n.idx], iss = S.issues[n.idx];
    const kind = s.kind;
    const cur = S.current === n.idx && S.running;
    const editing = S.form && S.form.mode === 'edit' && S.form.idx === n.idx;
    const dis = S.running ? ' disabled' : '';
    const formable = kind !== 'bad' && kind !== 'cleanup';
    let h = '<div class="tb-step k-' + kind + (cur ? ' cur' : '') + (editing ? ' editing' : '') + (S.pick === n.idx ? ' picked' : '') + '" style="--d:' + depth + '" data-step="' + n.idx + '" data-pick="' + n.idx + '">' +
      '<span class="tb-grip" title="Drag to move, or Alt+↑ and Alt+↓">⠿</span>' +
      (formable ? '<button class="tb-skind" data-act="form" data-idx="' + n.idx + '" title="Edit with a form"' + dis + '>' + esc(KIND_LABEL[kind] || kind) + '</button>' : '<span class="tb-skind">' + esc(KIND_LABEL[kind] || kind) + '</span>') +
      '<input class="tb-sedit" data-act="edit" data-idx="' + n.idx + '" value="' + esc(n.text) + '"' + (S.running ? ' readonly' : '') + ' title="The line itself; click the kind on the left for a form">' +
      '<span class="tb-sres">' + (res ? badge(res.verdict, true) + '<span class="tb-sval">' + esc(res.list.length > 1 ? res.list.map((x) => x.value || VERDICT[x.verdict][1]).join(' · ') : (res.value || '')) + '</span>' + (res.limit ? '<span class="tb-slim">' + esc(res.limit) + '</span>' : '') + (res.note ? '<span class="tb-snote">' + esc(res.note) + '</span>' : '') : '') + '</span>' +
      '<span class="tb-sacts">' +
      (formable ? '<button class="tb-sbtn" data-act="form" data-idx="' + n.idx + '" title="Edit with a form"' + dis + '>✎</button>' : '<span></span>') +
      '<button class="tb-sbtn" data-act="ins" data-idx="' + n.idx + '" title="Insert a step below"' + dis + '>+</button>' +
      '<button class="tb-x" data-act="del" data-idx="' + n.idx + '" title="Delete this step"' + dis + '>×</button></span></div>';
    if (iss) h += '<div class="tb-step-issue" style="--d:' + depth + '">✕ ' + esc(iss.join('; ')) + '</div>';
    if (editing) h += '<div class="tb-sform-wrap" style="--d:' + depth + '">' + formHtml() + '</div>';
    if (kind === 'script' && !editing) {
      h += '<pre class="tb-sbody" style="--d:' + (depth + 1) + '"><span class="tb-py-label">' + (n.step.bridge ? 'Python · bench bridge' : 'Python') + '</span>' + esc(n.body.map((i) => ' '.repeat(Math.max(0, S.tree.lines[i].lead - n.lead - 2)) + S.tree.lines[i].text).join('\n')) + '</pre>';
    }
    h += n.children.map((c) => stepHtml(c, depth + 1)).join('');
    if (S.form && S.form.mode !== 'edit' && S.form.after === n.idx) h += '<div class="tb-sform-wrap" style="--d:' + depth + '">' + formHtml() + '</div>';
    return h;
  }

  function subtreeEnd(lines, idx) {
    const lead = lines[idx].lead; let j = idx + 1;
    while (j < lines.length && (!lines[j].text || lines[j].lead > lead)) j++;
    while (j > idx + 1 && !lines[j - 1].text) j--;
    return j;
  }

  /* ---------- Step forms: write a step by picking, without knowing the syntax ---------- */

  // A form reads its step's line, offers only what the bench has (targets, commands, telemetry, units), and writes
  // the line back. The text stays the source: a form is another way to type it.
  const UNIT_CHOICES = { V: ['µV', 'mV', 'V'], A: ['µA', 'mA', 'A'], Hz: ['Hz', 'kHz', 'MHz'], s: ['ms', 's'], W: ['mW', 'W'], 'Ω': ['Ω', 'kΩ', 'MΩ'], '°C': ['°C'], '%': ['%'], baud: ['baud'] };
  const ANY_UNITS = ['', 'V', 'mV', 'µV', 'A', 'mA', 'µA', 'Hz', 'kHz', 'MHz', 's', 'ms', 'W', 'mW', '°C', '%'];
  const unitOpts = (base) => (base == null ? ANY_UNITS : UNIT_CHOICES[base] || [base]);
  const FORM_KINDS = ['command', 'check', 'until', 'wait', 'measure', 'ask', 'tell', 'log', 'call', 'repeat', 'for', 'script', 'cleanup'];
  const KIND_HELP = {
    command: 'Sends a command to a target. Values outside a parameter’s range are refused before anything is sent. When the command returns something (a measurement, a capture), Save the result as keeps it under a name for later checks; in the text that’s written -> name.',
    check: 'Reads a value and compares it with a limit. A failed check marks the test failed and the test carries on.',
    until: 'Reads the value every 100 ms until the condition holds. If the time runs out, the test fails and stops.',
    wait: 'Pauses the test.',
    measure: 'Reads a value and keeps it under a name, with no limit, for a later check or the report.',
    ask: 'Asks the operator a yes or no question. No fails the test.',
    tell: 'Shows the operator a message and waits for OK.',
    log: 'Writes a note in the log.',
    call: 'Runs another test’s steps here. Its cleanup runs when this test ends.',
    repeat: 'Repeats the steps indented under it. $i is the count, 1 first.',
    for: 'Runs the steps indented under it once per item, with $name replaced by the item.',
    script: 'Python, for loops, searches, and math. cmd(), tlm(), wait(), log(), and record() reach the bench; record() keeps a value for a later check.',
    cleanup: 'The steps indented under it always run when the test ends, even after a failure or Abort.',
    todo: 'A step not written yet. The test skips, marked Not written yet, rather than passing with nothing checked.'
  };

  function pointList() {
    const out = [];
    Object.values(S.defs.targets).forEach((t) => t.order.forEach((k) => out.push({ ref: t.name + '.' + k, unit: t.telemetry[k].unit })));
    return out;
  }
  // Names steps record (-> name, measure … as name, record() in Python), with their unit when it can be told.
  function varList() {
    const out = new Map();
    S.tree.nodes.forEach((n) => {
      if (n.kind !== 'step') return;
      const s = n.step;
      if (s.kind === 'command' && s.into) {
        const c = S.defs.targets[s.target] && S.defs.targets[s.target].commands[s.cmd];
        out.set(s.into, c && c.returns === 'text' ? '' : s.target === 'SCOPE' && s.cmd === 'measure' ? ({ vpp: 'V', mean: 'V', freq: 'Hz', duty: '%' }[s.args[1]] || null) : null);
      }
      if (s.kind === 'measure') out.set(s.as, pointUnit(s.ref));
      if (s.kind === 'script') n.body.forEach((i) => { const m = /record\(\s*['"](\w+)['"]\s*,[^,)]*(?:,\s*['"]([^'"]*)['"])?/.exec(S.tree.lines[i].text); if (m) out.set(m[1], m[2] != null ? m[2] : null); });
    });
    return out;
  }
  function pointUnit(ref) { const [tn, k] = ref.split('.'); const t = S.defs.targets[tn]; return t && t.telemetry[k] ? t.telemetry[k].unit : null; }
  function refUnit(ref) { if (ref.includes('.')) return pointUnit(ref); const u = varList().get(ref); return u === undefined ? null : u; }
  function qtyParts(v, base) {
    if (typeof v !== 'number' || !isFinite(v)) return { num: '', unit: base || '' };
    const s = fmtQty(v, base || ''); const i = s.lastIndexOf(' ');
    return i < 0 ? { num: s, unit: '' } : { num: s.slice(0, i), unit: s.slice(i + 1) };
  }
  function qtyText(num, unit) { num = String(num == null ? '' : num).trim(); return num === '' ? '' : num + (unit ? ' ' + unit : ''); }
  const unq = (s) => String(s == null ? '' : s).replace(/"/g, '”');

  function formValues(kind, n) {
    const text = n ? n.text : '', s = text ? parseStep(text) : { kind }, v = { kind };
    const pts = pointList();
    if (kind === 'command') {
      v.target = s.target || Object.keys(S.defs.targets)[0] || '';
      const t = S.defs.targets[v.target];
      v.cmd = s.cmd || (t ? Object.keys(t.commands)[0] : '');
      v.args = s.args ? s.args.slice() : null; v.into = s.into || '';
    }
    if (kind === 'check' || kind === 'until') {
      v.ref = s.ref || (kind === 'until' ? (pts.find((p) => p.unit === '') || pts[0] || {}).ref : (pts.find((p) => p.unit) || pts[0] || {}).ref) || '';
      const c = s.cond, u = refUnit(v.ref);
      const a = (x) => qtyParts(x, c && c.unit ? c.unit : u);
      if (!c) v.op = u === '' ? 'is' : 'range';
      else if (c.op === 'contains') { v.op = 'contains'; v.text = c.a; }
      else if (c.str) { v.op = 'is'; v.text = c.a; }
      else if (c.op === 'range' && c.nom != null) {
        v.op = 'tol'; const p = a(c.nom); v.a = p.num; v.au = p.unit;
        const pm = /(?:±|\+\/-|\+-)\s*([\d.]+)\s*%/.exec(text);
        if (pm) { v.tol = pm[1]; v.tolu = '%'; } else { const q = a(c.b - c.nom); v.tol = q.num; v.tolu = q.unit; }
      } else if (c.op === 'range') { const p = a(c.a), q = a(c.b); v.op = 'range'; v.a = p.num; v.au = p.unit; v.b = q.num; v.bu = q.unit; }
      else { v.op = c.op; const p = a(c.a); v.a = p.num; v.au = p.unit; }
      if (kind === 'until') { const q = qtyParts(s.timeout != null ? s.timeout : 5, 's'); v.t = q.num; v.tu = q.unit; }
    }
    if (kind === 'wait') { const q = qtyParts(s.sec != null ? s.sec : 0.1, 's'); v.t = q.num; v.tu = q.unit; }
    if (kind === 'measure') { v.ref = s.ref || (pts[0] || {}).ref || ''; v.as = s.as || ''; }
    if (kind === 'ask' || kind === 'tell' || kind === 'log') v.msg = s.msg || '';
    if (kind === 'call') v.id = s.id || '';
    if (kind === 'repeat') v.n = s.n || 3;
    if (kind === 'for') { v.var = s.v || 'n'; v.items = s.items ? s.items.join(', ') : '1, 2'; }
    if (kind === 'script') v.bridge = !!s.bridge;
    if (kind === 'script') v.body = n ? n.body.map((i) => ' '.repeat(Math.max(0, S.tree.lines[i].lead - n.lead - 2)) + S.tree.lines[i].text).join('\n') : "# cmd(), tlm(), wait(), log(), and record() reach the bench\nlog('Hello from Python')";
    return v;
  }

  function fSel(name, opts, cur, cls) { return '<select class="tb-select' + (cls ? ' ' + cls : '') + '" data-f="' + name + '">' + opts.map((o) => { const [val, lab, grp] = Array.isArray(o) ? o : [o, o]; return grp === 'group' ? '<optgroup label="' + esc(lab) + '">' : grp === 'end' ? '</optgroup>' : '<option value="' + esc(val) + '"' + (String(val) === String(cur) ? ' selected' : '') + '>' + esc(lab) + '</option>'; }).join('') + '</select>'; }
  function fIn(name, val, ph, cls) { return '<input class="tb-pin' + (cls ? ' ' + cls : '') + '" data-f="' + name + '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') + '" autocomplete="off">'; }
  function fUnit(name, base, cur) {
    const o = unitOpts(base);
    if (o.length === 1 && !o[0]) return '';
    return fSel(name, o.map((u) => [u, u || '(none)']), o.includes(cur) ? cur : o.includes(base) ? base : o[0]);
  }
  function fRow(label, inner, note) { return '<div class="tb-ff"><span class="tb-ffl">' + label + '</span><span class="tb-ffv">' + inner + '</span>' + (note ? '<span class="tb-ffn">' + note + '</span>' : '') + '</div>'; }
  function rangeNote(p) { return p.kind === 'choice' ? p.choices.join(', ') : p.kind === 'range' ? (isFinite(p.range[0]) ? p.range[0] : '') + ' to ' + (isFinite(p.range[1]) ? p.range[1] : '') + (p.unit ? ' ' + p.unit : '') : 'any text'; }

  function subjectSel(name, cur, withVars) {
    const pts = pointList(), vars = withVars ? [...varList().keys()] : [];
    const opts = [['', 'Telemetry', 'group']].concat(pts.map((p) => [p.ref, p.ref + (p.unit ? ' (' + p.unit + ')' : '')])).concat([['', '', 'end']]);
    if (vars.length) opts.push(['', 'Saved by earlier steps', 'group'], ...vars.map((x) => [x, x]), ['', '', 'end']);
    if (cur && !pts.some((p) => p.ref === cur) && !vars.includes(cur)) opts.push([cur, cur + ' (not found)']);
    return fSel(name, opts, cur);
  }
  function condFields(v) {
    const u = refUnit(v.ref), text = u === '';
    const ops = text ? [['is', 'is'], ['contains', 'contains']] : [['range', 'is between'], ['<=', 'is at most'], ['<', 'is below'], ['>=', 'is at least'], ['>', 'is above'], ['==', 'equals'], ['tol', 'is within ± of']];
    if (!ops.some((o) => o[0] === v.op)) v.op = ops[0][0];
    let h = fRow('Compare', fSel('op', ops, v.op), u ? 'Unit: ' + u + (UNIT_CHOICES[u] && UNIT_CHOICES[u].length > 1 ? ' (or ' + UNIT_CHOICES[u].filter((x) => x !== u).join(', ') + ')' : '') : u == null ? 'Unit not known: pick one, or none' : 'A text value');
    if (v.op === 'is' || v.op === 'contains') h += fRow('Text', fIn('text', v.text, 'RUN'));
    else if (v.op === 'range') h += fRow('From', fIn('a', v.a, '3.0', 'num') + fUnit('au', u, v.au)) + fRow('To', fIn('b', v.b, '3.6', 'num') + fUnit('bu', u, v.bu));
    else if (v.op === 'tol') h += fRow('Nominal', fIn('a', v.a, '3.3', 'num') + fUnit('au', u, v.au)) + fRow('Tolerance ±', fIn('tol', v.tol, '3', 'num') + fSel('tolu', ['%'].concat(unitOpts(u).filter((x) => x)), v.tolu || '%'));
    else h += fRow('Value', fIn('a', v.a, '50', 'num') + fUnit('au', u, v.au));
    return h;
  }

  function formFields(v) {
    const T = S.defs.targets;
    if (v.kind === 'command') {
      const t = T[v.target], c = t && t.commands[v.cmd];
      let h = fRow('Target', fSel('target', Object.values(T).map((x) => [x.name, x.name + ' · ' + x.title]), v.target)) +
        (t ? fRow('Command', fSel('cmd', Object.values(t.commands).map((x) => [x.name, x.name]), v.cmd), c && c.wire ? 'Sends: ' + esc(c.wire) : '') : '');
      if (c) {
        if (!v.args) v.args = c.params.map((p) => (p.kind === 'choice' ? p.choices[0] : p.kind === 'range' ? qtyText(isFinite(p.range[0]) ? p.range[0] : 0, p.unit) : ''));
        c.params.forEach((p, i) => {
          const a = v.args[i] == null ? '' : v.args[i], q = parseQty(a);
          let inner;
          if (p.kind === 'choice' && (!a || p.choices.includes(a))) inner = fSel('a' + i, p.choices, a);
          else if (p.kind === 'range' && (a === '' || q)) {
            const parts = q ? qtyParts(q.v, p.unit || '') : { num: '', unit: p.unit };
            inner = fIn('a' + i, parts.num, '', 'num') + fUnit('u' + i, p.unit || '', parts.unit);
          } else inner = fIn('a' + i, a, p.name, 'wide');
          h += fRow(esc(p.name), inner, esc(rangeNote(p)));
        });
        if (c.returns) h += fRow('Save the result as', fIn('into', v.into, 'name, e.g. ' + (c.returns === 'text' ? 'banner' : 'reading')), 'Optional. Later steps can check it by this name');
      }
      return h;
    }
    if (v.kind === 'check') return fRow('Check', subjectSel('ref', v.ref, true)) + condFields(v);
    if (v.kind === 'until') return fRow('Until', subjectSel('ref', v.ref, false)) + condFields(v) + fRow('Give up after', fIn('t', v.t, '5', 'num') + fSel('tu', ['ms', 's'], v.tu || 's'));
    if (v.kind === 'wait') return fRow('Wait', fIn('t', v.t, '200', 'num') + fSel('tu', ['ms', 's'], v.tu || 'ms'));
    if (v.kind === 'measure') return fRow('Read', subjectSel('ref', v.ref, false)) + fRow('Save as', fIn('as', v.as, 'board_temp'), 'Letters, digits, and _');
    if (v.kind === 'ask' || v.kind === 'tell' || v.kind === 'log') return fRow(v.kind === 'ask' ? 'Question' : 'Message', fIn('msg', v.msg, v.kind === 'ask' ? 'Is the LED green?' : 'Press the button now', 'wide'));
    if (v.kind === 'call') {
      const ids = Object.values(S.tree.tests).filter((t) => !S.form || t.idx !== S.form.test).map((t) => [t.id, t.id + ' · ' + t.title]);
      return fRow('Test', fSel('id', ids, v.id || (ids[0] || [])[0]));
    }
    if (v.kind === 'repeat') return fRow('Times', fIn('n', v.n, '3', 'num'));
    if (v.kind === 'for') return fRow('Name', fIn('var', v.var, 'n'), 'Write $' + esc(v.var || 'n') + ' in the steps under it') + fRow('Items', fIn('items', v.items, '1, 2, 3', 'wide'), 'Separated by commas');
    if (v.kind === 'script') return '<textarea class="tb-code tb-sform-py" data-f="body" spellcheck="false" wrap="off">' + esc(v.body) + '</textarea>';
    return '';
  }

  function stepLine(v) {
    const T = S.defs.targets;
    const cond = () => {
      if (v.op === 'is') return '== "' + unq(v.text) + '"';
      if (v.op === 'contains') return 'contains "' + unq(v.text) + '"';
      if (v.op === 'range') return qtyText(v.a, v.au) + ' .. ' + qtyText(v.b, v.bu);
      if (v.op === 'tol') return qtyText(v.a, v.au) + ' ± ' + (v.tolu === '%' ? String(v.tol).trim() + '%' : qtyText(v.tol, v.tolu));
      return v.op + ' ' + qtyText(v.a, v.au);
    };
    switch (v.kind) {
      case 'command': {
        const t = T[v.target], c = t && t.commands[v.cmd];
        if (!c) return '';
        const args = c.params.map((p, i) => { const a = String(v.args && v.args[i] != null ? v.args[i] : '').trim(); return v['u' + i] !== undefined && p.kind === 'range' && /^[-+]?[\d.]+$/.test(a) ? qtyText(a, v['u' + i]) : /\s/.test(a) && !parseQty(a) ? '"' + unq(a) + '"' : a; });
        return v.target + '.' + v.cmd + (args.length ? ' ' + args.join(' ') : '') + (c.returns && v.into ? ' -> ' + String(v.into).trim().replace(/\W+/g, '_') : '');
      }
      case 'check': return 'check ' + v.ref + ' ' + cond();
      case 'until': return 'wait until ' + v.ref + ' ' + cond() + ' within ' + qtyText(v.t, v.tu);
      case 'wait': return 'wait ' + qtyText(v.t, v.tu);
      case 'measure': return 'measure ' + v.ref + ' as ' + (String(v.as || '').trim().replace(/\W+/g, '_') || 'value');
      case 'ask': case 'tell': case 'log': case 'todo': return v.kind + ' "' + unq(v.msg) + '"';
      case 'call': return 'call ' + v.id;
      case 'repeat': return 'repeat ' + (parseInt(v.n, 10) || 1);
      case 'for': return 'for ' + (String(v.var || 'n').trim().replace(/\W+/g, '_')) + ' in ' + String(v.items || '').split(',').map((x) => x.trim()).filter(Boolean).join(', ');
      case 'script': return v.bridge ? 'script on bridge' : 'script';
      case 'cleanup': return 'cleanup';
    }
    return '';
  }

  function formHtml() {
    const f = S.form, v = f.v;
    if (f.mode === 'pick') {
      return '<div class="tb-sform tb-spick" data-form><span class="tb-ffl">Insert</span>' +
        FORM_KINDS.map((k) => '<button class="tb-chipbtn" data-act="pick-kind" data-kind="' + k + '">' + esc(KIND_LABEL[k]) + '</button>').join('') +
        '<button class="btn btn-plain" data-act="form-cancel">Cancel</button></div>';
    }
    const line = stepLine(v), ps = line ? parseStep(line) : null;
    return '<div class="tb-sform" data-form>' +
      '<div class="tb-sform-head"><span class="tb-kind">' + (f.mode === 'edit' ? 'Edit' : 'New') + '</span><b>' + esc(KIND_LABEL[v.kind]) + '</b>' +
      (f.mode === 'edit' ? '' : fSel('kind', FORM_KINDS.map((k) => [k, KIND_LABEL[k]]), v.kind, 'tb-sform-kind')) + '</div>' +
      '<p class="tb-sform-help">' + esc(KIND_HELP[v.kind] || '') + '</p>' +
      formFields(v) +
      '<div class="tb-sform-prev"><span class="tb-ffl">Line</span><code id="form-line">' + esc(line) + '</code>' + (ps && ps.kind === 'bad' ? '<span class="tb-lintmark">✕ incomplete</span>' : '') + '</div>' +
      '<div class="tb-sform-acts"><button class="btn btn-primary" data-act="form-save">' + (f.mode === 'edit' ? 'Save' : 'Add step') + '</button><button class="btn" data-act="form-cancel">Cancel</button></div></div>';
  }

  function readForm(el) {
    const v = S.form.v;
    el.querySelectorAll('[data-f]').forEach((x) => {
      const k = x.dataset.f;
      if (/^a\d+$/.test(k)) { (v.args = v.args || [])[+k.slice(1)] = x.value; } else v[k] = x.value;
    });
    return v;
  }
  function bodyLines(text, lead) {
    const out = String(text || '').replace(/\r/g, '').split('\n').map((l) => { const t = l.replace(/\s+$/, ''); return t ? { lead: lead + 2 + (t.length - t.trimStart().length), text: t.trimStart() } : { lead: 0, text: '' }; });
    while (out.length && !out[out.length - 1].text) out.pop();
    return out.length ? out : [{ lead: lead + 2, text: 'pass' }];
  }
  function insertPoint(f) {
    const lines = S.tree.lines;
    if (f.after != null) return { at: subtreeEnd(lines, f.after), lead: lines[f.after].lead };
    const test = S.tree.nodes.find((x) => x.idx === f.test);
    const cl = test.children.find((c) => c.kind === 'step' && c.step.kind === 'cleanup');
    return { at: f.v.kind === 'cleanup' || !cl ? subtreeEnd(lines, f.test) : cl.idx, lead: test.lead + 2 };
  }
  function saveForm() {
    const f = S.form, v = f.v, line = stepLine(v);
    if (!line) return;
    const lines = S.tree.lines.slice();
    if (f.mode === 'edit') {
      const n = S.tree.nodes.find((x) => x.idx === f.idx);
      const end = n.step.kind === 'script' && n.body.length ? n.body[n.body.length - 1] + 1 : f.idx + 1;
      const repl = [{ lead: n.lead, text: line }].concat(v.kind === 'script' ? bodyLines(v.body, n.lead) : []);
      lines.splice(f.idx, end - f.idx, ...repl);
    } else {
      const { at, lead } = insertPoint(f);
      const add = [{ lead, text: line }];
      if (v.kind === 'script') add.push(...bodyLines(v.body, lead));
      if (v.kind === 'repeat' || v.kind === 'for') add.push({ lead: lead + 2, text: 'log "Steps to repeat go here"' });
      if (v.kind === 'cleanup') add.push({ lead: lead + 2, text: 'log "Steps that always run go here"' });
      lines.splice(at, 0, ...add);
    }
    S.form = null; setLines(lines);
  }
  function openForm(mode, opts) {
    if (S.running) return;
    if (mode === 'edit') {
      const n = S.tree.nodes.find((x) => x.idx === opts.idx);
      if (!n || n.step.kind === 'bad' || n.step.kind === 'cleanup') return;
      S.form = { mode, idx: n.idx, test: testOf(n).idx, v: formValues(n.step.kind, n) };
    } else if (mode === 'pick') S.form = { mode, test: opts.test, after: opts.after, v: {} };
    else S.form = { mode: 'new', test: opts.test, after: opts.after, v: formValues(opts.kind) };
    renderRows();
    const el = $('#rows [data-form]'); if (el) { el.scrollIntoView({ block: 'nearest' }); const first = el.querySelector('input, select, textarea'); if (first && mode !== 'pick') first.focus(); }
  }
  function testOf(n) { while (n && n.kind !== 'test') n = n.parent; return n; }

  // Moving a step moves its whole block (a cleanup or repeat takes its steps), re-indented to its new place.
  function moveStep(from, to, where) {
    const lines = S.tree.lines.slice(), fEnd = subtreeEnd(lines, from);
    if (to >= from && to < fEnd) return null;
    const delta = lines[to].lead - lines[from].lead;
    const block = lines.slice(from, fEnd).map((l) => (l.text ? { lead: l.lead + delta, text: l.text } : l));
    let at = where === 'after' ? subtreeEnd(lines, to) : to;
    lines.splice(from, fEnd - from);
    if (at > from) at -= fEnd - from;
    lines.splice(at, 0, ...block);
    S.steps = {}; S.form = null; setLines(lines);
    return at;
  }
  function moveBy(idx, dir) {
    const n = S.tree.nodes.find((x) => x.idx === idx); if (!n) return;
    const sib = n.parent.children.filter((c) => c.kind === 'step');
    const k = sib.indexOf(n), o = sib[k + dir];
    if (!o) return;
    const at = moveStep(idx, o.idx, dir < 0 ? 'before' : 'after');
    if (at != null) requestAnimationFrame(() => { const el = $('#rows .tb-sedit[data-idx="' + at + '"]'); if (el) el.focus(); });
  }

  /* ---------- Script view: suggestions and hints as you type ---------- */

  // Suggestions come from the bench (targets, commands, telemetry, units) and the file (tests, saved names).
  // Up and Down pick, Enter or Tab takes one, Esc closes, Ctrl+Space asks.
  const KEYWORDS = [
    ['check ', 'compare a value with a limit'], ['wait ', 'pause: wait 200 ms'], ['wait until ', 'wait for a condition … within 5 s'],
    ['measure ', 'keep a value: measure T.point as name'], ['ask "', 'yes or no question for the operator'], ['tell "', 'a message the operator acknowledges'],
    ['log "', 'a note in the log'], ['todo "', 'a step not written yet (the test skips)'], ['call ', 'run another test’s steps'], ['repeat ', 'repeat the steps under it'], ['for ', 'for n in 1, 2 (then $n)'],
    ['script', 'Python, indented under it'], ['cleanup', 'steps under it always run'], ['test ', 'test ID Title [REQ-…]'], ['group ', 'a group of tests'], ['suite ', 'a suite of groups']
  ];
  const AC = { items: [], hint: '', sel: 0, from: 0, to: 0, open: false };
  function cmdSig(c) { return c.params.map((p) => p.name + ' ' + (p.kind === 'choice' ? p.choices.join('|') : p.kind === 'range' ? rangeNote(p) : 'text')).join(', '); }
  function condHint(ref) {
    const u = refUnit(ref);
    if (u === '') return 'Then == "TEXT" or contains "TEXT"';
    const unit = u || 'V', alt = (UNIT_CHOICES[unit] || [unit]).join(', ');
    return 'Then a limit: 3.0 ' + unit + ' .. 3.6 ' + unit + '  ·  < 50 ' + (unit === 'V' ? 'mV' : unit) + '  ·  >= 1 ' + unit + '  ·  3.3 ' + unit + ' ± 3% (type +/- for ±)  ·  units ' + alt + (u == null ? ' (unit not known)' : '');
  }
  function acCompute(ta) {
    const pos = ta.selectionStart; if (pos !== ta.selectionEnd) return null;
    const val = ta.value, ls = val.lastIndexOf('\n', pos - 1) + 1, before = val.slice(ls, pos);
    const lineNo = val.slice(0, ls).split('\n').length - 1, T = S.defs.targets, tree = parseScript(val);
    const inPy = tree.nodes.some((n) => n.kind === 'step' && n.step.kind === 'script' && (n.body.includes(lineNo) || (lineNo > n.idx && n.body.length && lineNo < n.body[n.body.length - 1])));
    const res = { items: [], hint: '', from: pos, to: pos, lineNo, col: before.length };
    const take = (part, list) => { const p = part.toLowerCase(); res.from = pos - part.length; res.items = list.filter((x) => x.label.toLowerCase().startsWith(p) && x.label !== part).slice(0, 40); };
    let m;
    if (inPy) {
      if ((m = /\b(cmd|tlm)\(\s*['"]([\w.]*)$/.exec(before))) {
        const list = [];
        Object.values(T).forEach((t) => { if (m[1] === 'cmd') Object.values(t.commands).forEach((c) => list.push({ label: t.name + '.' + c.name, insert: t.name + '.' + c.name, detail: cmdSig(c) })); else t.order.forEach((k) => list.push({ label: t.name + '.' + k, insert: t.name + '.' + k, detail: t.telemetry[k].unit || 'text' })); });
        take(m[2], list);
      } else if ((m = /\b(cmd)\(\s*['"]([A-Z][A-Z0-9_]*)\.(\w+)['"]\s*,[^)]*$/.exec(before)) && T[m[2]] && T[m[2]].commands[m[3]]) res.hint = m[2] + '.' + m[3] + ': ' + cmdSig(T[m[2]].commands[m[3]]) + ', each as a string, e.g. \'24 V\'';
      else if (/\bwait\($/.test(before)) res.hint = 'Milliseconds: wait(150)';
      return res.items.length || res.hint ? res : null;
    }
    if ((m = /^(\s*)([A-Za-z_]*)$/.exec(before)) && (m[2] || ta.dataset.ask)) {
      take(m[2], KEYWORDS.map(([k, d]) => ({ label: k.trim(), insert: k, detail: d })).concat(Object.values(T).map((t) => ({ label: t.name, insert: t.name + '.', detail: t.title, more: true }))));
    } else if ((m = /([A-Z][A-Z0-9_]*)\.(\w*)$/.exec(before)) && T[m[1]]) {
      const t = T[m[1]], read = /^\s*(check|wait until|measure)\s/.test(before);
      const list = read ? t.order.map((k) => ({ label: k, insert: k + ' ', detail: (t.telemetry[k].unit || 'text') + (limText(t.telemetry[k]) ? ' · ' + limText(t.telemetry[k]) : ''), more: true }))
        : Object.values(t.commands).map((c) => ({ label: c.name, insert: c.name + (c.params.length ? ' ' : ''), detail: cmdSig(c) || 'no parameters', more: true }));
      take(m[2], list);
    } else if ((m = /^\s*call\s+(\S*)$/.exec(before))) {
      take(m[1], Object.values(tree.tests).map((t) => ({ label: t.id, insert: t.id, detail: t.title })));
    } else if ((m = /^\s*(check|wait until)\s+(\S*)$/.exec(before))) {
      const vars = [...varList().keys()].map((x) => ({ label: x, insert: x + ' ', detail: 'saved by an earlier step', more: true }));
      take(m[2], (m[1] === 'check' ? vars : []).concat(Object.values(T).map((t) => ({ label: t.name, insert: t.name + '.', detail: t.title, more: true }))));
    } else if ((m = /^\s*measure\s+(\S*)$/.exec(before))) {
      take(m[1], Object.values(T).map((t) => ({ label: t.name, insert: t.name + '.', detail: t.title, more: true })));
    } else if ((m = /^\s*([A-Z][A-Z0-9_]*)\.(\w+)\s+(.*)$/.exec(before)) && T[m[1]] && T[m[1]].commands[m[2]]) {
      const c = T[m[1]].commands[m[2]], given = (m[3].match(/"[^"]*"|\S+/g) || []).length;
      const p = c.params[Math.min(given - (/\s$/.test(m[3]) || !m[3] ? 0 : 1), c.params.length - 1)];
      if (p && p.kind === 'choice' && /\s$|^$/.test(m[3])) { res.items = p.choices.map((x) => ({ label: x, insert: x + ' ', detail: p.name })); }
      res.hint = m[1] + '.' + m[2] + ' ' + c.params.map((q) => q === p ? '[' + q.name + ']' : q.name).join(' ') + (p ? '  ·  ' + p.name + ': ' + rangeNote(p) : '') + (c.returns ? '  ·  end with -> name to keep the result' : '');
    } else if ((m = /^\s*(check|wait until)\s+(\S+)\s+(.*)$/.exec(before))) {
      const done = m[1] === 'check' ? parseCond(m[3]) : /\swithin\s+\S+\s*\S*$/.test(m[3]) && parseStep(before.trim()).timeout != null;
      if (!done) res.hint = m[1] === 'wait until' && parseCond(m[3]) ? 'Then within 5 s (or 500 ms)' : condHint(m[2]) + (m[1] === 'wait until' ? '  ·  then within 5 s' : '');
    } else if (/^\s*wait\s+\S*$/.test(before)) res.hint = 'A time: 200 ms or 2 s';
    return res.items.length || res.hint ? res : null;
  }
  function acRender(ta) {
    const box = $('#ac');
    if (!AC.open) { box.hidden = true; return; }
    const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight);
    const ctx = acRender.ctx || (acRender.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = cs.fontSize + ' ' + cs.fontFamily;
    const cw = ctx.measureText('MMMMMMMMMM').width / 10;
    box.innerHTML = AC.items.map((x, i) => '<div class="tb-ac-i' + (i === AC.sel ? ' on' : '') + '" data-i="' + i + '"><b>' + esc(x.label) + '</b><span>' + esc(x.detail || '') + '</span></div>').join('') +
      (AC.hint ? '<div class="tb-ac-hint">' + esc(AC.hint) + '</div>' : '');
    box.hidden = false;
    const wrap = ta.parentElement.getBoundingClientRect();
    let left = 15 + AC.col * cw - ta.scrollLeft, top = 13 + (AC.lineNo + 1) * lh - ta.scrollTop + 2;
    left = Math.max(4, Math.min(left, wrap.width - box.offsetWidth - 4));
    if (top + box.offsetHeight > wrap.height && top - lh - box.offsetHeight - 6 > 0) top = top - lh - box.offsetHeight - 6;
    box.style.left = left + 'px'; box.style.top = top + 'px';
    const on = box.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function acUpdate(ta) {
    const r = acCompute(ta);
    delete ta.dataset.ask;
    if (!r) { AC.open = false; acRender(ta); return; }
    Object.assign(AC, r, { open: true, sel: Math.min(AC.open ? AC.sel : 0, Math.max(0, r.items.length - 1)) });
    acRender(ta);
  }
  function acAccept(ta, i) {
    const x = AC.items[i]; if (!x) return;
    ta.focus(); ta.setRangeText(x.insert, AC.from, AC.to, 'end');
    ta.dispatchEvent(new Event('input'));
    if (x.more) acUpdate(ta); else { AC.open = false; acRender(ta); acUpdate(ta); }
  }
  function bindAutocomplete() {
    const ta = $('#script');
    const box = document.createElement('div'); box.id = 'ac'; box.className = 'tb-ac'; box.hidden = true; ta.parentElement.appendChild(box);
    ta.addEventListener('input', (e) => { if (e.isTrusted || e.inputType) acUpdate(ta); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); ta.dataset.ask = '1'; acUpdate(ta); return; }
      if (!AC.open) return;
      if (e.key === 'Escape') { e.preventDefault(); AC.open = false; acRender(ta); return; }
      if (!AC.items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); AC.sel = (AC.sel + 1) % AC.items.length; acRender(ta); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); AC.sel = (AC.sel - 1 + AC.items.length) % AC.items.length; acRender(ta); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acAccept(ta, AC.sel); }
    });
    ta.addEventListener('click', () => { if (AC.open) acUpdate(ta); });
    ta.addEventListener('scroll', () => { if (AC.open) acRender(ta); });
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) { AC.open = false; acRender(ta); } }, 150));
    box.addEventListener('mousedown', (e) => { const it = e.target.closest('[data-i]'); if (!it) return; e.preventDefault(); acAccept(ta, +it.dataset.i); });
  }

  /* ---------- Step reference (the side panel) ---------- */

  function openReference() {
    INSP.k = -1; AC.open = false; acRender($('#script'));
    document.querySelectorAll('.tb-target.sel').forEach((el) => el.classList.remove('sel'));
    const row = (k, ex, what) => '<tr><td><b>' + esc(KIND_LABEL[k] || k) + '</b></td><td><code>' + esc(ex) + '</code><div class="tb-dim">' + what + '</div></td></tr>';
    const T = S.defs.targets;
    $('#inspector').innerHTML =
      '<div class="insp-head"><span class="insp-crumb">Tests › Step reference</span>' +
      '<button class="icon-btn" data-act="insp-close" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>' +
      '<div class="insp-body tb-ref">' +
      '<div class="insp-title">Writing steps</div>' +
      '<p class="hint"><b>No need to memorize this</b>In Rows, click a step’s kind (or ✎) for a form, and + to insert one below. In Script, suggestions appear as you type; Ctrl+Space asks for them.</p>' +
      '<table class="tb-ref-t"><tbody>' +
      row('command', 'PSU.set_voltage 24 V', 'Target, a dot, the command, then its parameters. Add <code>-> name</code> to keep what it returns.') +
      row('check', 'check MAIN.rail_3v3 3.3 V ± 3%', 'Limits: <code>3.0 V .. 3.6 V</code>, <code>&lt; 50 mV</code>, <code>&lt;=</code>, <code>&gt;</code>, <code>&gt;=</code>, <code>== 1.4</code>, <code>== "RUN"</code>, <code>contains "OK"</code>, <code>3.3 V ± 3%</code>, <code>3.3 V ± 50 mV</code>. Type <code>+/-</code> for ±.') +
      row('until', 'wait until MAIN.state == "RUN" within 5 s', 'The same limits, checked every 100 ms; fails when the time runs out.') +
      row('wait', 'wait 200 ms', 'ms or s.') +
      row('measure', 'measure MAIN.temp as board_temp', 'Keeps a value under a name, with no limit.') +
      row('todo', 'todo "Read the fault flags once bit conditions exist"', 'A placeholder for a step not written yet: the test skips, marked <b>Not written yet</b>, so a stub never passes.') +
      row('ask', 'ask "Is the LED green?"', 'Yes or No for the operator; No fails the test. <code>tell</code> and <code>log</code> work the same way.') +
      row('call', 'call PWR-01', 'Runs that test’s steps here; its cleanup waits until this test ends.') +
      row('repeat', 'repeat 3', 'Repeats the indented steps; <code>$i</code> is the count.') +
      row('for', 'for n in 1, 2', 'Runs the indented steps once per item; write <code>$n</code> in them. A value kept by <code>measure</code>, <code>-&gt;</code>, or <code>record</code> goes into a command the same way: <code>PSU.set_voltage $v0 V</code>.') +
      row('script', 'script', 'Python, indented under it. <code>cmd(\'PSU.set_voltage\', \'24 V\')</code>, <code>tlm(\'MAIN.state\')</code>, <code>wait(150)</code>, <code>log(\'…\')</code>, <code>record(\'name\', value, \'V\')</code>.') +
      row('script', 'script on bridge', 'Python for the bench bridge: a debug probe, a mounted drive, or files on disk, which the page can\u2019t reach. A test holding one skips here, marked <b>Runs in the bench bridge</b>.') +
      row('cleanup', 'cleanup', 'The indented steps always run when the test ends, even after a failure or Abort.') +
      '</tbody></table>' +
      '<h4>Units</h4><p class="tb-dim">V, mV, µV (or uV) · A, mA, µA · Hz, kHz, MHz · s, ms · W, mW · °C · %. A space goes between the number and the unit: <code>50 mV</code> is 0.05 V.</p>' +
      '<h4>Layout</h4><p class="tb-dim"><code>suite</code>, then <code>group</code>, then <code>test ID Title [REQ-004]</code>, each indented two spaces under the last; steps two more under their test. <code>#</code> starts a comment.</p>' +
      '<h4>On this bench</h4>' + Object.values(T).map((t) => '<div class="tb-ref-tg"><b>' + esc(t.name) + '</b> <span class="tb-dim">' + esc(t.title) + '</span>' +
        (Object.keys(t.commands).length ? '<div><span class="tb-dim">Commands</span> ' + Object.values(t.commands).map((c) => '<code title="' + esc(cmdSig(c)) + '">' + esc(c.name) + '</code>').join(' ') + '</div>' : '') +
        (t.order.length ? '<div><span class="tb-dim">Telemetry</span> ' + t.order.map((k) => '<code title="' + esc(t.telemetry[k].unit || 'text') + '">' + esc(k) + '</code>').join(' ') + '</div>' : '') + '</div>').join('') +
      '</div>';
    $('#inspector').classList.add('open');
  }

  /* ---------- Rendering: the rest ---------- */

  function renderLint() {
    const items = Object.keys(S.issues).map(Number).sort((a, b) => a - b);
    $('#lint').innerHTML = items.length
      ? items.map((i) => '<div class="tb-lint-row"><span>Line ' + (i + 1) + '</span>' + esc(S.issues[i].join('; ')) + '</div>').join('')
      : '<div class="tb-lint-ok">✓ Every step reads, every target and test it names exists.</div>';
  }
  function renderRoundTrip() {
    const again = serialize(parseScript(S.text).lines);
    const norm = S.text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n*$/, '\n');
    const ok = again === norm;
    $('#roundtrip').innerHTML = ok ? '<span class="tb-rt-ok" title="Parsing this text and writing it back gives the same text">✓ Text ↔ rows exact</span>' : '<span class="tb-rt-bad">✕ Round trip differs</span>';
  }
  function renderSummary() {
    const c = counts(S.tree.root);
    $('#summary').innerHTML = countsHtml(c);
    renderSide();
  }
  function renderEvidence() {
    const reqs = {};
    Object.values(S.tree.tests).forEach((t) => t.reqs.forEach((q) => { (reqs[q] = reqs[q] || []).push(t); }));
    const keys = Object.keys(reqs).sort();
    $('#evidence').innerHTML = keys.length ? '<table class="tb-ev"><tbody>' + keys.map((q) => {
      const ts = reqs[q]; const rs = ts.map((t) => S.results[t.id]).filter(Boolean);
      const v = !rs.length ? null : rs.some((r) => r.verdict === 'fail' || r.verdict === 'error') ? 'fail' : rs.every((r) => r.verdict === 'pass') && rs.length === ts.length ? 'pass' : rs.some((r) => r.verdict === 'skip') ? 'skip' : null;
      return '<tr><td><span class="tb-req">' + esc(q) + '</span></td><td>' + ts.map((t) => esc(t.id)).join(', ') + '</td><td>' + badge(v) + '</td></tr>';
    }).join('') + '</tbody></table><button class="btn" disabled title="Comes with Send to Signoff EE">Send as evidence to Signoff EE…</button>' : '<p class="tb-dim">No test names a requirement. Add <code>[REQ-…]</code> to a test line.</p>';
  }
  let logRaf = 0;
  function renderLog() {
    if (logRaf) return;
    logRaf = requestAnimationFrame(() => {
      logRaf = 0;
      const el = $('#log');
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      el.innerHTML = S.log.slice(-250).map((l) => '<div class="tb-ll k-' + l.kind + '"><span>' + l.t + '</span>' + esc(l.text) + '</div>').join('');
      if (atEnd) el.scrollTop = el.scrollHeight;
    });
  }

  /* ---------- Bench view ---------- */

  function renderTargets() {
    const T = S.defs.targets;
    const order = defBlocks(S.defsText).blocks.map((b) => b.name);
    $('#targets').innerHTML = Object.values(T).map((t) => {
      const ip = ifacePath(t.iface);
      const att = sim.attached[t.name];
      const cmds = Object.values(t.commands);
      const k = order.indexOf(t.name);
      return '<div class="tb-card tb-target' + (att ? '' : ' off') + (k === INSP.k ? ' sel' : '') + '" data-target="' + t.name + '" data-k="' + k + '" title="Click for its properties">' +
        '<div class="tb-t-head"><div><div class="tb-t-name">' + esc(t.name) + '</div><div class="tb-t-title">' + esc(t.title) + '</div></div>' +
        '<span class="tb-t-state">' + (att ? '<i class="ok"></i>Attached' : '<i></i>Not attached') + '</span></div>' +
        '<div class="tb-t-iface"><span class="tb-chip">' + esc(ip.label) + '</span><span class="tb-dim">' + esc(ip.path) + ' · simulated here</span></div>' +
        (t.order.length ? '<table class="tb-tlm"><tbody>' + t.order.map((k) => {
          const tl = t.telemetry[k];
          return '<tr data-tlm="' + k + '"><td class="tb-tk">' + esc(k) + '</td><td class="tb-tv">–</td><td class="tb-tl">' + limText(tl) + '</td><td class="tb-spark"><svg viewBox="0 0 80 20" preserveAspectRatio="none"><polyline points=""/></svg></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="tb-dim tb-notlm">No telemetry; commands return their data.</p>') +
        (cmds.length ? '<div class="tb-send"><select class="tb-select" data-act="pick-cmd">' + cmds.map((c) => '<option>' + esc(c.name) + '</option>').join('') + '</select><span class="tb-params"></span><button class="btn btn-primary" data-act="send"' + (att ? '' : ' disabled') + '>Send</button></div><div class="tb-sent"></div>' : '') +
        '</div>';
    }).join('') + '<button class="tb-card tb-target-add" data-act="add-target"><span>+</span>Add a target<small>A supply, an instrument, or a board, defined in a few lines of text</small></button>';
    document.querySelectorAll('.tb-target').forEach((el) => drawParams(el));
    const bad = S.defs.errors.length;
    $('#bench-note').innerHTML = 'Each card is a target: its interface, live telemetry, and a command sender. Click a card to open its properties, where its definition is plain text you can edit.' +
      (bad ? ' <span class="tb-lintmark">✕ ' + bad + ' line' + (bad > 1 ? 's' : '') + ' in the definitions to fix</span>' : '');
  }
  /* ---------- Target properties: each target's own lines of the definitions text ---------- */

  // The definitions stay one text (the file the tool would store); a target's properties show and edit only the
  // lines from its `target` line up to the next one. Comments above the first target stay as they are.
  function defBlocks(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const starts = [];
    lines.forEach((l, i) => { const m = /^target\s+([A-Z][A-Z0-9_]*)/.exec(l.trim()); if (m && !/^\s/.test(l)) starts.push({ i, name: m[1] }); });
    return { lines, blocks: starts.map((s, k) => ({ name: s.name, start: s.i, end: k + 1 < starts.length ? starts[k + 1].i : lines.length })) };
  }
  function blockText(b, lines) { return lines.slice(b.start, b.end).join('\n').replace(/\s+$/, ''); }
  function setBlock(k, text) {
    const d = defBlocks(S.defsText);
    const b = d.blocks[k];
    const tail = k === d.blocks.length - 1 ? '\n' : '\n\n';
    const head = d.lines.slice(0, b ? b.start : d.lines.length).join('\n');
    const rest = b ? d.lines.slice(b.end).join('\n') : '';
    S.defsText = (head ? head.replace(/\s*$/, '\n\n') : '') + (text ? text.replace(/\s+$/, '') + tail : '') + (rest ? rest.replace(/^\s+/, '') : '');
    S.defsText = S.defsText.replace(/\s+$/, '') + '\n';
  }
  function defsChanged() {
    loadDefs(); reparse(true);
    X.plotted = X.plotted.filter(unitFor2);
    if (!$('[data-pane="bench"]').hidden) { renderTargets(); tickBench(); }
  }

  const INSP = { k: -1, timer: 0 };
  function openTarget(k) {
    INSP.k = k;
    const d = defBlocks(S.defsText), b = d.blocks[k];
    if (!b) return closeTarget();
    $('#inspector').innerHTML =
      '<div class="insp-head"><span class="insp-crumb" id="insp-crumb">Bench › ' + esc(b.name) + '</span>' +
      '<button class="icon-btn" data-act="insp-close" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>' +
      '<div class="insp-body">' +
      '<div class="insp-title" id="insp-title"></div>' +
      '<div class="tb-insp-iface" id="insp-iface"></div>' +
      '<div class="field"><label for="insp-def">Definition</label>' +
      '<textarea id="insp-def" class="tb-code tb-insp-def" spellcheck="false" wrap="off">' + esc(blockText(b, d.lines)) + '</textarea>' +
      '<div class="tb-lint" id="insp-lint"></div></div>' +
      '<div class="hint"><b>The format</b><code>interface</code> serial, lan, or usb and its settings; <code>command name p=0..30V q=on|off "WIRE {p}"</code>, with <code>-&gt; name</code> when it returns data; <code>telemetry name unit "query" yellow lo..hi red lo..hi</code>, limits in base units, <code>-</code> for a value without a unit.</div>' +
      '<div class="tb-insp-acts"><button class="btn btn-danger" data-act="insp-remove">Remove target</button></div>' +
      '</div>';
    $('#inspector').classList.add('open');
    inspFill();
    document.querySelectorAll('.tb-target').forEach((el) => el.classList.toggle('sel', el.dataset.k === String(k)));
  }
  // Everything in the panel but the text box, so typing never loses its place.
  function inspFill() {
    const d = defBlocks(S.defsText), b = d.blocks[INSP.k];
    if (!b) return;
    const t = S.defs.targets[b.name];
    $('#insp-crumb').textContent = 'Bench › ' + b.name;
    $('#insp-title').textContent = t ? t.title || b.name : b.name;
    const ip = t && ifacePath(t.iface);
    $('#insp-iface').innerHTML = t ? '<span class="tb-chip">' + esc(ip.label) + '</span><span class="tb-dim">' + esc(ip.path) + '</span>' +
      '<span class="tb-dim">' + Object.keys(t.commands).length + ' commands · ' + t.order.length + ' telemetry · used by ' + (usedByTarget(b.name).join(', ') || 'no test') + '</span>' : '';
    const errs = S.defs.errors.filter((x) => x.line - 1 >= b.start && x.line - 1 < b.end);
    const dup = Object.keys(S.defs.targets).length < d.blocks.length && d.blocks.filter((x) => x.name === b.name).length > 1;
    $('#insp-lint').innerHTML = errs.length || dup
      ? (dup ? '<div class="tb-lint-row"><span>Name</span>Another target is also called ' + esc(b.name) + '</div>' : '') +
        errs.map((x) => '<div class="tb-lint-row"><span>Line ' + (x.line - b.start) + '</span>' + esc(x.msg) + '</div>').join('')
      : '<div class="tb-lint-ok">✓ Reads cleanly</div>';
  }
  function usedByTarget(name) {
    const out = new Set();
    Object.values(S.tree.tests).forEach((t) => { if (needsOf(t, S.tree).has(name)) out.add(t.id); });
    return [...out];
  }
  function closeTarget() {
    INSP.k = -1;
    $('#inspector').classList.remove('open');
    document.querySelectorAll('.tb-target.sel').forEach((el) => el.classList.remove('sel'));
  }
  function addTarget() {
    let n = 1; while (S.defs.targets['NEW' + n]) n++;
    const d = defBlocks(S.defsText);
    setBlock(d.blocks.length, 'target NEW' + n + ' "New target"\n  interface serial COM1 115200 line\n  command ping "ping"\n  telemetry state - "status?"');
    sim.attached['NEW' + n] = false;
    defsChanged();
    openTarget(d.blocks.length);
    const ta = $('#insp-def'); ta.focus(); ta.setSelectionRange(7, 7 + ('NEW' + n).length);
  }
  function removeTarget() {
    const before = S.defsText, d = defBlocks(S.defsText), b = d.blocks[INSP.k];
    if (!b) return;
    setBlock(INSP.k, '');
    closeTarget(); defsChanged();
    const el = document.createElement('div');
    el.className = 'toast'; el.innerHTML = 'Removed ' + esc(b.name) + '<button class="toast-act">Undo</button>';
    el.querySelector('button').onclick = () => { S.defsText = before; defsChanged(); el.remove(); };
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 6000);
  }
  function bindInspector() {
    const ins = $('#inspector');
    ins.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'insp-close') closeTarget();
      if (a.dataset.act === 'insp-remove') removeTarget();
    });
    ins.addEventListener('input', (e) => {
      if (e.target.id !== 'insp-def') return;
      clearTimeout(INSP.timer);
      INSP.timer = setTimeout(() => {
        setBlock(INSP.k, e.target.value);
        defsChanged(); inspFill();
        document.querySelectorAll('.tb-target').forEach((el) => el.classList.toggle('sel', el.dataset.k === String(INSP.k)));
      }, 300);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ins.classList.contains('open')) closeTarget(); });
  }

  function limText(tl) {
    const f = (r) => (r[0] === -Infinity || r[0] === 0 && r[1] !== Infinity ? '≤ ' + fmtQty(r[1], tl.unit) : r[1] === Infinity ? '≥ ' + fmtQty(r[0], tl.unit) : fmtQty(r[0], tl.unit) + ' to ' + fmtQty(r[1], tl.unit));
    return tl.yellow ? 'limit ' + f(tl.yellow) : tl.red ? 'limit ' + f(tl.red) : '';
  }
  function drawParams(el) {
    const t = S.defs.targets[el.dataset.target]; const sel = el.querySelector('[data-act="pick-cmd"]');
    if (!sel) return;
    const c = t.commands[sel.value];
    el.querySelector('.tb-params').innerHTML = c.params.map((p) => p.kind === 'choice'
      ? '<select class="tb-select" data-p="' + p.name + '">' + p.choices.map((x) => '<option>' + esc(x) + '</option>').join('') + '</select>'
      : '<input class="tb-pin" data-p="' + p.name + '" placeholder="' + esc(p.name + (p.unit ? ' (' + p.unit + ')' : '')) + '" value="' + (p.kind === 'range' ? esc(String(isFinite(p.range[0]) ? p.range[0] : 0) + (p.unit ? ' ' + p.unit : '')) : '') + '">').join('');
  }

  function tickBench() {
    const T = S.defs.targets;
    Object.values(T).forEach((t) => t.order.forEach((k) => {
      let v; try { v = sim.read(t.name, k); } catch (e) { v = null; }
      const key = t.name + '.' + k;
      const h = S.hist[key] = S.hist[key] || [];
      h.push(typeof v === 'number' ? v : null); if (h.length > 60) h.shift();
    }));
    if (document.querySelector('[data-pane="bench"]').hidden) return;
    document.querySelectorAll('.tb-target').forEach((el) => {
      const t = T[el.dataset.target]; if (!t) return;
      el.querySelectorAll('tr[data-tlm]').forEach((tr) => {
        const k = tr.dataset.tlm, tl = t.telemetry[k];
        let v, err = null; try { v = sim.read(t.name, k); } catch (e) { err = e.message; }
        const st = err ? 'none' : limitState(tl, v);
        const cell = tr.querySelector('.tb-tv');
        cell.className = 'tb-tv st-' + st;
        cell.innerHTML = err ? '<span class="tb-dim">no answer</span>' : (st === 'red' ? '<i>✕</i>' : st === 'yellow' ? '<i>▲</i>' : '') + esc(typeof v === 'number' ? fmtQty(v, tl.unit) : v);
        const h = S.hist[t.name + '.' + k].filter((x) => x != null);
        const pl = tr.querySelector('polyline');
        if (h.length > 1) {
          let lo = Math.min(...h), hi = Math.max(...h); if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
          const all = S.hist[t.name + '.' + k];
          pl.setAttribute('points', all.map((x, i) => x == null ? null : (i * 80 / 59).toFixed(1) + ',' + (18 - (x - lo) / (hi - lo) * 16).toFixed(1)).filter(Boolean).join(' '));
        } else pl.setAttribute('points', '');
      });
    });
  }

  /* ---------- Recording: a ring buffer per telemetry point ---------- */

  // 10 minutes at 20 Hz per point: two typed arrays, about 120 KB a point. Text values (a state) are stored as a
  // code into the point's own list of values, so every point is numbers.
  const RING = 12000;
  function ring() { return { t: new Float64Array(RING), v: new Float32Array(RING), head: 0, len: 0, dict: [], text: false }; }
  function ringPush(r, t, v) {
    let x = v;
    if (typeof v === 'string') { r.text = true; x = r.dict.indexOf(v); if (x < 0) { r.dict.push(v); x = r.dict.length - 1; } }
    else if (v == null || typeof v !== 'number') x = NaN;
    r.t[r.head] = t; r.v[r.head] = x; r.head = (r.head + 1) % RING; if (r.len < RING) r.len++;
  }
  const ringAt = (r, i) => (r.head - r.len + i + RING) % RING; // i = 0 is the oldest kept sample
  function ringFirstAfter(r, t) { // binary search: index (0..len) of the first sample at or after t
    let lo = 0, hi = r.len;
    while (lo < hi) { const m = (lo + hi) >> 1; if (r.t[ringAt(r, m)] < t) lo = m + 1; else hi = m; }
    return lo;
  }

  const X = {
    rings: {}, plotted: [], sel: null, win: 30, paused: false, pausedAt: 0, rate: 10, hover: null,
    marks: [], dirty: true, drawMs: 0, samples: 0, timer: 0, q: ''
  };
  try { const p = JSON.parse(localStorage.getItem('plumb.v1.ui.plot') || 'null'); if (p) { X.plotted = p.plotted || []; X.win = p.win || 30; } } catch (e) { /* storage off */ }
  if (!X.plotted.length) X.plotted = ['PSU.current', 'MAIN.rail_3v3', 'MAIN.state'];
  function savePlot() { try { localStorage.setItem('plumb.v1.ui.plot', JSON.stringify({ plotted: X.plotted, win: X.win })); } catch (e) { /* storage off */ } }

  // The lab records every point. The real tool would poll only what's plotted, shown, or used by a running test:
  // the cost is the instruments' answers (a serial board, perhaps 50 queries a second), not the drawing.
  function sample() {
    const t = now();
    Object.values(S.defs.targets).forEach((tg) => tg.order.forEach((k) => {
      const key = tg.name + '.' + k;
      let v; try { v = sim.read(tg.name, k); } catch (e) { v = null; }
      ringPush(X.rings[key] = X.rings[key] || ring(), t, v);
      X.samples++;
    }));
    X.dirty = true;
  }
  function setRate(hz) { X.rate = hz; clearInterval(X.timer); X.timer = setInterval(sample, 1000 / hz); }

  /* ---------- Telemetry and commands: the list ---------- */

  function usedBy(target, name, isCmd) {
    const out = new Set();
    const re = new RegExp('\\b' + target + '\\.' + name.replace(/\d$/, '(?:\\d|\\$\\w+)') + '\\b');
    const owner = (n) => { while (n && n.kind !== 'test') n = n.parent; return n; };
    S.tree.nodes.forEach((n) => {
      if (n.kind !== 'step') return;
      const hit = re.test(n.text) || (n.body || []).some((i) => re.test(S.tree.lines[i].text));
      if (hit && (isCmd ? n.step.kind === 'command' || n.step.kind === 'script' : n.step.kind !== 'command')) { const t = owner(n); if (t) out.add(t.id); }
    });
    return [...out];
  }
  function sig(c) { return c.params.map((p) => p.kind === 'choice' ? p.choices.join('|') : p.kind === 'range' ? p.name + (p.unit ? ' (' + p.unit + ')' : '') : p.name).join(' '); }

  function renderExList() {
    const q = X.q.trim().toLowerCase();
    const hit = (s) => !q || s.toLowerCase().includes(q);
    let h = '';
    Object.values(S.defs.targets).forEach((tg) => {
      const tl = tg.order.filter((k) => hit(tg.name + '.' + k) || hit(tg.title));
      const cm = Object.values(tg.commands).filter((c) => hit(tg.name + '.' + c.name) || hit(tg.title));
      if (!tl.length && !cm.length) return;
      const ip = ifacePath(tg.iface);
      h += '<div class="tb-ex-t' + (sim.attached[tg.name] ? '' : ' off') + '"><div class="tb-ex-th"><b>' + esc(tg.name) + '</b><span>' + esc(tg.title) + '</span><span class="tb-dim">' + esc(ip.path) + '</span></div>';
      if (tl.length) h += '<div class="tb-ex-sec">Telemetry</div>' + tl.map((k) => {
        const key = tg.name + '.' + k, t = tg.telemetry[k];
        return '<div class="tb-ex-row' + (X.sel === 't:' + key ? ' sel' : '') + '" data-ex="t:' + key + '">' +
          '<input type="checkbox" data-plot="' + key + '"' + (X.plotted.includes(key) ? ' checked' : '') + ' title="Plot ' + key + '">' +
          '<span class="tb-ex-n">' + esc(k) + '</span><span class="tb-ex-v" data-live="' + key + '">–</span><span class="tb-ex-u">' + esc(t.unit) + '</span></div>';
      }).join('');
      if (cm.length) h += '<div class="tb-ex-sec">Commands</div>' + cm.map((c) => {
        const key = tg.name + '.' + c.name;
        return '<div class="tb-ex-row cmd' + (X.sel === 'c:' + key ? ' sel' : '') + '" data-ex="c:' + key + '"><span class="tb-ex-ic">›</span><span class="tb-ex-n">' + esc(c.name) + '</span><span class="tb-ex-sig">' + esc(sig(c)) + '</span></div>';
      }).join('');
      h += '</div>';
    });
    $('#ex-list').innerHTML = h || '<p class="tb-dim" style="padding:12px">Nothing matches.</p>';
    liveValues();
  }

  function liveValues() {
    document.querySelectorAll('[data-live]').forEach((el) => {
      const key = el.dataset.live, [tn, k] = key.split('.');
      const tg = S.defs.targets[tn]; const t = tg && tg.telemetry[k]; const r = X.rings[key];
      if (!t || !r || !r.len) return;
      const v = r.v[ringAt(r, r.len - 1)];
      const val = isNaN(v) ? null : r.text ? r.dict[v] : v;
      const st = limitState(t, val);
      el.className = (el.classList.contains('tb-ex-v') ? 'tb-ex-v' : 'tb-dv') + ' st-' + st;
      el.textContent = val == null ? 'no answer' : (st === 'red' ? '✕ ' : st === 'yellow' ? '▲ ' : '') + (typeof val === 'number' ? fmtQty(val, t.unit).replace(/ \S+$/, (m) => (t.unit ? m : '')) : val);
    });
  }

  /* ---------- Telemetry and commands: the detail card ---------- */

  function stats(key) {
    const r = X.rings[key]; if (!r || r.text) return null;
    const end = viewEnd(), i0 = ringFirstAfter(r, end - X.win * 1000);
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
    for (let i = i0; i < r.len; i++) { const j = ringAt(r, i); if (r.t[j] > end) break; const v = r.v[j]; if (isNaN(v)) continue; mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; n++; }
    return n ? { mn, mx, mean: sum / n, n } : null;
  }

  function renderExDetail() {
    const el = $('#ex-detail');
    if (!X.sel) { el.innerHTML = '<p class="tb-dim tb-ex-hint">Pick a telemetry point or a command to see how it\'s read or sent, its limits, and which tests use it.</p>'; return; }
    const [kind, key] = [X.sel[0], X.sel.slice(2)];
    const [tn, name] = key.split('.');
    const tg = S.defs.targets[tn];
    if (!tg) { X.sel = null; return renderExDetail(); }
    if (kind === 't') {
      const t = tg.telemetry[name]; if (!t) { X.sel = null; return renderExDetail(); }
      const used = usedBy(tn, name, false);
      const st = stats(key);
      const lim = (r) => (r ? fmtQty(r[0], t.unit) + ' to ' + fmtQty(r[1], t.unit) : '–');
      const sugg = t.red || t.yellow ? 'check ' + key + ' ' + fmtQty((t.yellow || t.red)[0], t.unit) + ' .. ' + fmtQty((t.yellow || t.red)[1], t.unit) : 'check ' + key + ' == "…"';
      el.innerHTML = '<div class="tb-dh"><span class="tb-kind">Telemetry</span><b>' + esc(key) + '</b><span class="tb-dv" data-live="' + key + '">–</span>' +
        '<button class="btn ' + (X.plotted.includes(key) ? '' : 'btn-primary') + '" data-plot-btn="' + key + '">' + (X.plotted.includes(key) ? 'Remove from plot' : 'Plot') + '</button></div>' +
        '<table class="tb-dt"><tbody>' +
        '<tr><td>Read with</td><td><code>' + esc(t.query) + '</code> over ' + esc(ifacePath(tg.iface).label) + '</td></tr>' +
        '<tr><td>Unit</td><td>' + esc(t.unit || 'none (text)') + '</td></tr>' +
        '<tr><td>Yellow limits</td><td>' + lim(t.yellow) + '</td></tr><tr><td>Red limits</td><td>' + lim(t.red) + '</td></tr>' +
        (st ? '<tr><td>Last ' + (X.win >= 60 ? X.win / 60 + ' min' : X.win + ' s') + '</td><td>min ' + fmtQty(st.mn, t.unit) + ' · mean ' + fmtQty(st.mean, t.unit) + ' · max ' + fmtQty(st.mx, t.unit) + ' <span class="tb-dim">(' + st.n + ' samples)</span></td></tr>' : '') +
        '<tr><td>Used by</td><td>' + (used.length ? used.map((x) => '<span class="tb-req">' + esc(x) + '</span>').join(' ') : '<span class="tb-dim">no test yet</span>') + '</td></tr>' +
        '<tr><td>As a step</td><td><code>' + esc(sugg) + '</code></td></tr></tbody></table>';
    } else {
      const c = tg.commands[name]; if (!c) { X.sel = null; return renderExDetail(); }
      const used = usedBy(tn, name, true);
      el.innerHTML = '<div class="tb-dh"><span class="tb-kind">Command</span><b>' + esc(key) + '</b>' + (c.returns ? '<span class="tb-dim">returns ' + esc(c.returns) + '</span>' : '') + '</div>' +
        '<table class="tb-dt"><tbody>' +
        c.params.map((p) => '<tr><td>' + esc(p.name) + '</td><td>' + (p.kind === 'choice' ? p.choices.map(esc).join(', ') : p.kind === 'range' ? esc(p.range[0] + ' to ' + p.range[1] + (p.unit ? ' ' + p.unit : '')) : 'any text') + '</td><td>' +
          (p.kind === 'choice' ? '<select class="tb-select" data-cp="' + p.name + '">' + p.choices.map((x) => '<option>' + esc(x) + '</option>').join('') + '</select>' : '<input class="tb-pin" data-cp="' + p.name + '" value="' + (p.kind === 'range' ? esc((isFinite(p.range[0]) ? p.range[0] : 0) + (p.unit ? ' ' + p.unit : '')) : '') + '">') + '</td></tr>').join('') +
        '<tr><td>On the wire</td><td colspan="2"><code id="ex-wire"></code></td></tr>' +
        '<tr><td>As a step</td><td colspan="2"><code id="ex-step"></code></td></tr>' +
        '<tr><td>Used by</td><td colspan="2">' + (used.length ? used.map((x) => '<span class="tb-req">' + esc(x) + '</span>').join(' ') : '<span class="tb-dim">no test yet</span>') + '</td></tr></tbody></table>' +
        '<div class="tb-dsend"><button class="btn btn-primary" id="ex-send"' + (sim.attached[tn] ? '' : ' disabled') + '>Send</button><span class="tb-sent" id="ex-sent"></span></div>';
      exPreview();
    }
    liveValues();
  }
  function exStepText() {
    const key = X.sel.slice(2);
    const args = [...document.querySelectorAll('#ex-detail [data-cp]')].map((x) => x.value.trim());
    return key + (args.length ? ' ' + args.join(' ') : '');
  }
  function exPreview() {
    const [tn, name] = X.sel.slice(2).split('.'); const c = S.defs.targets[tn].commands[name];
    const vals = {};
    document.querySelectorAll('#ex-detail [data-cp]').forEach((x) => { const p = c.params.find((q) => q.name === x.dataset.cp); const q = p.kind === 'range' && parseQty(x.value); vals[p.name] = q ? trimNum(q.v, 6) : x.value.trim(); });
    $('#ex-wire').textContent = c.wire ? c.wire.replace(/\{(\w+)\}/g, (m, k) => vals[k]) : '(no text: ' + name + ')';
    $('#ex-step').textContent = exStepText();
  }

  /* ---------- The plot ---------- */

  const COLORS = ['#0a84ff', '#e07800', '#30b0c7', '#bf5af2', '#8e8e93', '#ff9f0a'];
  const DASH = [[], [6, 4], [2, 3], [10, 3, 2, 3]];
  const viewEnd = () => (X.paused ? X.pausedAt : now());
  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function unitFor2(key) { const [tn, k] = key.split('.'); const tg = S.defs.targets[tn]; return tg && tg.telemetry[k] ? tg.telemetry[k] : null; }

  function lanes() {
    const num = {}, bands = [];
    X.plotted.forEach((key, i) => {
      const t = unitFor2(key), r = X.rings[key]; if (!t) return;
      const s = { key, t, r, color: COLORS[i % COLORS.length], dash: DASH[Math.floor(i / COLORS.length) % DASH.length] };
      if (!t.unit || (r && r.text)) bands.push(s); else { const lane = X.stack === 'unit' ? t.unit : key; (num[lane] = num[lane] || []).push(s); }
    });
    // Within a lane, give each series its own dash too, so two lines never differ by color alone.
    Object.values(num).forEach((arr) => arr.forEach((s, i) => { s.dash = DASH[i % DASH.length]; }));
    return { num: Object.entries(num), bands };
  }

  function drawPlot() {
    const cv = $('#plot'), wrap = $('#plot-wrap');
    const t0 = performance.now();
    { const ln = lanes(); const want = Math.max(260, ln.num.length * 100 + ln.bands.length * 26 + 40) + 'px'; if (wrap.style.height !== want) wrap.style.height = want; }
    const W = wrap.clientWidth, H = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    $('#plot-empty').hidden = X.plotted.length > 0;
    if (!X.plotted.length) return;
    const css = getComputedStyle(document.documentElement);
    const C = { text: css.getPropertyValue('--text-3').trim(), hair: css.getPropertyValue('--hair').trim(), hair2: css.getPropertyValue('--hair-2').trim(), warn: css.getPropertyValue('--warn').trim(), issue: css.getPropertyValue('--issue').trim(), accent: css.getPropertyValue('--accent').trim(), text1: css.getPropertyValue('--text').trim() };
    const L = 58, R = 12, T = 8, B = 22;
    const end = viewEnd(), start = end - X.win * 1000;
    const xOf = (t) => L + (t - start) / (end - start) * (W - L - R);
    const { num, bands } = lanes();
    const bandH = 22, gap = 10;
    const numH = num.length ? (H - T - B - bands.length * (bandH + 4) - gap * (num.length - 1)) / num.length : 0;
    g.font = '11px ' + css.getPropertyValue('--mono');
    g.textBaseline = 'middle';
    let y = T;
    const laneBoxes = [];
    let points = 0;

    num.forEach(([, series]) => {
      const unit = series[0].t.unit;
      let mn = Infinity, mx = -Infinity;
      series.forEach((s) => {
        const r = s.r; if (!r) return;
        for (let i = ringFirstAfter(r, start); i < r.len; i++) { const j = ringAt(r, i); if (r.t[j] > end) break; const v = r.v[j]; if (!isNaN(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
      });
      if (mn === Infinity) { mn = 0; mx = 1; }
      if (mx - mn < Math.abs(mx) * 1e-3 + 1e-9) { const d = Math.abs(mx) * 0.01 + 1e-6; mn -= d; mx += d; }
      const pad = (mx - mn) * 0.08; mn -= pad; mx += pad;
      const yOf = (v) => y + numH - (v - mn) / (mx - mn) * numH;
      g.fillStyle = C.hair; g.fillRect(L, y, W - L - R, numH);
      const st = niceStep(mx - mn, 3);
      g.strokeStyle = C.hair2; g.lineWidth = 1; g.fillStyle = C.text; g.textAlign = 'right';
      for (let v = Math.ceil(mn / st) * st; v <= mx; v += st) {
        const yy = Math.round(yOf(v)) + 0.5; g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
        g.fillText(fmtQty(v, unit), L - 6, yy);
      }
      // Limits as dashed lines: yellow dotted, red long dashes, so they don't rely on hue.
      series.forEach((s) => [['yellow', C.warn, [2, 3]], ['red', C.issue, [8, 4]]].forEach(([k, col, d]) => {
        const lim = s.t[k]; if (!lim) return;
        lim.forEach((v) => { if (!isFinite(v) || v === 0 || v < mn || v > mx) return; g.save(); g.strokeStyle = col; g.setLineDash(d); g.globalAlpha = 0.8; g.beginPath(); g.moveTo(L, yOf(v)); g.lineTo(W - R, yOf(v)); g.stroke(); g.restore(); });
      }));
      g.save(); g.beginPath(); g.rect(L, y, W - L - R, numH); g.clip();
      series.forEach((s) => {
        const r = s.r; if (!r) return;
        // One column per pixel: min, max, and mean of the samples in it, so 12,000 samples draw as about 1,000
        // columns. The min-to-max spread is one filled shape and the mean one line; stroking a zigzag through every
        // min and max costs far more to draw.
        const segs = []; let cur = null;
        let col = -1, cmn = 0, cmx = 0, sum = 0, n = 0;
        const flush = () => { if (col < 0) return; if (!cur) { cur = []; segs.push(cur); } cur.push(col + 0.5, yOf(cmn), yOf(cmx), yOf(sum / n)); };
        for (let i = Math.max(0, ringFirstAfter(r, start) - 1); i < r.len; i++) {
          const j = ringAt(r, i), t = r.t[j]; if (t > end) break;
          const v = r.v[j]; points++;
          if (isNaN(v)) { flush(); col = -1; cur = null; continue; }
          const c = Math.floor(xOf(t));
          if (c !== col) { flush(); col = c; cmn = cmx = sum = v; n = 1; } else { if (v < cmn) cmn = v; if (v > cmx) cmx = v; sum += v; n++; }
        }
        flush();
        g.fillStyle = s.color; g.globalAlpha = 0.28;
        segs.forEach((a) => {
          if (a.length < 8) return;
          g.beginPath(); g.moveTo(a[0], a[2]);
          for (let k = 4; k < a.length; k += 4) g.lineTo(a[k], a[k + 2]);
          for (let k = a.length - 4; k >= 0; k -= 4) g.lineTo(a[k], a[k + 1] + 0.5);
          g.fill();
        });
        g.globalAlpha = 1; g.strokeStyle = s.color; g.lineWidth = 1.6; g.setLineDash(s.dash); g.beginPath();
        segs.forEach((a) => { g.moveTo(a[0], a[3]); for (let k = 4; k < a.length; k += 4) g.lineTo(a[k], a[k + 3]); });
        g.stroke();
      });
      g.restore(); g.setLineDash([]);
      g.textAlign = 'left';
      series.forEach((s, i) => { g.fillStyle = s.color; g.fillText(s.key, L + 6 + i * 130, y + 9); });
      laneBoxes.push({ y, h: numH, series, yOf });
      y += numH + gap;
    });

    bands.forEach((s) => {
      const r = s.r;
      g.fillStyle = C.hair; g.fillRect(L, y, W - L - R, bandH);
      g.fillStyle = C.text; g.textAlign = 'right'; g.fillText(s.key.split('.')[1], L - 6, y + bandH / 2);
      if (r && r.len) {
        g.save(); g.beginPath(); g.rect(L, y, W - L - R, bandH); g.clip();
        let segStart = null, segV = null;
        const seg = (t1) => {
          if (segStart == null) return;
          const x0 = Math.max(L, xOf(segStart)), x1 = Math.min(W - R, xOf(t1));
          if (x1 <= x0) return;
          const txt = isNaN(segV) ? '' : r.dict[segV];
          const k = isNaN(segV) ? -1 : segV;
          g.fillStyle = k < 0 ? 'transparent' : s.color; g.globalAlpha = k < 0 ? 0 : 0.14 + 0.16 * (k % 3); g.fillRect(x0, y + 2, x1 - x0, bandH - 4);
          g.globalAlpha = 1; g.strokeStyle = s.color; g.beginPath(); g.moveTo(x0 + 0.5, y + 2); g.lineTo(x0 + 0.5, y + bandH - 2); g.stroke();
          if (txt && x1 - x0 > g.measureText(txt).width + 8) { g.fillStyle = C.text1; g.textAlign = 'left'; g.fillText(txt, x0 + 4, y + bandH / 2); }
        };
        // Values that change faster than 2 px merge into one hatched "changing" stretch, so a busy point
        // costs one rectangle, not one per sample.
        let busy = null;
        const drawBusy = (t1) => {
          const x0 = Math.max(L, xOf(busy)), x1 = Math.min(W - R, xOf(t1));
          g.fillStyle = s.color; g.globalAlpha = 0.4;
          for (let x = x0; x < x1; x += 4) g.fillRect(x, y + 2, 1.5, bandH - 4);
          g.globalAlpha = 1; busy = null;
        };
        for (let i = Math.max(0, ringFirstAfter(r, start) - 1); i < r.len; i++) {
          const j = ringAt(r, i), t = r.t[j]; if (t > end) break; points++;
          const v = r.v[j];
          if (segStart == null) { segStart = t; segV = v; continue; }
          if (v === segV || (isNaN(v) && isNaN(segV))) continue;
          if (xOf(t) - xOf(segStart) < 2) { if (busy == null) busy = segStart; }
          else { if (busy != null) drawBusy(segStart); seg(t); }
          segStart = t; segV = v;
        }
        if (busy != null) drawBusy(segStart);
        seg(end); g.restore();
      }
      laneBoxes.push({ y, h: bandH, series: [s], band: true });
      y += bandH + 4;
    });

    // Time axis, and a mark where each test started.
    g.fillStyle = C.text; g.textAlign = 'center';
    const tst = niceStep(X.win, 6);
    for (let s = 0; s <= X.win + 1e-6; s += tst) { const x = xOf(end - s * 1000); g.fillText(s === 0 ? (X.paused ? 'paused' : 'now') : '−' + (s >= 60 ? trimNum(s / 60, 3) + ' min' : s + ' s'), x, H - B / 2 + 2); }
    X.marks.forEach((m) => {
      if (m.t < start || m.t > end) return;
      const x = Math.round(xOf(m.t)) + 0.5;
      g.save(); g.strokeStyle = C.accent; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke(); g.restore();
      g.fillStyle = C.accent; g.textAlign = 'left'; g.fillText(m.label, x + 3, T + 6);
    });

    // Cursor: a line and every series' value at that time.
    const tip = $('#plot-tip');
    if (X.hover && X.hover.x >= L && X.hover.x <= W - R) {
      const t = start + (X.hover.x - L) / (W - L - R) * (end - start);
      g.strokeStyle = C.text1; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(X.hover.x + 0.5, T); g.lineTo(X.hover.x + 0.5, H - B); g.stroke(); g.globalAlpha = 1;
      const rows = [];
      laneBoxes.forEach((lb) => lb.series.forEach((s) => {
        const r = s.r; if (!r || !r.len) return;
        let i = ringFirstAfter(r, t); if (i >= r.len) i = r.len - 1;
        if (i > 0 && Math.abs(r.t[ringAt(r, i - 1)] - t) < Math.abs(r.t[ringAt(r, i)] - t)) i--;
        const j = ringAt(r, i), v = r.v[j];
        const txt = isNaN(v) ? 'no answer' : r.text ? r.dict[v] : fmtQty(v, s.t.unit);
        rows.push('<div><i style="background:' + s.color + '"></i>' + esc(s.key) + ' <b>' + esc(txt) + '</b></div>');
        if (!lb.band && !isNaN(v)) { g.fillStyle = s.color; g.beginPath(); g.arc(X.hover.x, lb.yOf(v), 3, 0, 7); g.fill(); }
      }));
      const ago = (end - t) / 1000;
      tip.innerHTML = '<div class="tb-dim">' + (ago < 0.05 ? 'now' : '−' + trimNum(ago, 3) + ' s') + '</div>' + rows.join('');
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = (X.hover.x + 14 + tw > W ? X.hover.x - tw - 14 : X.hover.x + 14) + 'px';
      tip.style.top = Math.min(H - tip.offsetHeight - 4, Math.max(4, X.hover.y - 20)) + 'px';
    } else tip.hidden = true;

    X.drawMs = X.drawMs * 0.9 + (performance.now() - t0) * 0.1;
    X.lastPoints = points;
  }

  function renderLegend() {
    const { num, bands } = lanes();
    const all = num.flatMap(([, s]) => s).concat(bands);
    $('#plot-legend').innerHTML = all.map((s) => '<span class="tb-lg"><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="' + s.color + '" stroke-width="2" stroke-dasharray="' + s.dash.join(' ') + '"/></svg>' + esc(s.key) + '<button data-unplot="' + s.key + '" title="Remove">×</button></span>').join('');
  }
  function setPlotted(key, on) {
    const i = X.plotted.indexOf(key);
    if (on && i < 0) X.plotted.push(key); if (!on && i >= 0) X.plotted.splice(i, 1);
    savePlot(); renderLegend(); renderExList(); renderExDetail(); X.dirty = true;
  }

  function plotLoop() {
    const pane = $('[data-pane="explore"]');
    // A redraw is worth it only when the plot has moved a pixel: at 10 minutes that's every half second.
    const every = Math.max(33, X.win * 1000 / Math.max(200, $('#plot-wrap').clientWidth - 70));
    const t = now();
    if (!pane.hidden && (X.dirty || X.hover) && (X.hover || t - (X.lastDraw || 0) >= every)) {
      X.dirty = false; X.lastDraw = t;
      drawPlot();
      if (!X.frame || ++X.frame % 6 === 0) {
        liveValues();
        const n = Object.keys(X.rings).length;
        $('#plot-stats').textContent = n + ' points recorded at ' + X.rate + ' Hz, 10 min kept · ' + X.plotted.length + ' plotted · ' + (X.lastPoints || 0).toLocaleString() + ' samples drawn in ' + X.drawMs.toFixed(1) + ' ms';
      }
      X.frame = (X.frame || 0) + 1;
    }
    requestAnimationFrame(plotLoop);
  }

  function renderExplorer() {
    document.querySelectorAll('#plot-win button').forEach((b) => b.classList.toggle('on', +b.dataset.v === X.win));
    document.querySelectorAll('#plot-stack button').forEach((b) => b.classList.toggle('on', b.dataset.v === (X.stack || 'lanes')));
    renderExList(); renderExDetail(); renderLegend(); X.dirty = true;
  }

  function bindExplorer() {
    $('#ex-q').addEventListener('input', (e) => { X.q = e.target.value; renderExList(); });
    $('#ex-list').addEventListener('click', (e) => {
      const cb = e.target.closest('[data-plot]');
      if (cb) { setPlotted(cb.dataset.plot, cb.checked); return; }
      const row = e.target.closest('[data-ex]'); if (!row) return;
      X.sel = row.dataset.ex; renderExList(); renderExDetail();
    });
    $('#ex-detail').addEventListener('click', async (e) => {
      const pb = e.target.closest('[data-plot-btn]');
      if (pb) { setPlotted(pb.dataset.plotBtn, !X.plotted.includes(pb.dataset.plotBtn)); return; }
      if (e.target.id === 'ex-send') {
        const line = exStepText(), out = $('#ex-sent');
        try { const r = await sendCommand(line, null); out.textContent = '→ ' + (typeof r === 'number' ? trimNum(r, 5) : String(r).split('\n').join(' ⏎ ') || 'OK'); out.className = 'tb-sent ok'; }
        catch (err) { out.textContent = '✕ ' + err.message; out.className = 'tb-sent bad'; }
      }
    });
    $('#ex-detail').addEventListener('input', (e) => { if (e.target.dataset.cp) exPreview(); });
    $('#ex-detail').addEventListener('change', (e) => { if (e.target.dataset.cp) exPreview(); });
    $('#plot-legend').addEventListener('click', (e) => { const b = e.target.closest('[data-unplot]'); if (b) setPlotted(b.dataset.unplot, false); });
    $('#plot-win').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; X.win = +b.dataset.v; savePlot(); renderExplorer(); });
    $('#plot-stack').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; X.stack = b.dataset.v; renderExplorer(); });
    $('#plot-pause').addEventListener('click', (e) => { X.paused = !X.paused; X.pausedAt = now(); e.target.textContent = X.paused ? 'Resume' : 'Pause'; X.dirty = true; });
    $('#plot-clear').addEventListener('click', () => { X.plotted = []; savePlot(); renderExplorer(); });
    $('#plot-rate').addEventListener('change', (e) => setRate(+e.target.value));
    const cv = $('#plot');
    cv.addEventListener('mousemove', (e) => { const b = cv.getBoundingClientRect(); X.hover = { x: e.clientX - b.left, y: e.clientY - b.top }; });
    cv.addEventListener('mouseleave', () => { X.hover = null; X.dirty = true; });
    new ResizeObserver(() => { X.dirty = true; }).observe($('#plot-wrap'));
  }

  /* ---------- Controls ---------- */

  // The suite's theme, kept where every tool keeps it (signoff.v1.settings.theme), so Plumb opens in the same one.
  const ICON = {
    moon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M16.2 12.4A6.6 6.6 0 017.6 3.8a6.6 6.6 0 108.6 8.6z"/></svg>',
    sun: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v1.8M10 16.2V18M2 10h1.8M16.2 10H18M4.3 4.3l1.3 1.3M14.4 14.4l1.3 1.3M15.7 4.3l-1.3 1.3M5.6 14.4l-1.3 1.3"/></svg>'
  };
  function suiteTheme() { try { return (JSON.parse(localStorage.getItem('signoff.v1.settings') || '{}') || {}).theme; } catch (e) { return null; } }
  function setTheme(v, keep) {
    document.documentElement.dataset.theme = v;
    const b = $('#theme-btn');
    b.innerHTML = v === 'dark' ? ICON.sun : ICON.moon;
    b.title = v === 'dark' ? 'Light mode' : 'Dark mode';
    if (keep) {
      try { const st = JSON.parse(localStorage.getItem('signoff.v1.settings') || '{}') || {}; st.theme = v; localStorage.setItem('signoff.v1.settings', JSON.stringify(st)); } catch (e) { /* storage off */ }
    }
    X.dirty = true;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  /* ---------- Benches: Plumb projects, by client project ---------- */

  // A bench (a Plumb project) is one station's targets and tests, grouped by the client project as Signoff groups
  // reviews, and linked to the Signoff EE board it tests. assets/store.js keeps them and syncs them with plumb_data.
  const ST = window.PLUMB.store;
  const DEMO = ST.DEMO;
  let CUR = null;
  const DEMO_ID = 'bdemo1';
  const CUR_KEY = (DEMO ? 'plumb.demo.' : 'plumb.v1.') + 'ui.bench';
  function persist() {
    if (!CUR || !ST.get(CUR) || S.loading) return;
    ST.update(CUR, { script: S.text, defs: S.defsText });
    renderSyncPill();
  }
  function openProject(id) {
    // A running test's cleanup reads the open bench's targets, so the bench can't change under it.
    if (S.running && id !== CUR) { toast('A test is running: Abort it first, then switch benches'); renderSide(); return false; }
    const p = id && ST.get(id);
    CUR = p ? p.id : null;
    S.pick = null;
    try { localStorage.setItem(CUR_KEY, CUR || ''); } catch (e) { /* storage off */ }
    $('#empty').hidden = !!p; $('.plumb-page').hidden = !p;
    $('#run-all').disabled = !p || S.running;
    if (!p) { renderEmpty(); renderSide(); renderHead(); return; }
    S.loading = true;
    S.defsText = p.bench.defs || ''; S.text = p.bench.script || '';
    S.results = {}; S.steps = {}; S.form = null;
    S.open = new Set(); const first = /^\s*test\s+(\S+)/m.exec(S.text); if (first) S.open.add(first[1]);
    loadDefs(); reparse(false);
    S.loading = false;
    closeTarget();
    renderHead(); renderSide();
    if (!$('[data-pane="bench"]').hidden) { renderTargets(); tickBench(); }
  }
  function boardLink(b) {
    if (!b) return '<span class="tb-dim">No Signoff EE board</span>';
    const href = '../ee_design_review/index.html?project=' + encodeURIComponent(b.id) + (DEMO ? '&demo' : '');
    return 'Tests <a href="' + href + '" title="Open this board in Signoff EE">' + esc(b.name) + ' in Signoff EE</a>';
  }
  function renderHead() {
    const p = CUR && ST.get(CUR);
    $('#toolbar-title').textContent = p ? p.meta.name : 'Plumb';
    if (!p) return;
    $('#bench-eyebrow').textContent = p.meta.project || 'No client project';
    $('#bench-title').textContent = p.meta.name;
    $('#bench-board').innerHTML = boardLink(p.meta.board);
    document.title = p.meta.name + ' · Plumb';
  }
  function renderEmpty() {
    const signed = !!ST.token();
    $('#empty').innerHTML = '<div class="card tb-empty-card"><h2>No benches yet</h2>' +
      '<p>A bench is one test station: its targets (the instruments and the board under test) and its tests. Link it to the Signoff EE board it tests.</p>' +
      '<p class="tb-dim">' + (signed ? 'Benches sync with the private plumb_data repo.' : 'Benches are kept in this browser until you sign in to GitHub; then they sync with the private plumb_data repo.') + '</p>' +
      '<div class="tb-empty-btns"><button class="btn btn-primary" data-act="new-bench">New bench</button>' +
      '<a class="btn btn-plain" href="?demo">Try the demo</a></div></div>';
  }
  const closedGroups = new Set();
  function ringSvg(pct, size, stroke) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, h = size / 2;
    return '<div class="ring" style="width:' + size + 'px;height:' + size + 'px"><svg width="' + size + '" height="' + size + '">' +
      '<circle class="ring-track" cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
      '<circle class="ring-val" cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + c * (1 - pct / 100) + '"/></svg></div>';
  }
  function renderSide() {
    const q = ($('#bench-search').value || '').trim().toLowerCase();
    const c = S.tree ? counts(S.tree.root) : { total: 0, pass: 0, fail: 0, error: 0 };
    const groups = new Map();
    ST.list().forEach((p) => {
      const sm = ST.summarize(p);
      if (q && !(p.meta.project + ' ' + p.meta.name + ' ' + (p.meta.board ? p.meta.board.name : '')).toLowerCase().includes(q)) return;
      const g = p.meta.project || 'No client project';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ p, sm });
    });
    const html = [...groups.entries()].map(([g, items]) => {
      const open = q || !closedGroups.has(g) || items.some((x) => x.p.id === CUR);
      return '<div class="side-group"><button class="side-group-head" data-group="' + esc(g) + '" aria-expanded="' + !!open + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="side-group-name">' + esc(g) + '</span><span class="side-group-count">' + items.length + '</span></button>' +
        (open ? items.map(({ p, sm }) => {
          const cur = p.id === CUR;
          const pct = cur && c.total ? Math.round(100 * c.pass / c.total) : 0;
          const sub = (cur && c.pass + c.fail + c.error ? c.pass + ' of ' + c.total + ' pass' : sm.tests + ' tests') + ' · ' + sm.targets + ' targets' + (ST.edited(p.id) && !DEMO ? ' · unsynced' : '');
          return '<button class="proj' + (cur ? ' active' : '') + '" data-bench="' + p.id + '" title="' + esc(p.meta.name + '\n' + (p.meta.board ? 'Tests ' + p.meta.board.name + ' (Signoff EE)' : 'No Signoff EE board') + '\n' + sub) + '">' +
            ringSvg(pct, 26, 3.5) +
            '<span class="proj-body"><span class="proj-name">' + esc(p.meta.name) + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
        }).join('') : '') + '</div>';
    }).join('');
    $('#bench-list').innerHTML = html || '<div class="side-empty">' + (q ? 'No matching benches.' : 'No benches yet.') + '</div>';
    if (CUR && S.tree) $('#bench-sub').textContent = Object.keys(S.defs.targets).length + ' targets · ' + c.total + ' tests' + (c.pass + c.fail + c.error ? ' · ' + c.pass + ' passed' + (c.fail + c.error ? ', ' + (c.fail + c.error) + ' failed' : '') : '');
  }

  /* ---------- Sheets: bench details, and sync ---------- */

  function sheet(html) { $('#sheet-card').innerHTML = html; $('#sheet').hidden = false; const f = $('#sheet-card').querySelector('input, select'); if (f) f.focus(); }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-card').innerHTML = ''; }
  // New bench (id null) or a bench's details: name, client project, and the Signoff EE board it tests. The boards
  // come from Signoff EE's working copy in this browser, as Fabcheck's Send lists them.
  async function openBenchSheet(id) {
    const p = id ? ST.get(id) : null;
    const boards = await ST.loadBoards();
    const cur = p && p.meta.board;
    const known = cur && !boards.some((b) => b.id === cur.id) ? [{ id: cur.id, name: cur.name, project: '' }] : [];
    const opts = '<option value="">No board</option>' + known.concat(boards).map((b) => '<option value="' + esc(b.id) + '"' + (cur && cur.id === b.id ? ' selected' : '') + '>' + esc((b.project ? b.project + ' · ' : '') + b.name) + '</option>').join('');
    const projects = [...new Set(ST.list().map((x) => x.meta.project).concat(boards.map((b) => b.project)).filter(Boolean))].sort();
    sheet('<div class="eyebrow">' + (p ? 'Bench details' : 'New bench') + '</div>' +
      '<label class="tb-ff"><span class="tb-ffl">Name</span><input class="tb-pin" id="bs-name" value="' + esc(p ? p.meta.name : '') + '" placeholder="Main PCBA bring-up"></label>' +
      '<label class="tb-ff"><span class="tb-ffl">Signoff EE board</span><select class="tb-select" id="bs-board">' + opts + '</select></label>' +
      (boards.length ? '' : '<p class="tb-dim tb-sheet-note">No Signoff EE boards in this browser yet. Open Signoff EE once' + (DEMO ? ' in its demo' : ', signed in,') + ' to list them here.</p>') +
      '<label class="tb-ff"><span class="tb-ffl">Client project</span><input class="tb-pin" id="bs-project" list="bs-projects" value="' + esc(p ? p.meta.project : '') + '" placeholder="From the board, or type one"><datalist id="bs-projects">' + projects.map((x) => '<option value="' + esc(x) + '">').join('') + '</datalist></label>' +
      '<div class="tb-modal-btns">' + (p ? '<button class="btn btn-danger" data-sheet="delete">Delete bench</button><span class="tb-grow"></span>' : '') +
      '<button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="save">' + (p ? 'Save' : 'Make bench') + '</button></div>');
    const card = $('#sheet-card');
    card.querySelector('#bs-board').addEventListener('change', (e) => {
      const b = boards.find((x) => x.id === e.target.value);
      const pj = card.querySelector('#bs-project');
      if (b && b.project && !pj.value.trim()) pj.value = b.project;
      const nm = card.querySelector('#bs-name');
      if (b && !nm.value.trim()) nm.value = b.name + ' bench';
    });
    card.onclick = (e) => {
      const a = e.target.closest('[data-sheet]'); if (!a) return;
      if (a.dataset.sheet === 'cancel') return closeSheet();
      if (a.dataset.sheet === 'delete') {
        if (S.running) { toast('A test is running: Abort it first, then delete the bench'); return; }
        const name = p.meta.name;
        ST.remove(p.id); closeSheet();
        const next = ST.list()[0]; openProject(next ? next.id : null); renderSyncPill();
        undoToast('Deleted ' + name, () => { ST.update(p.id, { deleted: false }); openProject(p.id); renderSyncPill(); });
        return;
      }
      const name = card.querySelector('#bs-name').value.trim();
      if (!name) { card.querySelector('#bs-name').focus(); toast('Give the bench a name'); return; }
      const bid = card.querySelector('#bs-board').value;
      const bo = bid ? (known.concat(boards).find((x) => x.id === bid) || null) : null;
      const board = bo ? { id: bo.id, name: bo.name } : null;
      const project = card.querySelector('#bs-project').value.trim();
      if (p) ST.update(p.id, { name, project, board });
      else { const n = ST.create({ name, project, board, defs: NEW_DEFS, script: newScript(name) }); closeSheet(); openProject(n.id); renderSyncPill(); return; }
      closeSheet(); renderHead(); renderSide(); renderSyncPill();
    };
  }
  const NEW_DEFS = '# Bench targets: one block per instrument or board. Limits are in base units (V, A, Hz, °C).\n\ntarget PSU "Bench power supply"\n  interface lan 192.168.1.40:5025 scpi\n  command output state=on|off "OUTP {state}"\n  command set_voltage v=0..30V "VOLT {v}"\n  telemetry voltage V "MEAS:VOLT?"\n  telemetry current A "MEAS:CURR?"\n';
  function newScript(name) { return '# ' + name + '\n# One step per line; indent to nest. The rows and this text are the same thing.\n\nsuite ' + name + '\n  test T-01 First test\n    PSU.set_voltage 5 V\n    PSU.output on\n    check PSU.current < 100 mA\n    cleanup\n      PSU.output off\n'; }
  function undoToast(msg, undo) {
    const el = document.createElement('div');
    el.className = 'toast'; el.innerHTML = esc(msg) + ' <button class="btn btn-plain">Undo</button>';
    el.querySelector('button').onclick = () => { el.remove(); undo(); };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // The sync pill: where the benches stand, and who's signed in (line 2), as in every Signoff tool.
  const SY = { busy: false, error: '' };
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 50 ? 'just now' : s < 3300 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(iso).toLocaleDateString();
  }
  function renderSyncPill() {
    const pill = $('#sync-pill'); if (!pill) return;
    const w = window.SignoffFoot ? window.SignoffFoot.who() : {};
    const n = DEMO ? 0 : ST.unsynced().length, last = ST.lastSync();
    let title, sub, tone;
    if (DEMO) { title = 'Demo'; sub = 'Kept in this browser'; tone = 'ok'; }
    else if (!ST.token()) { title = 'Not signed in'; sub = n ? n + ' unsynced, kept here' : 'Kept in this browser'; tone = n ? 'warn' : ''; }
    else if (SY.busy) { title = 'Syncing…'; sub = w.login ? '@' + w.login : ''; tone = 'busy'; }
    else if (SY.error) { title = 'Sync failed'; sub = SY.error; tone = 'err'; }
    else { title = n ? n + ' unsynced' : last ? 'Synced ' + ago(last.at) : 'Not synced yet'; sub = w.login ? '@' + w.login : ''; tone = n ? 'warn' : last ? 'ok' : ''; }
    pill.querySelector('.sync-title').textContent = title;
    const sb = pill.querySelector('.sync-sub'); sb.textContent = sub; sb.classList.toggle('sync-who', !!(sub && sub[0] === '@'));
    const dot = pill.querySelector('.sync-dot'); if (tone) dot.dataset.tone = tone; else delete dot.dataset.tone;
    pill.title = DEMO ? 'The demo keeps its benches in this browser' : 'Sync benches with ' + ST.CFG.owner + '/' + ST.CFG.dataRepo;
  }
  function openSync() {
    if (DEMO) { toast('The demo keeps its benches in this browser'); return; }
    if (!ST.token()) { if (window.SignoffFoot) window.SignoffFoot.settings(); return; }
    const n = ST.unsynced();
    sheet('<div class="eyebrow">Sync</div><h3 class="tb-sheet-h">Benches and ' + esc(ST.CFG.owner + '/' + ST.CFG.dataRepo) + '</h3>' +
      '<p>' + (n.length ? n.length + ' bench' + (n.length > 1 ? 'es have' : ' has') + ' changes not on GitHub yet: ' + esc(n.map((id) => { const x = ST.get(id); return x ? x.meta.name : 'a deleted bench'; }).join(', ')) + '.' : 'Every bench here matches the last sync.') + '</p>' +
      '<p class="tb-dim">Preview reads GitHub and lists what a sync would write, and writes nothing.</p>' +
      '<div id="sync-out"></div>' +
      '<div class="tb-modal-btns"><button class="btn" data-sheet="cancel">Close</button><button class="btn" data-sheet="dry">Preview</button><button class="btn btn-primary" data-sheet="sync">Sync now</button></div>');
    $('#sheet-card').onclick = async (e) => {
      const a = e.target.closest('[data-sheet]'); if (!a) return;
      if (a.dataset.sheet === 'cancel') return closeSheet();
      const out = $('#sync-out');
      if (a.dataset.sheet === 'dry') {
        out.innerHTML = '<p class="tb-dim">Reading GitHub…</p>';
        try {
          const r = await ST.sync({ dry: true });
          const f = r.dry.files;
          out.innerHTML = f.length ? '<p>A sync would write one commit' + (r.dry.message ? ' (“' + esc(r.dry.message) + '”)' : '') + ':</p><ul class="tb-dry">' + f.map((x) => '<li><code>' + esc(x.path) + '</code> ' + (x.text == null ? 'deleted' : (x.text.length / 1024).toFixed(1) + ' KB') + '</li>').join('') + '</ul>' + (r.conflicts.length ? '<p>' + r.conflicts.length + ' conflict cop' + (r.conflicts.length > 1 ? 'ies' : 'y') + ' would be made.</p>' : '')
            : '<p>Nothing to write: GitHub already has every bench here.</p>';
          window.PLUMB.lastDry = r.dry;
        } catch (err) { out.innerHTML = '<p class="tb-bad">' + esc(err.message) + '</p>'; }
        return;
      }
      closeSheet(); syncNow();
    };
  }
  // quiet: the automatic sync on load and sign-in, which only pulls, and only when nothing here is edited; writing
  // is Sync now's alone.
  async function syncNow(quiet) {
    if (DEMO || !ST.token() || SY.busy || S.running) return;
    if (quiet && ST.unsynced().length) { renderSyncPill(); return; }
    SY.busy = true; SY.error = ''; renderSyncPill();
    try {
      const r = await ST.sync({ pullOnly: !!quiet });
      ST.reload();
      if (CUR && !ST.get(CUR)) { const nx = ST.list()[0]; openProject(nx ? nx.id : null); }
      else if (CUR && !S.running) { const p = ST.get(CUR); if (p.bench.script !== S.text || p.bench.defs !== S.defsText) openProject(CUR); }
      else if (!CUR && ST.list().length) openProject(ST.list()[0].id);
      if (!quiet || r.pushed || r.conflicts.length) toast(r.pushed ? 'Synced: ' + r.pushed + ' file' + (r.pushed > 1 ? 's' : '') + ' written' : 'Synced: nothing new to write');
      if (r.conflicts.length) toast(r.conflicts.length + ' bench' + (r.conflicts.length > 1 ? 'es were' : ' was') + ' edited in two places; the other copy is kept as “(conflict copy)”');
    } catch (err) {
      SY.error = err.status === 404 ? 'No access to ' + ST.CFG.dataRepo : err.message;
    } finally { SY.busy = false; renderSyncPill(); renderSide(); }
  }

  // A new build on the site: reload once the page is idle (no run, no sheet, nothing open for editing), as every
  // Signoff tool does; benches are already kept in this browser.
  const UPDATE_KEY = 'signoff.toolUpdate.plumb';
  function checkForUpdate() {
    const mine = (window.PLUMB || {}).VERSION; if (!mine) return;
    fetch('assets/version.js?nc=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((text) => {
      const m = /VERSION\s*=\s*'([0-9a-f]+)'/.exec(text || ''); if (!m || m[1] === mine) return;
      try { if (sessionStorage.getItem(UPDATE_KEY) === m[1]) return; } catch (e) { /* storage off */ }
      const idle = !S.running && $('#sheet').hidden && $('#modal').hidden && !S.form && document.activeElement !== $('#script') && !document.querySelector('#people-pop, .tk-wrap');
      if (!idle) return;
      try { sessionStorage.setItem(UPDATE_KEY, m[1]); } catch (e) { /* storage off */ }
      toast('Tool updated'); setTimeout(() => location.reload(), 900);
    }).catch(() => { /* offline */ });
  }

  function toggleNav() {
    const app = $('#app');
    if (window.innerWidth <= 860) app.classList.toggle('nav-open');
    else {
      app.classList.toggle('side-collapsed');
      try { localStorage.setItem('plumb.v1.ui.side', app.classList.contains('side-collapsed') ? '1' : ''); } catch (e) { /* storage off */ }
    }
    X.dirty = true;
  }
  function setView(v) {
    S.view = v;
    try { localStorage.setItem('plumb.v1.ui.view', v); } catch (e) { /* storage off */ }
    document.querySelectorAll('#ctl-view button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#tests-wrap').dataset.view = v;
  }
  function renderAttach() {
    if (brLive()) {
      $('#ctl-attach').innerHTML = Object.keys((S.defs && S.defs.targets) || {}).map((k) => {
        const t = BR.targets[k];
        const live = t && t.ok && !t.waiting;
        const tip = !t ? 'Not checked yet' : t.waiting ? k + ': ' + t.reason : t.ok ? 'The bridge reaches ' + k : k + ': ' + t.reason;
        return '<span class="tb-chip' + (live ? '' : ' off') + '" title="' + esc(tip) + '">' + (live ? '✓ ' : t && t.waiting ? '… ' : '') + esc(k) + '</span>';
      }).join('');
      return;
    }
    // Only the open bench's targets; sim.attached keeps the rest, so switching back finds them as they were.
    $('#ctl-attach').innerHTML = Object.keys((S.defs && S.defs.targets) || {}).map((k) => '<button class="tb-chip tb-chip-btn' + (sim.attached[k] ? '' : ' off') + '" data-t="' + k + '" title="Simulated: attach or detach ' + k + '">' + (sim.attached[k] ? '✓ ' : '') + k + '</button>').join('');
  }

  function bind() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tb-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (b.dataset.tab === 'bench') { renderTargets(); tickBench(); } else closeTarget();
      if (b.dataset.tab === 'explore') renderExplorer();
    });
    $('#theme-btn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
    $('#sync-pill').addEventListener('click', openSync);
    document.addEventListener('click', (e) => { const a = e.target.closest('[data-act="edit-bench"], [data-act="new-bench"]'); if (!a) return; openBenchSheet(a.dataset.act === 'edit-bench' ? CUR : null); });
    $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet')) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
    document.querySelectorAll('[data-act="nav"]').forEach((b) => b.addEventListener('click', toggleNav));
    $('#app').addEventListener('click', (e) => { if (e.target === $('#app') && $('#app').classList.contains('nav-open')) { e.stopPropagation(); $('#app').classList.remove('nav-open'); } }, true);
    document.addEventListener('keydown', (e) => { if (e.key === '[' && !e.target.closest('input, textarea, select')) toggleNav(); });
    $('#main').addEventListener('scroll', () => $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 70), { passive: true });
    $('#bench-search').addEventListener('input', renderSide);
    $('#bench-list').addEventListener('click', (e) => {
      const g = e.target.closest('[data-group]');
      if (g) { closedGroups.has(g.dataset.group) ? closedGroups.delete(g.dataset.group) : closedGroups.add(g.dataset.group); renderSide(); return; }
      const b = e.target.closest('[data-bench]');
      if (b && b.dataset.bench !== CUR) openProject(b.dataset.bench);
      if (b && window.innerWidth <= 860) $('#app').classList.remove('nav-open');
    });
    $('#ctl-view').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
    $('#ctl-fault').addEventListener('change', (e) => { sim.fault = e.target.value; sim.update(); log('info', 'Simulated: fault set to ' + e.target.selectedOptions[0].text.toLowerCase()); });
    $('#ctl-attach').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sim.attached[b.dataset.t] = !sim.attached[b.dataset.t];
      renderAttach(); renderRows(); if (!$('[data-pane="bench"]').hidden) renderTargets();
    });
    $('#run-all').addEventListener('click', () => { if (CUR) run(testsUnder(S.tree.root)); });
    $('#abort').addEventListener('click', () => { if (BR.running) { brSend({ type: 'abort' }); return; } S.abort = true; log('info', 'Abort: stopping, then cleanup'); });
    $('#bridge-row').addEventListener('click', (e) => {
      if (e.target.id === 'bridge-btn') { BR.state === 'off' ? brConnect() : brDisconnect(); }
      if (e.target.id === 'bridge-pair') { const v = $('#bridge-code').value.trim(); if (v) brPair(v); }
    });
    $('#bridge-row').addEventListener('keydown', (e) => { if (e.target.id === 'bridge-code' && e.key === 'Enter') { const v = e.target.value.trim(); if (v) brPair(v); } });
    renderBridge();
    $('#log-clear').addEventListener('click', () => { S.log = []; renderLog(); });

    let deb = 0;
    $('#script').addEventListener('scroll', syncCodeBg);
    ['click', 'keyup', 'focus'].forEach((ev) => $('#script').addEventListener(ev, () => setTimeout(pickFromScript, 0)));
    $('#script').addEventListener('input', (e) => { renderCodeBg(parseScript(e.target.value)); });
    $('#script').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { S.text = e.target.value; reparse(true); }, 250); });

    const rows = $('#rows');
    rows.addEventListener('click', (e) => {
      const pk = e.target.closest('[data-pick]');
      if (pk) pickFromRows(+pk.dataset.pick);
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'fold' && !e.target.closest('button')) { const f = foldedSet(), k = a.dataset.name; f.has(k) ? f.delete(k) : f.add(k); saveFolded(f); renderRows(); return; }
      if (act === 'fold-all') {
        const n = S.tree.nodes.find((x) => x.idx === +a.dataset.idx); if (!n) return;
        const f = foldedSet(); groupsUnder(n).forEach((g) => (a.dataset.to === 'shut' ? f.add(g.name) : f.delete(g.name))); saveFolded(f); renderRows(); return;
      }
      if (act === 'toggle' && !e.target.closest('button')) { const id = a.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderRows(); }
      if (act === 'run') { e.stopPropagation(); const n = S.tree.nodes.find((x) => x.idx === +a.dataset.idx); if (n) run(testsUnder(n)); }
      if (act === 'del') {
        const lines = S.tree.lines.slice(); const i = +a.dataset.idx;
        lines.splice(i, subtreeEnd(lines, i) - i); S.form = null; setLines(lines);
      }
      if (act === 'form') openForm('edit', { idx: +a.dataset.idx });
      if (act === 'ins') { const n = S.tree.nodes.find((x) => x.idx === +a.dataset.idx); openForm('pick', { test: testOf(n).idx, after: n.idx }); }
      if (act === 'pick-kind') openForm('new', { test: S.form.test, after: S.form.after, kind: a.dataset.kind });
      if (act === 'form-cancel') { S.form = null; renderRows(); }
      if (act === 'form-save') { readForm(a.closest('[data-form]')); saveForm(); }
      if (act === 'add-test') {
        const lines = S.tree.lines.slice(); const i = +a.dataset.idx; const end = subtreeEnd(lines, i);
        let k = 1; while (S.tree.tests['NEW-' + k]) k++;
        const lead = lines[i].lead + 2;
        lines.splice(end, 0, { lead, text: 'test NEW-' + k + ' New test' }, { lead: lead + 2, text: 'log "Write the steps"' });
        S.open.add('NEW-' + k); setLines(lines);
      }
    });
    rows.addEventListener('change', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'edit') {
        const lines = S.tree.lines.slice(); const i = +a.dataset.idx;
        const text = a.value.trim();
        if (!text) { lines.splice(i, subtreeEnd(lines, i) - i); } else lines[i] = { lead: lines[i].lead, text };
        setLines(lines);
      }
      if (a.dataset.act === 'add-step' && a.value) openForm('new', { test: +a.dataset.idx, after: null, kind: a.value });
    });
    // Form fields: a pick that changes what the form offers redraws it; anything else just updates the line.
    const formInput = (e) => {
      const el = e.target.closest('[data-form]'); if (!el || !e.target.dataset.f) return;
      const k = e.target.dataset.f, v = S.form.v;
      if (k === 'kind') { S.form.v = formValues(e.target.value); renderRows(); return; }
      readForm(el);
      if (k === 'target') { const t = S.defs.targets[v.target]; v.cmd = t ? Object.keys(t.commands)[0] : ''; v.args = null; Object.keys(v).forEach((x) => { if (/^u\d+$/.test(x)) delete v[x]; }); }
      if (k === 'cmd') { v.args = null; Object.keys(v).forEach((x) => { if (/^u\d+$/.test(x)) delete v[x]; }); }
      if (k === 'ref') { const u = refUnit(v.ref); ['au', 'bu', 'tolu'].forEach((x) => delete v[x]); if (u === '' && v.op !== 'contains') v.op = 'is'; if (u !== '' && (v.op === 'is' || v.op === 'contains')) v.op = 'range'; }
      if (e.type === 'change' && ['target', 'cmd', 'ref', 'op'].includes(k)) { renderRows(); return; }
      const line = stepLine(v); const out = el.querySelector('#form-line'); if (out) out.textContent = line;
    };
    rows.addEventListener('input', formInput);
    rows.addEventListener('change', formInput);
    rows.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.tb-sedit')) e.target.blur();
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.matches('.tb-sedit')) { e.preventDefault(); e.target.blur(); moveBy(+e.target.dataset.idx, e.key === 'ArrowUp' ? -1 : 1); }
      const form = e.target.closest('[data-form]');
      if (form && e.key === 'Escape') { S.form = null; renderRows(); }
      if (form && e.key === 'Enter' && !e.target.matches('textarea')) { e.preventDefault(); readForm(form); saveForm(); }
    });
    // Drag a step by its ⠿ grip onto another step of the same test: the top half drops before it, the bottom after.
    let dragFrom = null;
    rows.addEventListener('mousedown', (e) => { const g = e.target.closest('.tb-grip'); if (g && !S.running) g.closest('.tb-step').draggable = true; });
    rows.addEventListener('mouseup', () => { if (dragFrom == null) document.querySelectorAll('.tb-step[draggable="true"]').forEach((x) => { x.draggable = false; }); });
    rows.addEventListener('dragstart', (e) => { const st = e.target.closest && e.target.closest('.tb-step'); if (!st) return; dragFrom = +st.dataset.step; st.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', st.querySelector('.tb-sedit').value); });
    const dropAt = (e) => {
      const st = e.target.closest && e.target.closest('.tb-step'); if (!st || dragFrom == null) return null;
      const to = +st.dataset.step; if (to === dragFrom) return null;
      const a = S.tree.nodes.find((x) => x.idx === dragFrom), b = S.tree.nodes.find((x) => x.idx === to);
      if (!a || !b || testOf(a) !== testOf(b)) return null;
      const r = st.getBoundingClientRect();
      return { st, to, where: e.clientY < r.top + r.height / 2 ? 'before' : 'after' };
    };
    const clearDrop = () => document.querySelectorAll('.tb-step.drop-before, .tb-step.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    rows.addEventListener('dragover', (e) => { const d = dropAt(e); clearDrop(); if (!d) return; e.preventDefault(); d.st.classList.add('drop-' + d.where); });
    rows.addEventListener('drop', (e) => { const d = dropAt(e); clearDrop(); if (!d) return; e.preventDefault(); const from = dragFrom; dragFrom = null; moveStep(from, d.to, d.where); });
    rows.addEventListener('dragend', () => { clearDrop(); document.querySelectorAll('.tb-step[draggable="true"]').forEach((x) => { x.draggable = false; x.classList.remove('dragging'); }); dragFrom = null; });

    const targets = $('#targets');
    targets.addEventListener('change', (e) => { if (e.target.dataset.act === 'pick-cmd') drawParams(e.target.closest('.tb-target')); });
    targets.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="add-target"]')) { addTarget(); return; }
      const card = e.target.closest('.tb-target');
      if (card && !e.target.closest('.tb-tk, select, input, button, .tb-send')) { openTarget(+card.dataset.k); return; }
    });
    targets.addEventListener('click', (e) => {
      const k = e.target.closest('.tb-tk'); if (!k) return;
      const key = k.closest('.tb-target').dataset.target + '.' + k.closest('tr').dataset.tlm;
      if (!X.plotted.includes(key)) X.plotted.push(key);
      X.sel = 't:' + key; savePlot();
      $('#tabs [data-tab="explore"]').click();
    });
    targets.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act="send"]'); if (!b) return;
      const el = b.closest('.tb-target'); const t = el.dataset.target;
      const c = el.querySelector('[data-act="pick-cmd"]').value;
      const args = [...el.querySelectorAll('[data-p]')].map((x) => (/\s/.test(x.value.trim()) && !/^[-+]?[\d.]+\s+\S+$/.test(x.value.trim()) ? '"' + x.value.trim() + '"' : x.value.trim()));
      const out = el.querySelector('.tb-sent');
      const line = t + '.' + c + (args.length ? ' ' + args.join(' ') : '');
      try {
        const r = await sendCommand(line, null);
        out.innerHTML = '<code>' + esc(line) + '</code> → ' + esc(typeof r === 'number' ? trimNum(r, 5) : String(r).split('\n').join(' ⏎ ') || 'OK');
        out.className = 'tb-sent ok';
      } catch (err) { out.innerHTML = '<code>' + esc(line) + '</code> ✕ ' + esc(err.message); out.className = 'tb-sent bad'; }
      tickBench();
    });
  }

  function loadDefs() {
    S.defs = parseDefs(S.defsText);
    Object.keys(S.defs.targets).forEach((k) => { if (!(k in sim.attached)) sim.attached[k] = false; });
    renderAttach();
    brLoadSoon();
  }

  function start() {
    const kept = suiteTheme();
    const dark = kept ? kept === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'dark' : 'light');
    try { if (localStorage.getItem('plumb.v1.ui.side')) $('#app').classList.add('side-collapsed'); } catch (e) { /* storage off */ }
    if (DEMO) {
      const b = $('#demo-banner');
      b.hidden = false; document.body.classList.add('has-banner');
      b.innerHTML = 'Demo: the made-up Smart Thermostat for Acme Climate. Benches here stay in this browser, and the bench is simulated. <a href="./">Leave the demo</a>';
      document.querySelectorAll('[data-demo-href]').forEach((a) => { a.href = a.getAttribute('href') + '?demo'; });
      // The demo bench: the thermostat's Main PCBA, linked to Signoff EE's demo board of the same name.
      if (!ST.get(DEMO_ID)) ST.create({ id: DEMO_ID, name: 'Main PCBA bring-up', project: 'Smart Thermostat', board: { id: 'pdemo7', name: 'Main PCBA' }, defs: DEFAULT_DEFS, script: DEFAULT_SCRIPT });
    }
    $('#version').textContent = 'Build ' + ((window.PLUMB || {}).VERSION || 'dev');
    setView(S.view);
    S.defsText = ''; S.text = '';
    loadDefs();
    S.loading = true; reparse(false); S.loading = false;
    bind();
    bindExplorer();
    bindInspector();
    bindAutocomplete();
    $('#ref-btn').addEventListener('click', openReference);
    if (window.SignoffFoot) window.SignoffFoot.mount({
      settings: '[data-foot-settings]', people: '#people-link', tools: '#side-tools',
      theme: () => document.documentElement.dataset.theme, setTheme: (t) => setTheme(t, true),
      intro: 'Plumb keeps benches in this browser. Signed in, they sync with the private plumb_data repo, and each can name the Signoff EE board it tests.',
      changed: () => { renderSyncPill(); renderEmpty(); syncNow(true); }
    });
    let want = null; try { want = localStorage.getItem(CUR_KEY); } catch (e) { /* storage off */ }
    const first = (want && ST.get(want)) ? want : (ST.list()[0] || {}).id;
    openProject(first || null);
    renderSyncPill();
    setRate(X.rate);
    requestAnimationFrame(plotLoop);
    setInterval(tickBench, 250);
    setInterval(renderSyncPill, 60000);
    setTimeout(checkForUpdate, 5000); setInterval(checkForUpdate, 5 * 60000);
    if (!DEMO) syncNow(true);
    log('info', 'Simulated bench: PSU, SCOPE, LOGIC, and MAIN attached. Real instruments need the bench bridge (to come).');
    window.TBLab = { S, X, sim, drawPlot, parseScript, serialize, parseStep, parseQty, fmtQty, lint, run, testsUnder, openProject, ST };
  }
  // The step language without the page, for the test page's conformance check against the bench bridge's parser.
  window.PLUMB = window.PLUMB || {};
  window.PLUMB.lang = { parseQty, parseCond, condText, condPass, parseStep, parseDefs, parseScript, serialize, lint, needsOf, subtreeEnd, fmtQty, trimNum, DEFAULT_DEFS, DEFAULT_SCRIPT };
  if (!window.PLUMB_NO_UI) start();
})();
