"""Plumb's step language in Python: quantities, target definitions, the test script, conditions, and lint.

A line-for-line port of the page's parser (assets/app.js), so the bench bridge reads a bench exactly as the page
does. tests/conformance (corpus.json, python.json) holds the two to the same answers: the page's test page compares
its own output with python.json, which `python -m plumb_bridge conformance` writes.
"""
import math
import re
from decimal import Decimal, ROUND_HALF_UP

A = re.ASCII

# ---------------------------------------------------------------- quantities: "40 mA" is 0.040 in amps
BASE = ['V', 'A', 'Hz', 's', 'W', 'Ω', '°C', '%', 'baud']
PREFIX = {'n': 1e-9, 'u': 1e-6, 'µ': 1e-6, 'm': 1e-3, 'k': 1e3, 'M': 1e6}
SCALED = ['V', 'A', 'Hz', 's', 'W', 'Ω']


def unit_of(u):
    if not u:
        return {'unit': '', 'mult': 1}
    if u in BASE:
        return {'unit': u, 'mult': 1}
    p, rest = PREFIX.get(u[0]), u[1:]
    if p and rest in SCALED:
        return {'unit': rest, 'mult': p}
    return None


_QTY = re.compile(r'^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(\S*)$', re.I | A)


def parse_qty(s):
    m = _QTY.match(str(s).strip())
    if not m:
        return None
    u = unit_of(m.group(2))
    if not u:
        return None
    return {'v': float(m.group(1)) * u['mult'], 'unit': u['unit']}


def to_precision(x, digits):
    """JavaScript's Number.prototype.toPrecision."""
    if x == 0:
        return '0' if digits == 1 else '0.' + '0' * (digits - 1)
    if not math.isfinite(x):
        return 'NaN' if x != x else ('Infinity' if x > 0 else '-Infinity')
    sign = '-' if x < 0 else ''
    # The exact binary value, rounded to `digits` significant digits with ties up, as the spec says (Python's own
    # formatting would round ties to even: 2.5 to 1 digit is "3" in JavaScript, "2" in Python).
    d = Decimal(abs(x))
    e = d.adjusted()
    q = d.scaleb(-e).quantize(Decimal(1).scaleb(-(digits - 1)), rounding=ROUND_HALF_UP)
    if q >= 10:
        e += 1
        q = d.scaleb(-e).quantize(Decimal(1).scaleb(-(digits - 1)), rounding=ROUND_HALF_UP)
    mant = format(q, 'f')
    if e < -6 or e >= digits:
        mant = mant.rstrip('.')
        return sign + mant + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    ds = mant.replace('.', '')
    if e >= 0:
        whole, frac = ds[:e + 1], ds[e + 1:]
        return sign + whole + ('.' + frac if frac else '')
    return sign + '0.' + '0' * (-e - 1) + ds


def js_num_str(x):
    """String(Number(x)) for a finite float, as JavaScript writes it."""
    if x != x:
        return 'NaN'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    if 'e' in r:
        mant, e = r.split('e')
        e = int(e)
        if -7 < e < 21:
            return format(x, 'f').rstrip('0').rstrip('.') if e < 0 else format(x, 'f')
        return mant + 'e' + ('+' if e > 0 else '-') + str(abs(e))
    return r


def trim_num(x, digits=4):
    s = to_precision(float(x), digits)
    if 'e' in s:
        return js_num_str(float(s))
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return s


def fmt_qty(v, unit=''):
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return str(v)
    if not unit:
        return trim_num(v)
    if unit not in SCALED or v == 0:
        return trim_num(v) + ' ' + unit
    a = abs(v)
    if a >= 1e6:
        p, d = 'M', 1e6
    elif a >= 1e3 and unit == 'Hz':
        p, d = 'k', 1e3
    elif a >= 1:
        p, d = '', 1
    elif a >= 1e-3:
        p, d = 'm', 1e-3
    else:
        p, d = 'µ', 1e-6
    return trim_num(v / d) + ' ' + p + unit


def _num(s):
    try:
        return float(s)
    except ValueError:
        return float('nan')


