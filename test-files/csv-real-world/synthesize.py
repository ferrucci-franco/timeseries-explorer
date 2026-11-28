#!/usr/bin/env python3
"""Write the synthetic files of the corpus: files "in the format of" an original.

    python3 test-files/csv-real-world/synthesize.py --src DIR    read the originals from DIR
                                                                 (same relative paths), write
                                                                 the synthetic files here
    python3 test-files/csv-real-world/synthesize.py --src DIR PATH ...   only these paths

A corpus file from a repository without a licence that allows redistribution is not kept
as a copy. What is kept is its format, in a file this script writes from it.

Kept is everything the instrument or its software decided: encoding, BOM, line endings,
delimiter, padding, quoting, the number of lines and of fields, the size, the shape of
every number (sign, digit count, decimal mark, exponent), the preamble and header lines,
column names and units, missing-value markers, status codes, and the time and index
columns.

Replaced is everything the measurement decided: the digits of every measured value (each
column becomes a seeded smooth signal, written into the number shape of the cell it
replaces, between the 1st and 99th percentile of the values of that shape in the column),
and, through the per-file rules in synthesize-rules.json, whatever names a person, an
organisation, a site, a device unit or a computer.

The input must be the original: its sha256 is checked against the manifest
(format_source_sha256), and a file that is already synthetic is left alone. The output
depends on the input, its corpus path and the rules, and on nothing else: the random
generator is seeded from the path and the column, and floats only meet + - * /, so the
same original gives the same bytes on any machine. Python 3.8+, standard library only.
"""
import hashlib
import json
import os
import random
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# Manifest "encoding" -> Python codec.
CODECS = {
    'ascii': 'ascii', 'utf-8': 'utf-8', 'latin-1': 'latin-1', 'utf-16le': 'utf-16-le',
    'shift_jis (cp932)': 'cp932', 'cp932 (Shift-JIS)': 'cp932', 'latin-1/cp1252': 'cp1252',
    'cp866': 'cp866', 'cp1251': 'cp1251', 'cp1250': 'cp1250', 'gbk': 'gbk',
    'cp949 (EUC-KR superset)': 'cp949', 'utf-8 (with U+FFFD in unit line)': 'utf-8',
}

LINE_END = re.compile(r'(\r\r\n|\r\n|\n|\r)')


def seeded(*parts):
    digest = hashlib.sha256('|'.join(str(p) for p in parts).encode('utf-8')).hexdigest()
    return random.Random(int(digest[:16], 16))


# ---------------------------------------------------------------- field splitting

def split_delim(line, delim, quote='"'):
    """Field spans of a delimited line; a quoted field may hold the delimiter."""
    spans = []
    i, n, start = 0, len(line), 0
    while True:
        j = i
        while j < n and line[j] in ' \t' and line[j] != delim:
            j += 1
        if quote and j < n and line[j] == quote:
            j += 1
            while j < n:
                if line[j] == quote:
                    if j + 1 < n and line[j + 1] == quote:
                        j += 2
                        continue
                    break
                j += 1
            j += 1
        while j < n and line[j] != delim:
            j += 1
        spans.append((start, min(j, n)))
        if j >= n:
            break
        i = start = j + 1
    return spans


def split_ws(line, maxfields=None):
    spans = [m.span() for m in re.finditer(r'\S+', line)]
    if maxfields and len(spans) > maxfields:
        spans = spans[:maxfields - 1] + [(spans[maxfields - 1][0], spans[-1][1])]
    return spans


def core_span(line, a, b):
    """The span of a field without its padding and its surrounding quotes."""
    while a < b and line[a] in ' \t':
        a += 1
    while b > a and line[b - 1] in ' \t':
        b -= 1
    if b - a >= 2 and line[a] == '"' and line[b - 1] == '"':
        a += 1
        b -= 1
        while a < b and line[a] in ' \t':
            a += 1
        while b > a and line[b - 1] in ' \t':
            b -= 1
    return a, b


# ---------------------------------------------------------------- number shapes

