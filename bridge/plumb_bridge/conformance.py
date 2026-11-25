"""Write tests/conformance/python.json: the bridge's parser output for every item in tests/conformance/corpus.json.

The page's test page (tests/test.html) computes the same items with assets/app.js and compares, so the two parsers
can't drift apart unseen. The corpus's benches are the page's own demo bench (read from assets/app.js) and the
synthetic ones in the corpus. Run: python -m plumb_bridge conformance
"""
import json
import math
import os
import re

from . import lang

HERE = os.path.dirname(os.path.abspath(__file__))
PLUMB = os.path.normpath(os.path.join(HERE, '..', '..'))
CORPUS = os.path.join(PLUMB, 'tests', 'conformance', 'corpus.json')
OUT = os.path.join(PLUMB, 'tests', 'conformance', 'python.json')


def demo_texts():
    src = open(os.path.join(PLUMB, 'assets', 'app.js'), encoding='utf-8').read()
    get = lambda name: re.search(r'const ' + name + r' = `(.*?)`;', src, re.S).group(1)  # noqa: E731
    return get('DEFAULT_DEFS'), get('DEFAULT_SCRIPT')


def norm(x):
    """JSON-safe, the same way the page's normalizer writes it: ±Infinity and NaN as strings, None as null."""
    if isinstance(x, float):
        if x != x:
            return 'NaN'
        if math.isinf(x):
            return 'Infinity' if x > 0 else '-Infinity'
        return x
    if isinstance(x, dict):
        return {k: norm(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [norm(v) for v in x]
    return x


def script_out(text, defs_text):
    tree = lang.parse_script(text)
    defs = lang.parse_defs(defs_text)
    nodes = []
    for n in tree['nodes']:
        o = {'idx': n['idx'], 'lead': n['lead'], 'kind': n['kind'], 'parent': n.parent['idx']}
        for k in ('name', 'id', 'title', 'reqs', 'step'):
            if k in n:
                o[k] = n[k]
        if n.body is not None:
            o['body'] = n.body
        nodes.append(o)
    return {
        'lines': tree['lines'], 'nodes': nodes, 'tests': sorted(tree['tests']),
        'issues': {str(k): v for k, v in sorted(lang.lint(tree, defs).items())},
        'needs': {tid: sorted(lang.needs_of(t, tree)) for tid, t in sorted(tree['tests'].items())},
        'ends': [lang.subtree_end(tree['lines'], n['idx']) for n in tree['nodes']],
        'exact': lang.serialize(tree['lines']) == text,
    }


def build():
    c = json.load(open(CORPUS, encoding='utf-8'))
    dd, ds = demo_texts()
    benches = [{'name': 'demo', 'defs': dd, 'script': ds}] + c['benches']
    out = {
        'qty': [lang.parse_qty(s) for s in c['qty']],
        'cond': [lang.parse_cond(s) for s in c['cond']],
        'condText': [lang.cond_text(lang.parse_cond(s)) for s in c['cond']],
        'condPass': [lang.cond_pass(lang.parse_cond(s), v) for s, v in c['condPass']],
        'steps': [lang.parse_step(s) for s in c['steps']],
        'fmt': [lang.fmt_qty(v, u) for v, u in c['fmt']],
        'trim': [lang.trim_num(v, d) for v, d in c['trim']],
        'benches': [{'name': b['name'], 'defs': lang.parse_defs(b['defs']), 'script': script_out(b['script'], b['defs'])} for b in benches],
    }
    return norm(out)


def main():
    out = build()
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    print('wrote %s' % os.path.relpath(OUT, PLUMB))