# ---------------------------------------------------------------- target definitions
def parse_range(s):
    m = re.match(r'^(-?[\d.]*)\.\.(-?[\d.]*)$', s, A)
    if not m:
        return None
    return [-math.inf if m.group(1) == '' else _num(m.group(1)), math.inf if m.group(2) == '' else _num(m.group(2))]


def parse_defs(text):
    targets, errors = {}, []
    cur = None
    for i, raw in enumerate(text.split('\n')):
        line = re.sub(r'\s+#.*$', '', raw, flags=A).strip()
        if not line or line.startswith('#'):
            continue
        n = i + 1
        m = re.match(r'^target\s+([A-Z][A-Z0-9_]*)\s+"([^"]*)"$', line, A)
        if m:
            cur = targets[m.group(1)] = {'name': m.group(1), 'title': m.group(2), 'iface': None, 'commands': {}, 'telemetry': {}, 'order': []}
            continue
        if not cur:
            errors.append({'line': n, 'msg': 'Start with a target line'})
            continue
        m = re.match(r'^interface\s+(\S+)\s*(.*)$', line, A)
        if m:
            cur['iface'] = {'type': m.group(1), 'parts': re.split(r'\s+', m.group(2)), 'text': m.group(1) + ' ' + m.group(2)}
            continue
        m = re.match(r'^command\s+([A-Za-z_]\w*)\s*(.*?)(?:\s*->\s*(\w+))?$', line, A)
        if m:
            rest = m.group(2)
            wm = re.search(r'"([^"]*)"\s*$', rest)
            specs = [x for x in re.split(r'\s+', (rest[:wm.start()] if wm else rest).strip()) if x]
            params = []
            for sp in specs:
                parts = sp.split('=')
                name, spec = parts[0], (parts[1] if len(parts) > 1 else '')
                if not spec:
                    params.append({'name': name, 'kind': 'any'})
                    continue
                if '|' in spec:
                    params.append({'name': name, 'kind': 'choice', 'choices': spec.split('|')})
                    continue
                um = re.match(r'^(-?[\d.]*\.\.-?[\d.]*)(\S*)$', spec, A)
                r = um and parse_range(um.group(1))
                if not r:
                    errors.append({'line': n, 'msg': "Can't read parameter " + sp})
                    params.append({'name': name, 'kind': 'any'})
                    continue
                params.append({'name': name, 'kind': 'range', 'range': r, 'unit': um.group(2) or ''})
            cur['commands'][m.group(1)] = {'name': m.group(1), 'params': params, 'wire': wm.group(1) if wm else '', 'returns': m.group(3) or None}
            continue
        m = re.match(r'^telemetry\s+([A-Za-z_]\w*)\s+(\S+)\s+"([^"]*)"\s*(.*)$', line, A)
        if m:
            t = {'name': m.group(1), 'unit': '' if m.group(2) == '-' else m.group(2), 'query': m.group(3), 'yellow': None, 'red': None}
            for x in re.findall(r'(?:yellow|red)\s+\S+', m.group(4)):
                k, r = re.split(r'\s+', x)
                t[k] = parse_range(r)
                if not t[k]:
                    errors.append({'line': n, 'msg': "Can't read limit " + x})
            cur['telemetry'][m.group(1)] = t
            cur['order'].append(m.group(1))
            continue
        errors.append({'line': n, 'msg': "Can't read this line"})
    return {'targets': targets, 'errors': errors}


# ---------------------------------------------------------------- the test script
def parse_script(text):
    lines = []
    for raw in text.replace('\r', '').split('\n'):
        t = raw.rstrip()
        lines.append({'lead': len(t) - len(t.lstrip()), 'text': t.lstrip()})
    if lines and lines[-1]['text'] == '' and text.endswith('\n'):
        lines.pop()
    return build_tree(lines)


def serialize(lines):
    return '\n'.join((' ' * l['lead'] + l['text']) if l['text'] else '' for l in lines) + '\n'


