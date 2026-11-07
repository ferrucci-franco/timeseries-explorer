#!/usr/bin/env python3
"""Fetch the CSV dialect benchmark of van den Burg, Nazabal and Sutton (2019).

The files are not ours to redistribute, so they are downloaded from the URLs
the authors published, and kept only when their MD5 matches the one they
annotated. The reference dialects come from the same repository.

    python3 bench/dialect/download.py [--set github|ukdata] [--out bench/data/dialect]
"""
import argparse, hashlib, json, os, shutil, ssl, subprocess, sys, urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

REPO = 'https://github.com/alan-turing-institute/CSV_Wrangling.git'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='github', choices=['github', 'ukdata'])
    ap.add_argument('--out', default='bench/data/dialect')
    ap.add_argument('--workers', type=int, default=32)
    args = ap.parse_args()
    repo = os.path.join(args.out, 'CSV_Wrangling')
    if not os.path.isdir(repo):
        os.makedirs(args.out, exist_ok=True)
        subprocess.run(['git', 'clone', '--depth', '1', REPO, repo], check=True)
    files = os.path.join(args.out, args.set)
    os.makedirs(files, exist_ok=True)
    shutil.copy(os.path.join(repo, 'results/test/detection', f'out_reference_{args.set}.json'),
                os.path.join(args.out, f'reference_{args.set}.jsonl'))
    cafile = os.environ.get('SSL_CERT_FILE') or ('/root/.ccr/ca-bundle.crt' if os.path.exists('/root/.ccr/ca-bundle.crt') else None)
    ctx = ssl.create_default_context(cafile=cafile)
    rows = [json.loads(line) for line in open(os.path.join(repo, f'urls_{args.set}.json')) if line.strip()]

    def fetch(row):
        target = os.path.join(files, row['md5'] + '.csv')
        if os.path.exists(target):
            return 'present'
        for url in row['urls']:
            try:
                data = urllib.request.urlopen(url, timeout=30, context=ctx).read()
            except Exception:
                continue
            if hashlib.md5(data).hexdigest() != row['md5']:
                return 'changed'
            with open(target, 'wb') as f:
                f.write(data)
            return 'downloaded'
        return 'unavailable'

    with ThreadPoolExecutor(args.workers) as pool:
        counts = Counter(pool.map(fetch, rows))
    print(json.dumps({'set': args.set, 'listed': len(rows), **counts}))

if __name__ == '__main__':
    sys.exit(main())
