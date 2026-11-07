#!/usr/bin/env python3
"""Score each reader on test-files/csv-real-world against labels.jsonl.

    python3 bench/real-world/score.py [--list TOOL]

Per file:
  encoding     the encoding family is right (ASCII counts as UTF-8)
  delimiter    the column separator is right (any run of spaces = whitespace)
  decimal      the decimal separator in use is right (pandas: always '.')
  data start   the first data row is within one line of the label (tables only)
  useful read  the read succeeds, gives a numeric column that is at least half
               numbers (a text column for state logs), and at least half the
               rows the file holds (tables only)
  right first time   all of the above at once (tables only)
"""
import argparse, json, os
from collections import defaultdict
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
labels = {json.loads(l)['path']: json.loads(l) for l in open(os.path.join(HERE, 'labels.jsonl'), encoding='utf-8') if l.strip()}

def our_enc(e):
    e = (e or '').lower()
    return {'windows-1252': 'western', 'latin1': 'western', 'iso-8859-15': 'western', 'ibm866': 'cp866',
            'windows-1251': 'cp1251', 'windows-1250': 'cp1250', 'euc-kr': 'euc-kr', 'shift_jis': 'shift_jis',
            'gbk': 'gbk', 'utf-8': 'utf-8', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be'}.get(e, e)

def py_enc(e):
    e = (e or '').lower().replace('_', '-')
    if e in ('ascii', 'utf-8', 'utf-8-sig'): return 'utf-8'
    if e in ('iso-8859-1', 'latin-1', 'cp1252', 'windows-1252', 'iso-8859-15'): return 'western'
    if e in ('utf-16', 'utf-16-le', 'utf-16le'): return 'utf-16le'
    if e in ('shift-jis', 'cp932', 'sjis'): return 'shift_jis'
    if e in ('gb2312', 'gbk', 'gb18030'): return 'gbk'
    if e in ('euc-kr', 'cp949'): return 'euc-kr'
    return {'cp866': 'cp866', 'ibm866': 'cp866', 'windows-1251': 'cp1251', 'cp1251': 'cp1251', 'windows-1250': 'cp1250', 'cp1250': 'cp1250'}.get(e, e)

def norm_delim(d):
    if d in (None,): return None
    if d == 'whitespace' or d == ' ': return 'whitespace'
    return d

def load_ours(path):
    out = {}
    for l in open(path, encoding='utf-8'):
        r = json.loads(l); p = r.get('profile') or {}; parse = r['parse']
        delimiter = norm_delim(p.get('delimiter'))
        if p.get('columns') == 1: delimiter = ''
        out[r['path']] = dict(ok=parse.get('ok'), rows=parse.get('rows', 0), useful=parse.get('usefulNumeric', 0),
                              encoding=our_enc(p.get('encoding')), delimiter=delimiter,
                              decimal=p.get('decimal') or 'auto', data_start=p.get('dataStartIndex'),
                              time=parse.get('timeKind'), variables=parse.get('variables', 0))
    return out

def load_baselines(path):
    out = defaultdict(dict)
    for l in open(path, encoding='utf-8'):
        r = json.loads(l)
        out[r['tool']][r['path']] = dict(ok=r.get('ok'), rows=r.get('rows', 0), useful=r.get('usefulNumeric', 0),
                                         encoding=py_enc(r.get('encoding')) if r['tool'] == 'clevercsv' else ('utf-8' if r.get('ok') else None),
                                         delimiter=norm_delim(r.get('delimiter')), decimal='.', data_start=r.get('data_start'),
                                         variables=r.get('columns', 0))
    return out

def checks(label, r):
    c = {}
    c['encoding'] = r is not None and r.get('encoding') == label['encoding']
    c['delimiter'] = r is not None and r.get('delimiter') == label['delimiter']
    want = label['decimal']
    got = r.get('decimal') if r else None
    c['decimal'] = r is not None and (want == 'any' or got == want or (got == 'auto' and want == '.'))
    if label['structure'] == 'table':
        ds = r.get('data_start') if r else None
        c['data start'] = ds is not None and abs(ds - label['data_start']) <= 1
        rows_needed = 0.5 * (label.get('rows_approx') or 0)
        if label.get('values') == 'text':
            useful = bool(r and r.get('ok') and r.get('variables', 0) > 0)
        else:
            useful = bool(r and r.get('ok') and r.get('useful', 0) > 0)
        c['useful read'] = useful and (r.get('rows', 0) >= rows_needed)
        c['right first time'] = all(c[k] for k in ('encoding', 'delimiter', 'decimal', 'data start', 'useful read'))
    return c

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ours', default=os.path.join(HERE, 'results/ours.jsonl'))
    ap.add_argument('--baselines', default=os.path.join(HERE, 'results/baselines.jsonl'))
    ap.add_argument('--before', default=os.path.join(HERE, 'results/ours-before.jsonl'),
                    help='our reader before the changes measured here (main at 25b6229)')
    ap.add_argument('--list', help='list the files a tool gets wrong')
    args = ap.parse_args()
    tools = {'Time Series Explorer': load_ours(args.ours)}
    if os.path.exists(args.before):
        tools['Time Series Explorer (before)'] = load_ours(args.before)
    if os.path.exists(args.baselines):
        b = load_baselines(args.baselines)
        tools.update({'CleverCSV 0.8.5': b['clevercsv'], 'pandas (sep=None)': b['pandas-sniff'], 'pandas (defaults)': b['pandas']})
    present = [p for p in labels if p in tools['Time Series Explorer']]
    tables = [p for p in present if labels[p]['structure'] == 'table']
    metrics = ['encoding', 'delimiter', 'decimal', 'data start', 'useful read', 'right first time']
    print(f'{len(present)} files ({len(tables)} single tables)\n')
    print(f"{'reader':30}" + ''.join(f'{m:>18}' for m in metrics))
    for name, res in tools.items():
        cells = []
        for m in metrics:
            pool = tables if m in ('data start', 'useful read', 'right first time') else present
            if name.startswith('pandas') and m == 'encoding':
                ok = sum(1 for p in pool if res.get(p, {}).get('ok') and labels[p]['encoding'] == 'utf-8')
            else:
                ok = sum(1 for p in pool if checks(labels[p], res.get(p)).get(m))
            cells.append(f'{ok}/{len(pool)} {100*ok/len(pool):5.1f}%')
        print(f'{name:30}' + ''.join(f'{c:>18}' for c in cells))

    # Paired comparison on "right first time", McNemar's exact test: only the
    # files one reader gets right and the other wrong count.
    ours = tools['Time Series Explorer']
    print('\nright first time, paired with Time Series Explorer (McNemar exact, two-sided)')
    for name, res in tools.items():
        if name == 'Time Series Explorer': continue
        a = sum(1 for p in tables if checks(labels[p], ours.get(p))['right first time'] and not checks(labels[p], res.get(p))['right first time'])
        b = sum(1 for p in tables if not checks(labels[p], ours.get(p))['right first time'] and checks(labels[p], res.get(p))['right first time'])
        n = a + b
        pval = min(1.0, 2 * sum(comb(n, k) for k in range(0, min(a, b) + 1)) / 2 ** n) if n else 1.0
        print(f'  vs {name:30} ours only right {a:3}   {name.split(" (")[0]} only right {b:3}   p = {pval:.2g}')
    if args.list:
        res = tools[args.list]
        print(f'\n{args.list}: files not right first time')
        for p in tables:
            c = checks(labels[p], res.get(p))
            if not c['right first time']:
                print(' ', p, [k for k, v in c.items() if not v and k != 'right first time'])

if __name__ == '__main__':
    main()