class Node(dict):
    """A tree node. Its parent and children are attributes, not dict keys, so a node prints without cycles."""
    __slots__ = ('parent', 'children', 'body')


def build_tree(lines):
    root = Node(kind='root', lead=-1, idx=-1)
    root.parent, root.children, root.body = None, [], None
    stack = [root]
    tests, nodes = {}, []
    script_lead = None
    for idx, l in enumerate(lines):
        if script_lead is not None:
            if not l['text'] or l['lead'] > script_lead:
                if l['text']:
                    stack[-1].body.append(idx)
                continue
            script_lead = None
            stack.pop()
        if not l['text'] or l['text'].startswith('#'):
            continue
        while len(stack) > 1 and stack[-1]['lead'] >= l['lead']:
            stack.pop()
        parent = stack[-1]
        node = Node(idx=idx, lead=l['lead'], text=l['text'])
        node.parent, node.children, node.body = parent, [], None
        w = re.split(r'\s+', l['text'])[0]
        if w in ('suite', 'group'):
            node['kind'] = w
            node['name'] = l['text'][len(w):].strip()
        elif w == 'test':
            node['kind'] = 'test'
            m = re.match(r'^test\s+(\S+)\s*(.*?)\s*(?:\[([^\]]*)\])?$', l['text'], A)
            node['id'] = m.group(1) if m else '?'
            node['title'] = m.group(2) if m else ''
            node['reqs'] = [x for x in re.split(r'[,\s]+', m.group(3)) if x] if m and m.group(3) else []
            tests[node['id']] = node
        else:
            node['kind'] = 'step'
            node['step'] = parse_step(l['text'])
        parent.children.append(node)
        nodes.append(node)
        if node['kind'] == 'step' and node['step']['kind'] == 'script':
            node.body = []
            script_lead = l['lead']
            stack.append(node)
            continue
        stack.append(node)
    return {'lines': lines, 'root': root, 'tests': tests, 'nodes': nodes}


REF = r'([A-Z][A-Z0-9_]*\.[A-Za-z_][\w$]*|[a-z_]\w*)'


def parse_cond(s):
    s = re.sub(r'\s*(?:\+/-|\+-)\s*', ' ± ', s.strip())
    m = re.match(r'^contains\s+"(.*)"$', s)
    if m:
        return {'op': 'contains', 'a': m.group(1)}
    m = re.match(r'^(==|=)\s*"(.*)"$', s)
    if m:
        return {'op': '==', 'a': m.group(2), 'str': True}
    m = re.match(r'^(<=|>=|<|>|==|=)\s*(.+)$', s)
    if m:
        q = parse_qty(m.group(2))
        return {'op': '==' if m.group(1) == '=' else m.group(1), 'a': q['v'], 'unit': q['unit']} if q else None
    m = re.match(r'^(.+?)\s*\.\.\s*(.+)$', s)
    if m:
        a, b = parse_qty(m.group(1)), parse_qty(m.group(2))
        return {'op': 'range', 'a': a['v'], 'b': b['v'], 'unit': b['unit'] or a['unit']} if a and b else None
    m = re.match(r'^(.+?)\s*±\s*(.+)$', s)
    if m:
        nom = parse_qty(m.group(1))
        if not nom:
            return None
        tm = re.match(r'^([\d.]+)\s*%$', m.group(2).strip(), A)
        if tm:
            tol = abs(nom['v']) * (_num(tm.group(1)) / 100)
        else:
            q = parse_qty(m.group(2))
            tol = q['v'] if q else None
        if tol is None or tol != tol:
            return None
        return {'op': 'range', 'a': nom['v'] - tol, 'b': nom['v'] + tol, 'unit': nom['unit'], 'nom': nom['v']}
    return None


