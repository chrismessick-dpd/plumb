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
      } else if ((m = /^command\s+([a-z_]\w*)\s*(.*?)(?:\s*->\s*(\w+))?$/.exec(line))) {
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
      } else if ((m = /^telemetry\s+([a-z_]\w*)\s+(\S+)\s+"([^"]*)"\s*(.*)$/.exec(line))) {
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
            await cmd('PSU.set_voltage', f'{v} V')
            await wait(150)
            try:
                state = await tlm('MAIN.state')
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

  const REF = '([A-Z][A-Z0-9_]*\\.[a-z_][\\w$]*|[a-z_]\\w*)';
  function parseCond(s) {
    s = s.trim();
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
    tell: 'Tell operator', log: 'Log', call: 'Call', repeat: 'Repeat', for: 'For each', script: 'Script', cleanup: 'Cleanup', bad: '?'
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
    if ((m = /^call\s+(\S+)$/.exec(text))) return { kind: 'call', id: m[1] };
    if ((m = /^repeat\s+(\d+)$/.exec(text))) return { kind: 'repeat', n: +m[1] };
    if ((m = /^for\s+([a-z_]\w*)\s+in\s+(.+)$/.exec(text))) return { kind: 'for', v: m[1], items: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
    if (text === 'script') return { kind: 'script' };
    if (text === 'cleanup') return { kind: 'cleanup' };
    if ((m = /^([A-Z][A-Z0-9_]*)\.([a-z_][\w$]*)\s*(.*?)(?:\s*->\s*([a-z_]\w*))?$/.exec(text))) {
      return { kind: 'command', target: m[1], cmd: m[2], args: tokenize(m[3]), into: m[4] || null };
    }
    return { kind: 'bad' };
  }
  function tokenize(s) {
    const raw = s.match(/"[^"]*"|\S+/g) || [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i], nx = raw[i + 1];
      if (/^[-+]?[\d.]+$/.test(t) && nx && unitOf(nx) && unitOf(nx).unit) { out.push(t + ' ' + nx); i++; } else out.push(t.replace(/^"|"$/g, ''));
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
  try { const v = localStorage.getItem('plumb.lab.view'); if (v) S.view = v; } catch (e) { /* storage off */ }

  function reparse(fromText) {
    S.tree = parseScript(S.text);
    S.issues = lint(S.tree, S.defs);
    if (!fromText) $('#script').value = S.text;
    renderRows(); renderLint(); renderRoundTrip(); renderEvidence(); renderSummary();
  }
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
    nodes.forEach((n) => { if (n.kind === 'step' && n.step.kind === 'cleanup') ctx.cleanups.push({ nodes: n.children, vars, node: n }); });
    for (const n of nodes) {
      if (n.kind !== 'step' || n.step.kind === 'cleanup') continue;
      if (S.abort && !S.inCleanup) throw new Abort('Aborted');
      S.current = n.idx; renderRows();
      await execStep(n, ctx, vars);
    }
  }

  async function execStep(n, ctx, vars) {
    const text = sub(n.text, vars);
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
    PY.w = new Worker('script-worker.js');
    PY.state = 'loading'; renderPy();
    PY.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'loaded') { PY.state = 'ready'; PY.version = m.version; log('info', 'Python ' + m.version + ' loaded in ' + fmtQty(m.ms / 1000, 's')); renderPy(); return; }
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

  async function runTest(test) {
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
    try { await execBlock(test.children, ctx, {}); if (ctx.failed) verdict = 'fail'; }
    catch (e) {
      if (e instanceof Abort) { verdict = 'aborted'; note = 'Aborted'; }
      else if (e.message === 'timeout') verdict = 'fail';
      else { verdict = 'error'; note = e.message; }
    }
    if (ctx.cleanups.length) {
      S.inCleanup = true;
      log('info', 'Cleanup (always runs)');
      for (const c of ctx.cleanups.reverse()) {
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

  /* ---------- Rendering: rows ---------- */

  const VERDICT = { pass: ['Pass', '✓'], fail: ['Fail', '✕'], error: ['Error', '!'], skip: ['Skipped', '–'], aborted: ['Aborted', '■'], running: ['Running', '●'], done: ['Done', '·'] };
  function badge(v, small) {
    if (!v) return '<span class="tb-v tb-v-none' + (small ? ' sm' : '') + '">' + (small ? '' : 'Not run') + '</span>';
    const [l, g] = VERDICT[v] || [v, ''];
    return '<span class="tb-v tb-v-' + v + (small ? ' sm' : '') + '" title="' + l + '"><i>' + g + '</i>' + (small ? '' : l) + '</span>';
  }

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

  function nodeHtml(n) {
    if (n.kind === 'suite' || n.kind === 'group') {
      return '<div class="tb-' + n.kind + '"><div class="tb-' + n.kind + '-head"><span class="tb-kind">' + n.kind + '</span><b>' + esc(n.name) + '</b>' +
        countsHtml(counts(n)) + '<span class="tb-grow"></span>' +
        (n.kind === 'group' ? '<button class="btn btn-plain" data-act="add-test" data-idx="' + n.idx + '">+ Test</button>' : '') +
        '<button class="btn btn-plain" data-act="run" data-idx="' + n.idx + '"' + (S.running ? ' disabled' : '') + '>▶ Run</button></div>' +
        n.children.map(nodeHtml).join('') + '</div>';
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
      '<div class="tb-test-row" data-act="toggle" data-id="' + esc(t.id) + '">' +
      '<span class="tb-chev">' + (open ? '▾' : '▸') + '</span>' + badge(r && r.verdict) +
      '<span class="tb-id">' + esc(t.id) + '</span><span class="tb-ttl">' + esc(t.title) + (nIssues ? ' <span class="tb-lintmark" title="' + nIssues + ' line' + (nIssues > 1 ? 's' : '') + ' to fix">✕ ' + nIssues + '</span>' : '') + '</span>' +
      '<span class="tb-needs">' + need.map((x) => '<span class="tb-chip' + (sim.attached[x] && S.defs.targets[x] ? '' : ' off') + '" title="' + (sim.attached[x] ? 'Uses ' : 'Needs, not attached: ') + x + '">' + esc(x) + '</span>').join('') + '</span>' +
      '<span class="tb-reqs">' + t.reqs.map((q) => '<span class="tb-req">' + esc(q) + '</span>').join('') + '</span>' +
      '<span class="tb-mcol">' + (r && r.note ? '<span class="tb-note-s">' + esc(r.note) + '</span>' : meas) + '</span>' +
      '<span class="tb-time">' + (r && r.ms ? fmtQty(r.ms / 1000, 's') : '') + '</span>' +
      '<button class="btn btn-plain tb-run1" data-act="run" data-idx="' + t.idx + '"' + (S.running ? ' disabled' : '') + ' title="Run this test">▶</button></div>';
    if (open) {
      h += '<div class="tb-steps">' + t.children.map((c) => stepHtml(c, 0)).join('') +
        '<div class="tb-addrow"><select class="tb-select" data-act="add-step" data-idx="' + t.idx + '"' + (S.running ? ' disabled' : '') + '><option value="">+ Add step…</option>' +
        Object.keys(TEMPLATES).map((k) => '<option value="' + k + '">' + KIND_LABEL[k] + '</option>').join('') + '</select>' +
        '<span class="tb-dim">Each row is one line of the script. Edit a row and the text follows.</span></div></div>';
    }
    return h + '</div>';
  }
  function countIssues(n) { let c = S.issues[n.idx] ? 1 : 0; n.children.forEach((k) => { c += countIssues(k); }); return c; }

  function stepHtml(n, depth) {
    if (n.kind !== 'step') return '';
    const s = n.step, res = S.steps[n.idx], iss = S.issues[n.idx];
    const kind = s.kind;
    const cur = S.current === n.idx && S.running;
    let h = '<div class="tb-step k-' + kind + (cur ? ' cur' : '') + '" style="--d:' + depth + '">' +
      '<span class="tb-skind">' + esc(KIND_LABEL[kind] || kind) + '</span>' +
      '<input class="tb-sedit" data-act="edit" data-idx="' + n.idx + '" value="' + esc(n.text) + '"' + (S.running ? ' readonly' : '') + '>' +
      '<span class="tb-sres">' + (res ? badge(res.verdict, true) + '<span class="tb-sval">' + esc(res.list.length > 1 ? res.list.map((x) => x.value || VERDICT[x.verdict][1]).join(' · ') : (res.value || '')) + '</span>' + (res.limit ? '<span class="tb-slim">' + esc(res.limit) + '</span>' : '') + (res.note ? '<span class="tb-snote">' + esc(res.note) + '</span>' : '') : '') + '</span>' +
      '<button class="tb-x" data-act="del" data-idx="' + n.idx + '" title="Delete this step"' + (S.running ? ' disabled' : '') + '>×</button></div>';
    if (iss) h += '<div class="tb-step-issue" style="--d:' + depth + '">✕ ' + esc(iss.join('; ')) + '</div>';
    if (kind === 'script') {
      h += '<pre class="tb-sbody" style="--d:' + (depth + 1) + '">' + esc(n.body.map((i) => ' '.repeat(Math.max(0, S.tree.lines[i].lead - n.lead - 2)) + S.tree.lines[i].text).join('\n')) + '</pre>';
    }
    h += n.children.map((c) => stepHtml(c, depth + 1)).join('');
    return h;
  }

  const TEMPLATES = {
    command: 'PSU.set_voltage 12 V', wait: 'wait 100 ms', until: 'wait until MAIN.state == "RUN" within 5 s', check: 'check MAIN.rail_3v3 3.3 V ±3%',
    measure: 'measure MAIN.temp as temp', ask: 'ask "Is the LED green?"', tell: 'tell "Press the button now"', log: 'log "Note"',
    call: 'call PWR-01', repeat: 'repeat 3', for: 'for n in 1, 2', script: 'script', cleanup: 'cleanup'
  };
  function subtreeEnd(lines, idx) {
    const lead = lines[idx].lead; let j = idx + 1;
    while (j < lines.length && (!lines[j].text || lines[j].lead > lead)) j++;
    while (j > idx + 1 && !lines[j - 1].text) j--;
    return j;
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
    }).join('') + '</tbody></table><button class="btn" disabled title="Lab only">Send as evidence to Signoff EE…</button>' : '<p class="tb-dim">No test names a requirement. Add <code>[REQ-…]</code> to a test line.</p>';
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
    $('#targets').innerHTML = Object.values(T).map((t) => {
      const ip = ifacePath(t.iface);
      const att = sim.attached[t.name];
      const cmds = Object.values(t.commands);
      return '<div class="tb-card tb-target' + (att ? '' : ' off') + '" data-target="' + t.name + '">' +
        '<div class="tb-t-head"><div><div class="tb-t-name">' + esc(t.name) + '</div><div class="tb-t-title">' + esc(t.title) + '</div></div>' +
        '<span class="tb-t-state">' + (att ? '<i class="ok"></i>Attached' : '<i></i>Not attached') + '</span></div>' +
        '<div class="tb-t-iface"><span class="tb-chip">' + esc(ip.label) + '</span><span class="tb-dim">' + esc(ip.path) + ' · simulated here</span></div>' +
        (t.order.length ? '<table class="tb-tlm"><tbody>' + t.order.map((k) => {
          const tl = t.telemetry[k];
          return '<tr data-tlm="' + k + '"><td class="tb-tk">' + esc(k) + '</td><td class="tb-tv">–</td><td class="tb-tl">' + limText(tl) + '</td><td class="tb-spark"><svg viewBox="0 0 80 20" preserveAspectRatio="none"><polyline points=""/></svg></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="tb-dim tb-notlm">No telemetry; commands return their data.</p>') +
        (cmds.length ? '<div class="tb-send"><select class="tb-select" data-act="pick-cmd">' + cmds.map((c) => '<option>' + esc(c.name) + '</option>').join('') + '</select><span class="tb-params"></span><button class="btn btn-primary" data-act="send"' + (att ? '' : ' disabled') + '>Send</button></div><div class="tb-sent"></div>' : '') +
        '</div>';
    }).join('');
    document.querySelectorAll('.tb-target').forEach((el) => drawParams(el));
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
  try { const p = JSON.parse(localStorage.getItem('plumb.lab.plot') || 'null'); if (p) { X.plotted = p.plotted || []; X.win = p.win || 30; } } catch (e) { /* storage off */ }
  if (!X.plotted.length) X.plotted = ['PSU.current', 'MAIN.rail_3v3', 'MAIN.state'];
  function savePlot() { try { localStorage.setItem('plumb.lab.plot', JSON.stringify({ plotted: X.plotted, win: X.win })); } catch (e) { /* storage off */ } }

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

  /* ---------- The sidebar: benches by project ---------- */

  // A bench is one station's targets and suites; benches group by the client project, as Signoff groups reviews.
  // Only the Main PCBA bench is built in the lab.
  const BENCHES = [
    { project: 'Smart Thermostat', items: [
      { id: 'main', name: 'Main PCBA bring-up', sub: 'PSU, scope, logic analyzer · 8 tests' },
      { id: 'disp', name: 'Display & Sensor Board', sub: 'PSU, logic analyzer · 5 tests', pct: 60 },
      { id: 'sys', name: 'Thermostat system test', sub: 'Main PCBA + display + wall unit · 12 tests', pct: 25 }
    ] },
    { project: 'Zone Controller', items: [
      { id: 'zone', name: 'Controller board', sub: 'PSU, CAN adapter · 9 tests', pct: 100 }
    ] }
  ];
  function ringSvg(pct, size, stroke) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, h = size / 2;
    return '<div class="ring" style="width:' + size + 'px;height:' + size + 'px"><svg width="' + size + '" height="' + size + '">' +
      '<circle class="ring-track" cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
      '<circle class="ring-val" cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + c * (1 - pct / 100) + '"/></svg></div>';
  }
  const closedGroups = new Set();
  function renderSide() {
    const q = ($('#bench-search').value || '').trim().toLowerCase();
    const c = counts(S.tree.root);
    const mainPct = c.total ? Math.round(100 * c.pass / c.total) : 0;
    const html = BENCHES.map((g) => {
      const items = g.items.filter((b) => !q || (g.project + ' ' + b.name + ' ' + b.sub).toLowerCase().includes(q));
      if (!items.length) return '';
      const open = q || !closedGroups.has(g.project) || items.some((b) => b.id === 'main');
      return '<div class="side-group"><button class="side-group-head" data-group="' + esc(g.project) + '" aria-expanded="' + !!open + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="side-group-name">' + esc(g.project) + '</span><span class="side-group-count">' + g.items.length + '</span></button>' +
        (open ? items.map((b) => '<button class="proj' + (b.id === 'main' ? ' active' : '') + '" data-bench="' + b.id + '" title="' + esc(b.name + '\n' + b.sub + (b.id === 'main' ? '\n' + c.pass + ' of ' + c.total + ' tests pass' : '\nLab: not built')) + '">' +
          ringSvg(b.id === 'main' ? mainPct : b.pct, 26, 3.5) +
          '<span class="proj-body"><span class="proj-name">' + esc(b.name) + '</span><span class="proj-sub">' + esc(b.id === 'main' ? (c.pass + ' of ' + c.total + ' pass · ' + Object.keys(S.defs.targets).length + ' targets') : b.sub) + '</span></span></button>').join('') : '') + '</div>';
    }).join('');
    $('#bench-list').innerHTML = html || '<div class="side-empty">No matching benches.</div>';
    $('#bench-sub').textContent = Object.keys(S.defs.targets).length + ' targets · ' + c.total + ' tests' + (c.pass + c.fail + c.error ? ' · ' + c.pass + ' passed' + (c.fail + c.error ? ', ' + (c.fail + c.error) + ' failed' : '') : '');
  }

  function toggleNav() {
    const app = $('#app');
    if (window.innerWidth <= 860) app.classList.toggle('nav-open');
    else {
      app.classList.toggle('side-collapsed');
      try { localStorage.setItem('plumb.lab.side', app.classList.contains('side-collapsed') ? '1' : ''); } catch (e) { /* storage off */ }
    }
    X.dirty = true;
  }
  function setView(v) {
    S.view = v;
    try { localStorage.setItem('plumb.lab.view', v); } catch (e) { /* storage off */ }
    document.querySelectorAll('#ctl-view button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#tests-wrap').dataset.view = v;
  }
  function renderAttach() {
    $('#ctl-attach').innerHTML = Object.keys(sim.attached).map((k) => '<button class="tb-chip tb-chip-btn' + (sim.attached[k] ? '' : ' off') + '" data-t="' + k + '" title="Lab only: attach or detach ' + k + '">' + (sim.attached[k] ? '✓ ' : '') + k + '</button>').join('');
  }

  function bind() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tb-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (b.dataset.tab === 'bench') { renderTargets(); tickBench(); }
      if (b.dataset.tab === 'explore') renderExplorer();
    });
    $('#theme-btn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
    $('#settings-btn').addEventListener('click', () => toast('Lab: Settings, sign-in, and sync come with the tool'));
    $('#sync-pill').addEventListener('click', () => toast('Lab: nothing syncs. The tool will keep benches, suites, and runs in plumb_data.'));
    document.querySelectorAll('[data-act="nav"]').forEach((b) => b.addEventListener('click', toggleNav));
    $('#app').addEventListener('click', (e) => { if (e.target === $('#app') && $('#app').classList.contains('nav-open')) { e.stopPropagation(); $('#app').classList.remove('nav-open'); } }, true);
    document.addEventListener('keydown', (e) => { if (e.key === '[' && !e.target.closest('input, textarea, select')) toggleNav(); });
    $('#main').addEventListener('scroll', () => $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 70), { passive: true });
    $('#bench-search').addEventListener('input', renderSide);
    $('#bench-list').addEventListener('click', (e) => {
      const g = e.target.closest('[data-group]');
      if (g) { closedGroups.has(g.dataset.group) ? closedGroups.delete(g.dataset.group) : closedGroups.add(g.dataset.group); renderSide(); return; }
      const b = e.target.closest('[data-bench]');
      if (b && b.dataset.bench !== 'main') toast('Lab: only the Main PCBA bench is built');
      if (b && window.innerWidth <= 860) $('#app').classList.remove('nav-open');
    });
    $('[data-act="new-bench"]').addEventListener('click', () => toast('Lab: New bench would pick targets from the library, then start an empty suite'));
    $('#ctl-view').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
    $('#ctl-fault').addEventListener('change', (e) => { sim.fault = e.target.value; sim.update(); log('info', 'Lab: fault set to ' + e.target.selectedOptions[0].text.toLowerCase()); });
    $('#ctl-attach').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sim.attached[b.dataset.t] = !sim.attached[b.dataset.t];
      renderAttach(); renderRows(); if (!$('[data-pane="bench"]').hidden) renderTargets();
    });
    $('#run-all').addEventListener('click', () => run(testsUnder(S.tree.root)));
    $('#abort').addEventListener('click', () => { S.abort = true; log('info', 'Abort: stopping, then cleanup'); });
    $('#log-clear').addEventListener('click', () => { S.log = []; renderLog(); });

    let deb = 0;
    $('#script').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { S.text = e.target.value; reparse(true); }, 250); });
    $('#defs').addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => { S.defsText = e.target.value; loadDefs(); reparse(true); X.plotted = X.plotted.filter(unitFor2); }, 300);
    });

    const rows = $('#rows');
    rows.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'toggle' && !e.target.closest('button')) { const id = a.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderRows(); }
      if (act === 'run') { e.stopPropagation(); const n = S.tree.nodes.find((x) => x.idx === +a.dataset.idx); if (n) run(testsUnder(n)); }
      if (act === 'del') {
        const lines = S.tree.lines.slice(); const i = +a.dataset.idx;
        lines.splice(i, subtreeEnd(lines, i) - i); setLines(lines);
      }
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
      if (a.dataset.act === 'add-step' && a.value) {
        const lines = S.tree.lines.slice(); const i = +a.dataset.idx;
        const test = S.tree.nodes.find((x) => x.idx === i);
        const cl = test.children.find((c) => c.kind === 'step' && c.step.kind === 'cleanup');
        const at = a.value === 'cleanup' || !cl ? subtreeEnd(lines, i) : cl.idx;
        const lead = lines[i].lead + 2;
        const add = [{ lead, text: TEMPLATES[a.value] }];
        if (a.value === 'repeat' || a.value === 'for') add.push({ lead: lead + 2, text: 'wait 100 ms' });
        if (a.value === 'cleanup') add.push({ lead: lead + 2, text: 'PSU.output off' });
        if (a.value === 'script') add.push({ lead: lead + 2, text: "log('Hello from Python')" });
        lines.splice(at, 0, ...add); setLines(lines);
      }
    });
    rows.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.tb-sedit')) e.target.blur(); });

    const targets = $('#targets');
    targets.addEventListener('change', (e) => { if (e.target.dataset.act === 'pick-cmd') drawParams(e.target.closest('.tb-target')); });
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
    $('#defs-lint').innerHTML = S.defs.errors.length
      ? S.defs.errors.map((x) => '<div class="tb-lint-row"><span>Line ' + x.line + '</span>' + esc(x.msg) + '</div>').join('')
      : '<div class="tb-lint-ok">✓ ' + Object.keys(S.defs.targets).length + ' targets read.</div>';
    Object.keys(S.defs.targets).forEach((k) => { if (!(k in sim.attached)) sim.attached[k] = false; });
    renderAttach();
  }

  function start() {
    const kept = suiteTheme();
    const dark = kept ? kept === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'dark' : 'light');
    try { if (localStorage.getItem('plumb.lab.side')) $('#app').classList.add('side-collapsed'); } catch (e) { /* storage off */ }
    setView(S.view);
    $('#defs').value = S.defsText;
    loadDefs();
    reparse(false);
    bind();
    bindExplorer();
    setRate(X.rate);
    requestAnimationFrame(plotLoop);
    setInterval(tickBench, 250);
    log('info', 'Simulated bench ready: PSU, SCOPE, LOGIC, and MAIN attached.');
    window.TBLab = { S, X, sim, drawPlot, parseScript, serialize, parseStep, parseQty, fmtQty, lint, run, testsUnder };
  }
  start();
})();