class Num:
    """A number as text: where its mantissa digits are, and what they are worth."""
    __slots__ = ('text', 'positions', 'n_int', 'n_frac', 'negative', 'exp', 'value', 'lead_zero')

    def cls(self):
        return (self.negative, self.n_int, self.exp)


def number_pattern(dec):
    d = re.escape(dec)
    return re.compile(r'^([+-]?)(\d*)(?:' + d + r'(\d*))?([eE][+-]?\d+)?$')


def parse_number(text, pattern, dec, digits_mode=False):
    num = Num()
    num.text = text
    if digits_mode:
        # A number whose punctuation does not parse ("71.087.22"): all digits count.
        if not re.match(r'^[+-]?[\d.,\' ]*\d[\d.,\' ]*$', text):
            return None
        num.positions = [i for i, c in enumerate(text) if c.isdigit()]
        num.n_int, num.n_frac, num.exp = len(num.positions), 0, None
        num.negative = text.startswith('-')
    else:
        m = pattern.match(text)
        if not m or not (m.group(2) or m.group(3)):
            return None
        if any(not ('0' <= c <= '9') for c in (m.group(2) or '') + (m.group(3) or '')):
            return None
        num.n_int = len(m.group(2))
        num.n_frac = len(m.group(3) or '')
        num.exp = m.group(4)
        num.negative = m.group(1) == '-'
        end = m.start(4) if m.group(4) else len(text)
        num.positions = [i for i in range(len(m.group(1)), end) if text[i].isdigit()]
    digits = ''.join(text[i] for i in num.positions)
    num.value = int(digits) / (10 ** num.n_frac)
    num.lead_zero = num.n_int > 1 and digits[0] == '0'
    return num


def write_number(num, magnitude):
    """`num.text` with its mantissa digits replaced by those of `magnitude`."""
    total = num.n_int + num.n_frac
    scaled = int(magnitude * (10 ** num.n_frac) + 0.5)
    top = 10 ** total - 1
    low = 0 if (num.n_int <= 1 or num.lead_zero) else 10 ** (total - 1)
    scaled = max(low, min(top, scaled))
    digits = str(scaled).rjust(total, '0')
    out = list(num.text)
    for pos, digit in zip(num.positions, digits):
        out[pos] = digit
    return ''.join(out)


# ---------------------------------------------------------------- synthetic signal

