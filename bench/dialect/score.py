#!/usr/bin/env python3
"""Dialect-detection accuracy against the human/normal-form reference of
van den Burg et al. (2019), computed as in their constant_accuracy_overall.py:
a file counts when the reference status is OK, and it is correct when the
detector's status is OK and delimiter, quotechar and escapechar all match.

    python3 bench/dialect/score.py --data bench/data/dialect --set github \
        out_ours_github.jsonl out_clevercsv_github.jsonl [--published]

--published adds the detectors whose results the authors published (Python's
csv.Sniffer, HypoParsr, and CleverCSV as in the paper), restricted to the same
files, so every column is measured on exactly the same set.
"""
import argparse, json, os, sys

PUBLISHED = {
    'sniffer': 'Python csv.Sniffer (published)',
    'hypoparsr': 'HypoParsr (published)',
    'our_score_full': 'CleverCSV, paper (published)',
}

def load(path):
    out = {}
    for line in open(path, encoding='utf-8'):
        if line.strip():
            r = json.loads(line)
            out[os.path.basename(r['filename'])] = r
    return out

def is_standard(d):
    return d['delimiter'] == ',' and d['quotechar'] in ('', '"') and d['escapechar'] == ''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='bench/data/dialect')
    ap.add_argument('--set', default='github')
    ap.add_argument('--published', action='store_true')
    ap.add_argument('--failures', type=int, default=0, help='list this many files a detector gets wrong')
    ap.add_argument('results', nargs='+')
    args = ap.parse_args()
    present = set(f for f in os.listdir(os.path.join(args.data, args.set)) if f.endswith('.csv'))
    reference = {k: v for k, v in load(os.path.join(args.data, f'reference_{args.set}.jsonl')).items()
                 if v['status'] == 'OK' and k in present}
    detectors = {}
    for path in args.results:
        recs = load(path)
        detectors[next(iter(recs.values()))['detector']] = recs
    if args.published:
        base = os.path.join(args.data, 'CSV_Wrangling/results/test/detection')
        for key, label in PUBLISHED.items():
            detectors[label] = load(os.path.join(base, f'out_{key}_{args.set}.json'))

    standard = {k for k, v in reference.items() if is_standard(v['dialect'])}
    rows = []
    for name, recs in detectors.items():
        stats = {'delimiter': 0, 'quotechar': 0, 'escapechar': 0, 'overall': 0, 'standard': 0, 'messy': 0, 'fail': 0}
        wrong = []
        for key, ref in reference.items():
            det = recs.get(key)
            if not det or det['status'] != 'OK':
                stats['fail'] += 1
                wrong.append((key, ref['dialect'], None))
                continue
            ok = True
            for prop in ('delimiter', 'quotechar', 'escapechar'):
                hit = det['dialect'][prop] == ref['dialect'][prop]
                stats[prop] += hit
                ok &= hit
            stats['overall'] += ok
            stats['standard' if key in standard else 'messy'] += ok
            if not ok:
                wrong.append((key, ref['dialect'], det['dialect']))
        rows.append((name, stats, wrong))

    n, ns = len(reference), len(standard)
    nm = n - ns
    print(f"{args.set}: {n} annotated files available ({ns} standard, {nm} messy)\n")
    print(f"{'detector':34} {'delim':>7} {'quote':>7} {'escape':>7} {'overall':>8} {'standard':>9} {'messy':>7} {'fail':>5}")
    pct = lambda a, b: f"{100 * a / b:6.2f}" if b else '   -  '
    for name, s, _ in rows:
        print(f"{name:34} {pct(s['delimiter'], n):>7} {pct(s['quotechar'], n):>7} {pct(s['escapechar'], n):>7} "
              f"{pct(s['overall'], n):>8} {pct(s['standard'], ns):>9} {pct(s['messy'], nm):>7} {s['fail']:>5}")
    if args.failures:
        for name, _, wrong in rows:
            print(f"\n{name}: first {args.failures} of {len(wrong)} wrong")
            for key, ref, det in wrong[:args.failures]:
                print(f"  {key}  reference={ref}  detected={det}")

if __name__ == '__main__':
    sys.exit(main())