def cond_text(c):
    if not c:
        return ''
    f = lambda v: fmt_qty(v, c.get('unit', ''))  # noqa: E731
    if c['op'] == 'range':
        return f(c['a']) + ' to ' + f(c['b'])
    if c['op'] == 'contains':
        return 'contains "' + c['a'] + '"'
    if c.get('str'):
        return '"' + c['a'] + '"'
    return c['op'] + ' ' + f(c['a'])


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def cond_pass(c, v):
    if c['op'] == 'contains':
        return isinstance(v, str) and c['a'] in v
    if c.get('str') or isinstance(v, str):
        js = lambda x: js_num_str(float(x)) if _is_num(x) else str(x)  # noqa: E731
        return c['op'] == '==' and js(v) == js(c['a'])
    if not _is_num(v) or v != v:
        return False
    op, a = c['op'], c['a']
    if op == 'range':
        return a - 1e-12 <= v <= c['b'] + 1e-12
    if op == '<':
        return v < a
    if op == '<=':
        return v <= a
    if op == '>':
        return v > a
    if op == '>=':
        return v >= a
    if op == '==':
        return abs(v - a) < 1e-9
    return False


def parse_step(text):
    m = re.match(r'^wait until ' + REF + r'\s+(.+?)\s+within\s+(.+)$', text, A)
    if m:
        t = parse_qty(m.group(3))
        return {'kind': 'until', 'ref': m.group(1), 'cond': parse_cond(m.group(2)), 'timeout': t['v'] if t and t['unit'] == 's' else None}
    m = re.match(r'^wait\s+(.+)$', text, A)
    if m:
        q = parse_qty(m.group(1))
        return {'kind': 'wait', 'sec': q['v'] if q and q['unit'] == 's' else None}
    m = re.match(r'^check ' + REF + r'\s+(.+)$', text, A)
    if m:
        return {'kind': 'check', 'ref': m.group(1), 'cond': parse_cond(m.group(2))}
    m = re.match(r'^measure ' + REF + r'\s+as\s+([a-z_]\w*)$', text, A)
    if m:
        return {'kind': 'measure', 'ref': m.group(1), 'as': m.group(2)}
    m = re.match(r'^(ask|tell|log)\s+"(.*)"$', text)
    if m:
        return {'kind': m.group(1), 'msg': m.group(2)}
    m = re.match(r'^todo\s+"(.*)"$', text)
    if m:
        return {'kind': 'todo', 'msg': m.group(1)}
    m = re.match(r'^call\s+(\S+)$', text, A)
    if m:
        return {'kind': 'call', 'id': m.group(1)}
    m = re.match(r'^repeat\s+(\d+)$', text, A)
    if m:
        return {'kind': 'repeat', 'n': int(m.group(1))}
    m = re.match(r'^for\s+([a-z_]\w*)\s+in\s+(.+)$', text, A)
    if m:
        return {'kind': 'for', 'v': m.group(1), 'items': [x.strip() for x in m.group(2).split(',') if x.strip()]}
    if text == 'script':
        return {'kind': 'script'}
    if text == 'script on bridge':
        return {'kind': 'script', 'bridge': True}
    if text == 'cleanup':
        return {'kind': 'cleanup'}
    m = re.match(r'^([A-Z][A-Z0-9_]*)\.([A-Za-z_][\w$]*)\s*(.*?)(?:\s*->\s*([a-z_]\w*))?$', text, A)
    if m:
        return {'kind': 'command', 'target': m.group(1), 'cmd': m.group(2), 'args': tokenize(m.group(3)), 'into': m.group(4) or None}
    return {'kind': 'bad'}


def tokenize(s):
    raw = re.findall(r'"[^"]*"|\S+', s)
    out, i = [], 0
    while i < len(raw):
        t = raw[i]
        nx = raw[i + 1] if i + 1 < len(raw) else None
        if re.match(r'^(?:[-+]?[\d.]+|\$[a-z_]\w*)$', t, A) and nx and unit_of(nx) and unit_of(nx)['unit']:
            out.append(t + ' ' + nx)
            i += 2
            continue
        out.append(re.sub(r'^"|"$', '', t))
        i += 1
    return out


def subtree_end(lines, idx):
    lead = lines[idx]['lead']
    j = idx + 1
    while j < len(lines) and (not lines[j]['text'] or lines[j]['lead'] > lead):
        j += 1
    while j > idx + 1 and not lines[j - 1]['text']:
        j -= 1
    return j