def smooth_signal(n, rng):
    """n values in [0, 1]: random knots joined by smoothstep, plus a little noise."""
    if n <= 0:
        return []
    knots = max(3, min(48, n // 24 + 3))
    level = [rng.random() for _ in range(knots + 1)]
    lo, hi = min(level), max(level)
    span = (hi - lo) or 1.0
    level = [(v - lo) / span for v in level]
    out = []
    for i in range(n):
        x = (i / (n - 1) if n > 1 else rng.random()) * (knots - 1)
        k = min(int(x), knots - 1)
        t = x - k
        t = t * t * (3 - 2 * t)
        v = level[k] * (1 - t) + level[k + 1] * t
        v = 0.03 + 0.94 * v + 0.03 * (2 * rng.random() - 1)
        out.append(min(1.0, max(0.0, v)))
    return out


def synthesize_series(cells, rng, zero_span=False):
    """cells: list of Num in row order. Returns the new texts.

    Cells are grouped by shape (sign, digits before the decimal mark, exponent). One
    smooth signal runs through the whole series; each cell takes the value the signal
    gives inside the range its own shape has in this series.
    """
    signal = smooth_signal(len(cells), rng)
    values = {}
    for num in cells:
        values.setdefault(num.cls(), []).append(num.value)
    ranges = {}
    for key, found in values.items():
        found.sort()
        # The 1st to 99th percentile, so that one outlier does not set the scale.
        cut = len(found) // 100
        lo, hi = found[cut], found[len(found) - 1 - cut]
        n_int = key[1]
        if lo == hi and lo != 0:
            # One value only in this shape: move it down by up to a fifth (up, if the
            # shape has no room below).
            floor = 10 ** (n_int - 1) if n_int > 1 else 0
            lo = max(floor, hi * 0.8)
            if lo == hi:
                hi = min(10 ** max(n_int, 1), lo * 1.2)
        elif lo == hi and (zero_span or len(values) > 1):
            # Zeros only in this shape, in a column that also holds other values (or that the
            # rules ask to replace anyway): any value the shape can write.
            hi = 10 ** max(n_int, 1)
        ranges[key] = (lo, hi)
    out = []
    for num, s in zip(cells, signal):
        lo, hi = ranges[num.cls()]
        value = lo + s * (hi - lo)
        text = write_number(num, value)
        if text == num.text and hi > lo:
            # A coarse column gives the original back by chance: take the neighbouring step.
            step = 1 / (10 ** num.n_frac)
            text = write_number(num, value + step if value + step <= hi else max(lo, value - step))
        out.append(text)
    return out


# ---------------------------------------------------------------- neutral text

def mask_text(text):
    """Same length and character classes, no content: letters -> x/X, digits -> 0."""
    out = []
    for c in text:
        if c.isdigit():
            out.append('0' if c.isascii() else chr(0xFF10))      # fullwidth zero
        elif not c.isalpha():
            out.append(c)
        elif c.isascii():
            out.append('X' if c.isupper() else 'x')
        elif 0x0400 <= ord(c) <= 0x04FF:
            out.append(chr(0x0425) if c.isupper() else chr(0x0445))    # Cyrillic ha
        elif ord(c) > 0x2E7F:
            out.append(chr(0x25CB))      # white circle: two bytes in every CJK code page
        else:
            out.append(chr(0xC9) if c.isupper() else chr(0xE9))  # e acute, in every Latin code page
    return ''.join(out)


def pick(items, rng):
    return items[int(rng.random() * len(items))]


def neutral_words(text, rng):
    """A made-up label with the shape of `text`: same words, lengths, case and punctuation."""
    out, in_word = [], 0
    for c in text:
        if c.isascii() and c.isalpha():
            letter = pick('BDFGKLMNPRSTVZ' if in_word % 2 == 0 else 'AEIOU', rng)
            out.append(letter if c.isupper() else letter.lower())
            in_word += 1
        elif c.isdigit() and c.isascii():
            out.append(pick('0123456789', rng))
            in_word += 1
        else:
            out.append(mask_text(c))
            in_word = in_word + 1 if c.isalpha() else 0
    return ''.join(out)


# ---------------------------------------------------------------- one file

class FileJob:
    def __init__(self, path, rules, codec, raw):
        self.path, self.rules, self.codec = path, rules, codec
        text = raw.decode(codec)
        if text.encode(codec) != raw:
            raise SystemExit(f'{path}: {codec} does not round-trip')
        self.bom = '\ufeff' if text.startswith('\ufeff') else ''
        parts = LINE_END.split(text[len(self.bom):])
        self.lines = parts[0::2]
        self.ends = parts[1::2]
        self.dec = rules.get('decimal', '.')
        self.pattern = number_pattern(self.dec)
        self.report = {}

    def text(self):
        out = [self.bom]
        for i, line in enumerate(self.lines):
            out.append(line)
            if i < len(self.ends):
                out.append(self.ends[i])
        return ''.join(out)

    # -- which lines hold data, and their fields
    def segments(self):
        n = len(self.lines)
        skip = re.compile(self.rules['skip']) if self.rules.get('skip') else None
        only = re.compile(self.rules['only']) if self.rules.get('only') else None
        for index, seg in enumerate(self.rules.get('data', [])):
            start, end = seg[0], seg[1] if len(seg) > 1 and seg[1] is not None else n
            if end < 0:
                end += n
            opts = seg[2] if len(seg) > 2 else {}
            rows = [i for i in range(start, min(end, n)) if self.lines[i].strip()]
            if not opts.get('each'):
                rows = [i for i in rows if not (skip and skip.search(self.lines[i]))
                        and not (only and not only.search(self.lines[i]))]
            yield index, rows, opts

    def spans(self, line):
        split = self.rules.get('split', {'delim': ','})
        if 'regex' in split:
            m = re.match(split['regex'], line)
            if not m:
                return []
            return [m.span(g) for g in range(1, (m.lastindex or 0) + 1) if m.group(g) is not None]
        if split.get('ws'):
            return split_ws(line, split.get('max'))
        return split_delim(line, split['delim'], split.get('quote', '"'))

    def data_lines(self):
        seen = set()
        for _, rows, _ in self.segments():
            seen.update(rows)
        return seen

    # -- step 1: identifying text in the lines around the data
    def scrub(self):
        data = self.data_lines()
        for rule in self.rules.get('scrub', []):
            find, repl = rule[0], rule[1]
            scope = rule[2] if len(rule) > 2 else 'meta'
            if repl is None:
                repl = mask_text(find)
            pad = re.search(r'\{pad:(.)\}', repl)
            if pad:
                room = len(find.encode(self.codec)) - len(repl.replace(pad.group(0), '').encode(self.codec))
                repl = repl.replace(pad.group(0), pad.group(1) * room)
            if len(repl.encode(self.codec)) != len(find.encode(self.codec)):
                raise SystemExit(f'{self.path}: scrub {find!r} -> {repl!r} changes the length')
            hits = 0
            for i, line in enumerate(self.lines):
                if scope == 'meta' and i in data:
                    continue
                if find in line:
                    hits += line.count(find)
                    self.lines[i] = line.replace(find, repl)
            if not hits:
                raise SystemExit(f'{self.path}: scrub rule {find!r} matched nothing')
        for rule in self.rules.get('scrub_regex', []):
            pattern = re.compile(rule[0])
            hits = 0
            for i, line in enumerate(self.lines):
                if i in data and (len(rule) < 3 or rule[2] != 'all'):
                    continue
                new, count = pattern.subn(
                    lambda m: rule[1] if rule[1] is not None and len(rule[1]) == len(m.group(0))
                    else mask_text(m.group(0)), line)
                hits += count
                self.lines[i] = new
            if not hits:
                raise SystemExit(f'{self.path}: scrub_regex {rule[0]!r} matched nothing')

    # -- step 2: the data cells
    def series_key(self, seg, col, cores):
        group = self.rules.get('group_by')
        if group is None:
            return (seg, col)
        return (seg, col, cores[group] if group < len(cores) else '')

    def synthesize(self):
        rules = self.rules
        keep = set(rules.get('keep', []))
        force = set(rules.get('force', []))
        digits_cols = set(rules.get('digits', []))
        sentinels = set(rules.get('sentinels', []))
        text_cols = set(rules.get('text', []))
        keep_rows = set(rules.get('keep_rows', []))
        replace_cols = {int(k): v for k, v in rules.get('replace_cols', {}).items()}
        prefix = {int(k): v for k, v in rules.get('prefix_digits', {}).items()}
        shuffle = rules.get('shuffle', [])
        edits = {}            # line -> list of (a, b, new text)
        series = {}           # key -> list of (line, a, b, Num)
        labels = {}           # col -> {old: new}
        shuffled = []         # (line, [(a, b, text) for the shuffled columns])
        for seg, rows, opts in self.segments():
            seg_keep = set(opts.get('keep', [])) if opts.get('each') else keep
            for i in rows:
                if i in keep_rows:
                    continue
                line = self.lines[i]
                spans = [core_span(line, a, b) for a, b in self.spans(line)]
                cores = [line[a:b] for a, b in spans]
                if shuffle and not opts.get('each'):
                    shuffled.append((i, [spans[c] + (cores[c],) for c in shuffle if c < len(cores)]))
                for col, ((a, b), core) in enumerate(zip(spans, cores)):
                    if not core or col in shuffle or ('cols' in opts and col not in opts['cols']):
                        continue
                    if col in replace_cols and not opts.get('each'):
                        if core in replace_cols[col]:
                            edits.setdefault(i, []).append((a, b, replace_cols[col][core]))
                        continue
                    if col in text_cols and not opts.get('each'):
                        if core not in labels.setdefault(col, {}):
                            attempt = 0
                            while True:
                                label = neutral_words(core, seeded(self.path, 'text', col, core, attempt))
                                if label not in labels[col].values():
                                    break
                                attempt += 1
                            labels[col][core] = label
                        edits.setdefault(i, []).append((a, b, labels[col][core]))
                        continue
                    if col in seg_keep or core in sentinels:
                        continue
                    num = parse_number(core, self.pattern, self.dec, col in digits_cols)
                    if num is None:
                        continue
                    key = ('each', i, col) if opts.get('each') else self.series_key(seg, col, cores)
                    series.setdefault(key, []).append((i, a, b, num))
        done = {}             # the original texts of a series -> its new texts
        kept_auto = []
        for key in sorted(series, key=repr):
            cells = series[key]
            nums = [c[3] for c in cells]
            col = key[2] if key[0] == 'each' else key[1]
            if key[0] != 'each' and col not in force:
                distinct = {n.text for n in nums}
                integers = all(n.n_frac == 0 and n.exp is None and self.dec not in n.text for n in nums)
                if len(distinct) == 1 or (integers and len(distinct) <= 3 and len(nums) >= 4 * len(distinct)):
                    kept_auto.append(key)
                    continue
            same = tuple(n.text for n in nums)
            if same not in done or key[0] == 'each':
                # Two columns that were equal in the original stay equal.
                done[same] = synthesize_series(nums, seeded(self.path, repr(key)),
                                               zero_span=col in force)
            for (i, a, b, num), text in zip(cells, done[same]):
                if col in prefix and key[0] != 'each':
                    chars = list(text)
                    for pos, digit in zip(num.positions, prefix[col]):
                        chars[pos] = digit
                    text = ''.join(chars)
                edits.setdefault(i, []).append((a, b, text))
        if shuffled:
            rng = seeded(self.path, 'shuffle')
            keys = [rng.random() for _ in shuffled]
            order = sorted(range(len(shuffled)), key=lambda k: keys[k])
            for (i, cells), source in zip(shuffled, order):
                for (a, b, _), (_, _, text) in zip(cells, shuffled[source][1]):
                    edits.setdefault(i, []).append((a, b, text))
        for i, items in edits.items():
            line = self.lines[i]
            for a, b, text in sorted(items, reverse=True):
                if not shuffle and len(text.encode(self.codec)) != len(line[a:b].encode(self.codec)):
                    raise SystemExit(f'{self.path}: line {i} cell length changes: {line[a:b]!r} -> {text!r}')
                line = line[:a] + text + line[b:]
            self.lines[i] = line
        self.report['kept_auto'] = kept_auto


# ---------------------------------------------------------------- formats that need more

def garmin_fit(job):
    """FitCSVTool: rows are (field, value, units) triplets; the series is the field."""
    stay = set(job.rules.get('fit_keep', []))
    zero = set(job.rules.get('fit_zero', []))
    prefix = job.rules.get('fit_prefix', {})
    series, edits = {}, {}
    for i, line in enumerate(job.lines):
        if not line.startswith('Data,'):
            continue
        spans = [core_span(line, a, b) for a, b in split_delim(line, ',')]
        cores = [line[a:b] for a, b in spans]
        message = cores[2]
        for c in range(3, len(cores) - 1, 3):
            field, (a, b), value = cores[c], spans[c + 1], cores[c + 1]
            if not field or not value or field in stay or f'{field}@{c}' in stay:
                continue
            if field in zero:
                edits.setdefault(i, []).append((a, b, mask_text(value)))
                continue
            offset = a
            for k, part in enumerate(value.split('|')):       # a value can be a list
                num = parse_number(part, job.pattern, job.dec)
                if num is not None:
                    series.setdefault((message, field, c, k), []).append((i, offset, offset + len(part), num))
                offset += len(part) + 1
    for key in sorted(series):
        cells = series[key]
        nums = [c[3] for c in cells]
        distinct = {n.text for n in nums}
        if len(nums) > 1 and (len(distinct) == 1 or (len(distinct) <= 3 and len(nums) >= 4 * len(distinct)
                                                     and all(n.n_frac == 0 for n in nums))):
            continue
        new = synthesize_series(nums, seeded(job.path, repr(key)))
        for (i, a, b, num), text in zip(cells, new):
            if key[1] in prefix:
                chars = list(text)
                for pos, digit in zip(num.positions, prefix[key[1]]):
                    chars[pos] = digit
                text = ''.join(chars)
            edits.setdefault(i, []).append((a, b, text))
    for i, items in edits.items():
        line = job.lines[i]
        for a, b, text in sorted(items, reverse=True):
            if len(text) != b - a:
                raise SystemExit(f'{job.path}: line {i} cell length changes')
            line = line[:a] + text + line[b:]
        job.lines[i] = line


def sel_checksums(lines):
    """SEL Compressed ASCII: each record ends with the 16-bit sum of its bytes, in hex.

    A record is a line, or a quoted field that runs over several lines (the settings
    dump), whose line ends count as CR LF. Returns {line index: checksum text}.
    """
    sums, start = {}, 0
    for i, line in enumerate(lines):
        record = '\r\n'.join(lines[start:i + 1])
        m = re.search(r'"([0-9A-F]{4})"$', record)
        if not m or record[:m.start()].count('"') % 2:
            continue                                          # inside a quoted field
        sums[i] = '%04X' % (sum(record[:m.start()].encode('ascii')) & 0xFFFF)
        start = i + 1
    return sums


def sel_cev_checksums(job, original_lines):
    for i, value in sel_checksums(original_lines).items():
        if not original_lines[i].endswith(f'"{value}"'):
            raise SystemExit(f'{job.path}: line {i}: the checksum rule does not hold for the original')
    for i, value in sel_checksums(job.lines).items():
        job.lines[i] = job.lines[i][:-6] + f'"{value}"'


def transform(path, rules, codec, raw):
    job = FileJob(path, rules, codec, raw)
    original_lines = list(job.lines)
    job.scrub()
    job.synthesize()
    if 'garmin_fit' in rules.get('special', []):
        garmin_fit(job)
    if 'sel_cev_checksums' in rules.get('special', []):
        sel_cev_checksums(job, original_lines)
    out = job.text().encode(codec)
    if len(out) != len(raw):
        raise SystemExit(f'{path}: size changed {len(raw)} -> {len(out)}')
    return out, job


def main(argv):
    src = ROOT
    if '--src' in argv:
        src = argv[argv.index('--src') + 1]
        argv = [a for k, a in enumerate(argv) if a != '--src' and argv[k - 1] != '--src']
    with open(os.path.join(ROOT, 'synthesize-rules.json'), encoding='utf-8') as handle:
        rules = json.load(handle)['files']
    manifest = {}
    with open(os.path.join(ROOT, 'manifest.jsonl'), encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                entry = json.loads(line)
                manifest[entry['path']] = entry
    for path in argv[1:] or sorted(rules):
        entry = manifest[path]
        with open(os.path.join(src, path), 'rb') as handle:
            raw = handle.read()
        found = hashlib.sha256(raw).hexdigest()
        if entry.get('synthetic') and found == entry['sha256']:
            print(f'already synthetic, left as it is: {path}')
            continue
        original = entry.get('format_source_sha256', entry['sha256'])
        if found != original:
            raise SystemExit(f'{path}: not the original file (sha256 {found}, expected {original})')
        out, _ = transform(path, rules[path], CODECS[entry['encoding']], raw)
        with open(os.path.join(ROOT, path), 'wb') as handle:
            handle.write(out)
        print(f'{hashlib.sha256(out).hexdigest()}  {path}')


if __name__ == '__main__':
    main(sys.argv)
