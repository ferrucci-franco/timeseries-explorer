#!/usr/bin/env python3
"""CleverCSV's detected dialect for every benchmark file, as JSON lines.

    pip install clevercsv
    python3 bench/dialect/run-clevercsv.py bench/data/dialect/github > out_clevercsv_github.jsonl

Uses the library's default detector (method 'auto': normal form, then data
consistency) on the whole file, with a per-file timeout.
"""
import json, os, sys, time
from concurrent.futures import ProcessPoolExecutor, TimeoutError as Timeout

import clevercsv

TIMEOUT = int(os.environ.get('CLEVERCSV_TIMEOUT', '120'))

def detect(path):
    started = time.time()
    try:
        d = clevercsv.detect_dialect(path)
    except Exception as err:
        return {'status': 'FAIL', 'status_msg': str(err)[:120], 'runtime': time.time() - started}
    if d is None:
        return {'status': 'FAIL', 'status_msg': 'no result', 'runtime': time.time() - started}
    return {'status': 'OK', 'runtime': time.time() - started,
            'dialect': {'delimiter': d.delimiter, 'quotechar': d.quotechar, 'escapechar': d.escapechar}}

def main():
    folder = sys.argv[1]
    name = os.path.basename(os.path.normpath(folder))
    files = sorted(f for f in os.listdir(folder) if f.endswith('.csv'))
    with ProcessPoolExecutor(os.cpu_count()) as pool:
        futures = [(f, pool.submit(detect, os.path.join(folder, f))) for f in files]
        for f, future in futures:
            try:
                record = future.result(timeout=TIMEOUT)
            except Timeout:
                record = {'status': 'FAIL', 'status_msg': 'timeout', 'runtime': TIMEOUT}
            print(json.dumps({'detector': 'clevercsv', 'filename': f'./data/{name}/{f}', **record}), flush=True)

if __name__ == '__main__':
    main()