def needs_of(test, tree, seen=None):
    """Which targets a test touches, through its calls and its scripts."""
    seen = seen if seen is not None else set()
    out = set()
    if test['id'] in seen:
        return out
    seen.add(test['id'])

    def walk(n):
        for c in n.children:
            if c['kind'] != 'step':
                continue
            s = c['step']
            if s['kind'] == 'command':
                out.add(s['target'])
            if s['kind'] in ('check', 'until', 'measure') and '.' in s['ref']:
                out.add(s['ref'].split('.')[0])
            if s['kind'] == 'call' and s['id'] in tree['tests']:
                out.update(needs_of(tree['tests'][s['id']], tree, seen))
            if s['kind'] == 'script':
                for i in c.body:
                    for x in re.findall(r'[\'"]([A-Z][A-Z0-9_]*)\.', tree['lines'][i]['text'], A):
                        out.add(x)
            walk(c)
    walk(test)
    return out


def tests_under(n):
    if n['kind'] == 'test':
        return [n]
    out = []
    for c in n.children:
        out.extend(tests_under(c))
    return out


def lint(tree, defs):
    issues = {}

    def add(n, msg):
        issues.setdefault(n['idx'], []).append(msg)
    vars_ = set()
    for n in tree['nodes']:
        if n['kind'] != 'step':
            continue
        if n['step'].get('into'):
            vars_.add(n['step']['into'])
        if n['step']['kind'] == 'measure':
            vars_.add(n['step']['as'])
        if n['step']['kind'] == 'script':
            for i in n.body:
                m = re.search(r'record\([\'"](\w+)[\'"]', tree['lines'][i]['text'], A)
                if m:
                    vars_.add(m.group(1))
    T = defs['targets']
    for n in tree['nodes']:
        p = n.parent
        if n['kind'] == 'test' and not ((p and p['kind'] == 'group') or p['kind'] == 'suite'):
            add(n, 'A test sits under a suite or a group')
        if n['kind'] != 'step':
            continue
        s = n['step']
        if not p or p['kind'] in ('root', 'suite', 'group'):
            add(n, 'A step belongs inside a test')
        if s['kind'] == 'bad':
            add(n, "Can't read this step")
            continue
        if s['kind'] == 'command':
            t = T.get(s['target'])
            if not t:
                add(n, 'No target ' + s['target'])
                continue
            c = t['commands'].get(re.sub(r'\$\w+', '1', s['cmd'], flags=A))
            if not c:
                add(n, s['target'] + ' has no command ' + s['cmd'])
                continue
            if len(s['args']) != len(c['params']):
                add(n, s['cmd'] + ' takes ' + str(len(c['params'])) + ' parameter' + ('' if len(c['params']) == 1 else 's'))
        if s['kind'] in ('check', 'until', 'measure'):
            if '.' in s['ref']:
                tn, item = s['ref'].split('.', 1)
                key = re.sub(r'\$\w+', '1', item, flags=A)
                if tn not in T:
                    add(n, 'No target ' + tn)
                elif key not in T[tn]['telemetry']:
                    add(n, tn + ' has no telemetry ' + item)
                elif s.get('cond') and s['cond'].get('unit') and T[tn]['telemetry'][key]['unit'] != s['cond']['unit']:
                    add(n, 'Unit ' + s['cond']['unit'] + " doesn't match " + (T[tn]['telemetry'][key]['unit'] or 'a value without a unit'))
            elif s['ref'] not in vars_:
                add(n, 'Nothing records ' + s['ref'] + ' before this')
            if s['kind'] != 'measure' and not s.get('cond'):
                add(n, "Can't read the limit")
        if s['kind'] == 'until' and s.get('timeout') is None:
            add(n, 'Give a time: within 5 s')
        if s['kind'] == 'wait' and s.get('sec') is None:
            add(n, 'Give a time: wait 200 ms')
        if s['kind'] == 'call' and s['id'] not in tree['tests']:
            add(n, 'No test ' + s['id'])
    return issues
