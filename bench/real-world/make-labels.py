#!/usr/bin/env python3
"""Build labels.jsonl: the expected reading of every file in test-files/csv-real-world.

Defaults come from the corpus manifest (encoding, delimiter, decimal separator,
preamble length), normalized. Files whose manifest entry did not match what a
person reads in the file were checked by hand, line by line, and carry
"reviewed": true and a note. Line numbers are 0-based.

"structure" says what kind of file it is. Only "table" files are scored on where
the data starts: the others (several record types in one file, several tables,
reports, configuration files, INI-style sections) have no single answer, and are
reported apart.

Labels were fixed before the reader was changed to handle these files. Three
were corrected afterwards, each for a stated reason: see CORRECTED below and
README.md.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, '../../test-files/csv-real-world')

def enc_family(e):
    e = (e or '').lower()
    if e.startswith('ascii') or e.startswith('utf-8'): return 'utf-8'
    if 'latin' in e or '1252' in e or '8859' in e: return 'western'
    if 'utf-16le' in e: return 'utf-16le'
    if 'utf-16be' in e: return 'utf-16be'
    if 'shift' in e or '932' in e: return 'shift_jis'
    if '866' in e: return 'cp866'
    if '1251' in e: return 'cp1251'
    if '1250' in e: return 'cp1250'
    if 'gbk' in e or '936' in e: return 'gbk'
    if '949' in e or 'euc-kr' in e: return 'euc-kr'
    return e

def delim(d):
    d = (d or '').lower()
    if d.startswith('none'): return ''
    if d.startswith('\\t') or d == '\t': return '\t'
    if d.startswith(';'): return ';'
    if d.startswith(','): return ','
    if d.startswith('|'): return '|'
    if 'space' in d or 'white' in d or 'fixed' in d: return 'whitespace'
    return d

def dec(d):
    d = d or ''
    return 'any' if d.startswith('n/a') else d[:1]

R = {
 'lab-instruments/rohde-schwarz_fsh8_semicolon_decimalcomma_sweep.csv': dict(header=47, data_start=48, note='names "Freq. [Hz];Magnitude [dBm]" on line 47 after a 46-line key;value preamble and a blank line'),
 'lab-instruments/tektronix_excel_resaved_de_trailing_semicolons_ch1.CSV': dict(header=None, data_start=0, note='samples in columns 3-4 from the first line; columns 1-2 hold the settings beside them'),
 'lab-instruments/yokogawa_dl850ev_padded_quoted_header_leading_empty_col.csv': dict(header=None, data_start=16, note='15-line quoted key/value header, a blank line, then one value per row between empty cells'),
 'industrial-energy/aemo-nem12_interval-meter_au_mixed-record-types.csv': dict(structure='multi-record', note='NEM12: 200/300/400/900 record types; the data are the 300 rows'),
 'industrial-energy/beckhoff-twincat-scope_nl_paired-time.csv': dict(data_start=24, note='channel properties up to line 22 (the last ones numeric), a blank line, data from 24'),
 'industrial-energy/beckhoff-twincat-xy-scope_de_semicolon.csv': dict(data_start=13, note='"Port;851;..." on line 11 is a property row; data after the blank line 12'),
 'industrial-energy/comtrade_ru-recorder-r001_cp866.cfg': dict(structure='config', note='COMTRADE configuration (channel list), not a data table'),
 'industrial-energy/comtrade_ru-recorder-r002_cp1251.cfg': dict(structure='config', note='COMTRADE configuration (channel list), not a data table'),
 'industrial-energy/machine-axis-logger_de_quoted-decimal-comma.csv': dict(header=0, data_start=1, decimal=',', note='decimal commas inside quotes in a comma-delimited file'),
 'industrial-energy/niagara-ax_history-export_boolean-state_quoted-flags.csv': dict(header=2, data_start=3, values='text', note='ON/OFF states; time "31-Jan-25 2:09:00 PM WEST"'),
 'industrial-energy/siemens-wincc_datalog_vi_temperature.csv': dict(header=0, data_start=1, decimal=',', note='decimal commas NOT quoted in a comma-delimited file: rows have 7 cells for 5 names'),
 'industrial-energy/sma-sunnybeam_etotal_de_sep-line.csv': dict(header=8, data_start=9, decimal=',', note='rows with a time and no value (before sunrise) are data rows'),
 'field-environment/campbell_cr1000_toa5_status-table_gcnet-cp1_2011.dat': dict(header=1, data_start=4, note='TOA5: names, units and process rows, then a single record'),
 'field-environment/davis_weatherlink_fixed-width_dashed-rule_2row-header.txt': dict(header=1, data_start=3, note='two header rows, a dashed rule, "---" for missing values'),
 'field-environment/eccc_climate-hourly_quebec_fr_quoted-decimal-comma_bom.csv': dict(header=0, data_start=1, decimal=',', note='decimal commas inside quotes in a comma-delimited file'),
 'field-environment/hobo_ux120_4ch-temp_molonari_fr-localized_enregistre-events.csv': dict(header=1, data_start=2, note='measurement rows interleaved with "Enregistré" event rows'),
 'field-environment/smhi_opendata_goteborg_sv_multi-block-metadata_sidecar-notes-column.csv': dict(header=14, data_start=15, note='three metadata blocks, then the data table with notes in a side column'),
 'mech-chem-bio/agilent-chemstation_report00_backslash-before-quote.csv': dict(structure='report', note='key/value report sections'),
 'mech-chem-bio/agilent-chemstation_area-percent-report_utf16le-bom_fixed-width.TXT': dict(structure='report', note='printed area-percent report'),
 'mech-chem-bio/ardupilot_dataflash_textlog_tradheli_heterogeneous-rows.log': dict(structure='multi-record', note='one message type per row (FMT, PARM, GPS, ...)'),
 'mech-chem-bio/empatica_e4_temp_epoch-then-rate-headerless.csv': dict(header=None, data_start=2, delimiter='', note='line 0 is the start time, line 1 the sample rate, then one value per row'),
 'mech-chem-bio/ezchrom_elite_gc_one-value-per-line.dat.asc': dict(header=None, data_start=13, note='13 key:value lines, then one value per row'),
 'mech-chem-bio/gamry_eis_18650_multitable_overload-dots.DTA': dict(structure='multi-table', note='OCVCURVE and ZCURVE tables'),
 'mech-chem-bio/garmin_fitcsvtool_activity_ragged.csv': dict(structure='multi-record', note='FIT messages: field/value/unit triplets per row'),
 'mech-chem-bio/motec_fsg2016_autox_gps_de-decimal.csv': dict(header=13, data_start=17, decimal=',', note='names on 13, units on 14, two blank lines, quoted decimal commas'),
 'mech-chem-bio/nmea0183_gps_track_hamburg_mixed-sentences.txt': dict(structure='multi-record', note='NMEA sentences of several types'),
 'mech-chem-bio/mettler-stare_dsc_fixed-width_decimal-comma_latin1.txt': dict(header=9, data_start=11, delimiter='whitespace', decimal=',', note='right-aligned columns; decimal commas'),
 'mech-chem-bio/ta-instruments_dma-q800_universal-analysis_utf16le_tab.txt': dict(header=None, data_start=64, note='"StartOfData" on line 63; names are in the Sig lines of the header'),
 'mech-chem-bio/dexcom-clarity_g6_export_metadata-event-rows_empty-timestamps.csv': dict(header=0, data_start=1, note='metadata/event rows without a timestamp, then readings'),
 'mech-chem-bio/racelogic-vbox_vbo_ini-sections_space-delim_signed-minutes.vbo': dict(structure='sections', note='[column names] and [data] sections'),
 'lab-instruments/ni-labview_lvm_es_multi-segment_one-sample-each_no-x-column.lvm': dict(structure='multi-segment', note='one sample per segment, each with its own header'),
 'mech-chem-bio/aim-racestudio_formula-student-damper_ja_shift-jis_duplicate-header.csv': dict(header=12, data_start=17, note='names twice (12, 13), units 14, a numbering row 15, a blank line, data from 17'),
 'industrial-energy/sgcc_substation-transformer-scada-10min_zh_gbk_empty-col-name_null.csv': dict(header=0, data_start=1),
}

# Labels corrected after the first scoring, each because the label was wrong
# by a rule stated before scoring or by a count anyone can repeat. Listed in
# README.md, and kept apart from R so the corrections stay visible.
CORRECTED = {
 # A one-column table has no delimiter (the rule empatica's label follows).
 'mech-chem-bio/ezchrom_elite_gc_one-value-per-line.dat.asc': dict(delimiter='', why='one value per row: no delimiter, as for empatica'),
 # rows_approx in the manifest is the file's line count; the data is shorter.
 'mech-chem-bio/biologic_eclab_modulobat_de-decimal-comma.mpt': dict(rows_approx=33, why='126 is the line count; 33 data rows follow the 94-line header'),
 'mech-chem-bio/princeton_versastudio_eis_xml-sections-with-csv.par': dict(rows_approx=61, why='513 is the line count; 61 data rows, then 330 lines of XML layout'),
}

out = []
for line in open(os.path.join(CORPUS, 'manifest.jsonl'), encoding='utf-8'):
    if not line.strip(): continue
    m = json.loads(line)
    label = {
        'path': m['path'],
        'encoding': enc_family(m['encoding']),
        'delimiter': delim(m['delimiter']),
        'decimal': dec(m['decimal_separator']),
        'data_start': m['header_lines'],
        'structure': 'table',
        'values': 'numeric',
        'rows_approx': m.get('rows_approx'),
        'reviewed': False,
    }
    if m['path'] in R:
        label.update(R[m['path']]); label['reviewed'] = True
    if m['path'] in CORRECTED:
        fix = dict(CORRECTED[m['path']])
        label['corrected'] = fix.pop('why')
        label.update(fix)
    out.append(label)
with open(os.path.join(HERE, 'labels.jsonl'), 'w', encoding='utf-8') as f:
    for label in out: f.write(json.dumps(label, ensure_ascii=False) + '\n')
print(len(out), 'labels,', sum(l['reviewed'] for l in out), 'reviewed by hand,', sum(l['structure'] != 'table' for l in out), 'not single tables,', sum('corrected' in l for l in out), 'corrected after scoring')
