#!/usr/bin/env python3
"""Offline comparison of delimiter-choice rules, from search-features.mjs output.

    python3 bench/dialect/search-rules.py --features features_B.jsonl --fixtures features_fixtures.jsonl
"""
import json, os, sys
import argparse
ap = argparse.ArgumentParser(description='Compare delimiter-choice rules offline (search-experiment.md).')
ap.add_argument('--reference', default='bench/data/dialect/reference_github.jsonl')
ap.add_argument('--features', required=True, help='search-features.mjs output for one half')
ap.add_argument('--fixtures', required=True, help='search-features.mjs output for test-files')
args = ap.parse_args()
ref = {os.path.basename(json.loads(l)['filename']): json.loads(l) for l in open(args.reference)}
F = [json.loads(l) for l in open(args.features)]
FX = [json.loads(l) for l in open(args.fixtures)]
STD = [',', ';', '\t', '|', 'whitespace']
def base(c):
    std = [x for x in c if not x.get('extra')]
    table = None
    for x in std:
        if x['w'] > 1 and x['s'] is not None and (table is None or x['s'] > table['s']): table = x
    cons = max(std, key=lambda x: x['q']) if std else None
    if table is None: return cons
    return cons if cons['q'] > 1.25 * table['q'] else table
def with_extra(k):
    def r(c):
        b = base(c)
        ex = [x for x in c if x.get('extra') and x['w'] > 1]
        if not ex: return b
        e = max(ex, key=lambda x: x['q'])
        bq = b['q'] if b else 0
        return e if e['q'] > k * bq and (b is None or b['w'] <= 1 or (b.get('fitHead') or 0) < 0.9) else b
    return r
def with_val(r0, gap=0.2):
    def r(c):
        b = r0(c)
        if b is None or b.get('fitVal') is None: return b
        if b['fitVal'] >= (b.get('fitHead') or 1) - gap: return b
        alts = [x for x in c if x is not b and x['w'] > 1 and x.get('fitVal') is not None and x['fitVal'] >= 0.95 and (x.get('fitHead') or 0) >= 0.9]
        return max(alts, key=lambda x: x['q']) if alts else b
    return r
def dialect(x):
    if x is None or x['w'] <= 1: return {'delimiter': '', 'quotechar': x['quote'] if x else '', 'escapechar': x['esc'] if x else ''}
    return {'delimiter': ' ' if x['d'] == 'whitespace' else x['d'], 'quotechar': x['quote'], 'escapechar': x['esc']}
def evaluate(rule):
    ok = n = 0; changedFX = []
    for r in F:
        rf = ref.get(r['f'])
        if not rf or rf['status'] != 'OK': continue
        n += 1
        d = dialect(rule(r['cands']))
        # one-column rule as in run-ours: a delimiter that splits nothing
        ok += d == rf['dialect']
    for r in FX:
        a, b = base(r['cands']), rule(r['cands'])
        if (a and a['d']) != (b and b['d']): changedFX.append(r['f'])
    return ok, n, changedFX
def tab_pref(c):
    b = base(c)
    if b and b['d'] == 'whitespace':
        t = next((x for x in c if x['d'] == '\t'), None)
        if t and t['w'] > 1 and (t.get('fitHead') or 0) >= 0.95: return t
    return b
rules = {'current': base, 'tab over whitespace': tab_pref, **{f'extra k={k}': with_extra(k) for k in (1.0, 1.25, 1.5, 2.0)}, 'current+validation': with_val(base),
         'extra1.5+validation': with_val(with_extra(1.5))}
for name, rule in rules.items():
    ok, n, ch = evaluate(rule)
    print(f'{name:22} dialect {100*ok/n:6.2f}% ({ok}/{n})  fixtures changed: {len(ch)} {ch[:3]}')
# calibration of the margin for the current rule
rows = []
for r in F:
    rf = ref.get(r['f'])
    if not rf or rf['status'] != 'OK': continue
    c = [x for x in r['cands'] if not x.get('extra')]
    b = base(r['cands'])
    others = sorted((x['q'] for x in c if x is not b and x['w'] > 1), reverse=True)
    m = 1 - (others[0] / b['q']) if b and others and b['q'] > 0 else 1.0
    rows.append((m, dialect(b) == rf['dialect']))
rows.sort()
print('\nmargin calibration (current rule): threshold -> files flagged, errors caught / total errors')
tot_err = sum(1 for _, ok in rows if not ok)
for t in (0.02, 0.05, 0.1, 0.2, 0.3):
    flagged = [ok for m, ok in rows if m < t]
    print(f'  margin < {t:4}: flag {len(flagged):4} files ({100*len(flagged)/len(rows):4.1f}%), catch {sum(1 for ok in flagged if not ok)}/{tot_err} errors')

# Oracle: is the reference dialect among our candidates at all?
from collections import Counter
why = Counter(); ok_or = 0; n = 0
for r in F:
    rf = ref.get(r['f'])
    if not rf or rf['status'] != 'OK': continue
    n += 1
    cands = r['cands'] + [None]
    hit = any(dialect(x) == rf['dialect'] for x in cands)
    ok_or += hit
    if dialect(base(r['cands'])) != rf['dialect']:
        if hit: why['right candidate present, scored lower'] += 1
        else:
            rd = rf['dialect']
            if rd['escapechar']: why['escape the reader cannot express'] += 1
            elif rd['quotechar'] not in ('', '"', "'"): why['quote char not supported (`)'] += 1
            elif rd['delimiter'] not in (',', ';', '\t', '|', ' ', ''): why[f'delimiter not a candidate ({rd["delimiter"]!r})'] += 1
            else: why['quote/escape detection mismatch'] += 1
print(f'\noracle over our candidates (+ one column): {100*ok_or/n:.2f}%')
for k, v in why.most_common(): print(f'  {v:3}  {k}')
