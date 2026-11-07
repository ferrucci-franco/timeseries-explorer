#!/usr/bin/env python3
"""The same files read by common alternatives, one JSON line per file and tool.

    pip install pandas clevercsv
    python3 bench/real-world/run-baselines.py > bench/real-world/results/baselines.jsonl

Tools:
  pandas            pandas.read_csv(path): what most Python users do first
  pandas-sniff      pandas.read_csv(path, sep=None, engine='python'): pandas'
                    own delimiter sniffing (csv.Sniffer)
  clevercsv         clevercsv.read_dataframe(path): encoding and dialect detected
                    by CleverCSV (van den Burg et al., 2019)

None of them skips a preamble: their first data row is the line after the
header they infer (line 1), or line 0 without one.
"""
import csv, json, os, sys, time, warnings
import pandas as pd
import clevercsv
from clevercsv.encoding import get_encoding

warnings.simplefilter('ignore')
HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, '../../test-files/csv-real-world')

def summarize(df):
    numeric = 0
    for col in df.columns:
        s = df[col]
        if s.dtype.kind in 'fiu':
            share = s.notna().mean() if len(s) else 0
        else:
            share = pd.to_numeric(s, errors='coerce').notna().mean() if len(s) else 0
        if share >= 0.5: numeric += 1
    return {'ok': True, 'rows': int(len(df)), 'columns': int(df.shape[1]), 'usefulNumeric': numeric}

def run(fn):
    t = time.time()
    try:
        out = fn()
    except Exception as err:
        out = {'ok': False, 'error': f'{type(err).__name__}: {str(err)[:160]}'}
    out['ms'] = round((time.time() - t) * 1000)
    return out

for line in open(os.path.join(CORPUS, 'manifest.jsonl'), encoding='utf-8'):
    if not line.strip(): continue
    path_rel = json.loads(line)['path']
    path = os.path.join(CORPUS, path_rel)
    if not os.path.exists(path): continue

    def pandas_default():
        r = summarize(pd.read_csv(path)); r.update(delimiter=',', data_start=1); return r
    def pandas_sniff():
        df = pd.read_csv(path, sep=None, engine='python')
        r = summarize(df); r.update(data_start=1)
        try:
            with open(path, encoding='utf-8', errors='replace', newline='') as f:
                r['delimiter'] = csv.Sniffer().sniff(f.read(65536)).delimiter
        except Exception:
            r['delimiter'] = None
        return r
    def clever():
        enc = get_encoding(path)
        dialect = clevercsv.detect_dialect(path, encoding=enc)
        df = clevercsv.read_dataframe(path, encoding=enc)
        r = summarize(df)
        r.update(encoding=enc, delimiter=dialect.delimiter if dialect else None, data_start=1)
        return r

    for tool, fn in (('pandas', pandas_default), ('pandas-sniff', pandas_sniff), ('clevercsv', clever)):
        print(json.dumps({'tool': tool, 'path': path_rel, **run(fn)}), flush=True)
