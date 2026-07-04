#!/usr/bin/env python3
"""Generate small pandas pickle fixtures for the JavaScript parser tests.

If pandas/numpy are installed, this script writes real pandas fixtures. When
they are not available, it writes compact pandas-like pickles using fake modules
named like pandas/numpy internals. The fallback keeps the Node test runner pure
and still exercises the same GLOBAL/REDUCE/BUILD paths used by pandas pickles.
"""

from __future__ import annotations

import gzip
import json
import math
import pickle
from pathlib import Path
import struct
import sys
import types


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-files" / "pickle"
NAT = -9223372036854775808


def write_pickle(name: str, obj, protocol: int = 5) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_bytes(pickle.dumps(obj, protocol=protocol))


def clear_output() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for path in OUT.glob("*.pkl"):
        if path.is_file():
            path.unlink()
    manifest = OUT / "manifest.json"
    if manifest.exists():
        manifest.unlink()


def try_real_pandas() -> bool:
    try:
        import numpy as np
        import pandas as pd
    except Exception:
        return False

    OUT.mkdir(parents=True, exist_ok=True)
    idx = pd.date_range("2024-01-01", periods=24 * 365, freq="h")
    df = pd.DataFrame({
        "solar": np.sin(np.arange(len(idx)) / 24.0),
        "wind": np.cos(np.arange(len(idx)) / 24.0),
        "load": np.linspace(10, 20, len(idx)),
    }, index=idx)
    write_pickle("datetime_df.pkl", df)
    write_pickle("protocol2.pkl", df.iloc[:8], protocol=2)
    write_pickle("protocol4.pkl", df.iloc[:8], protocol=4)
    write_pickle("protocol5.pkl", df.iloc[:8], protocol=5)

    mi2 = pd.MultiIndex.from_tuples([("Generator", "p"), ("Load", "p_set")], names=["component", "attr"])
    write_pickle("multiindex_columns_2.pkl", pd.DataFrame([[1.0, 2.0], [3.0, 4.0]], index=idx[:2], columns=mi2))

    mi3 = pd.MultiIndex.from_tuples([("Generator", "gen1", "p"), ("Generator", "gen1", "q")], names=["component", "asset", "attr"])
    write_pickle("multiindex_columns_3.pkl", pd.DataFrame([[1.0, 2.0], [3.0, 4.0]], index=idx[:2], columns=mi3))

    write_pickle("range_index.pkl", pd.DataFrame({"a": [1.0, 2.0, 3.0]}))
    write_pickle("numeric_index.pkl", pd.DataFrame({"a": [10.0, 11.0, 12.0]}, index=[0.0, 0.5, 1.0]))
    write_pickle("series.pkl", pd.Series([5.0, 6.0, 7.0], index=idx[:3], name="power"))
    write_pickle("dict.pkl", {
        "a": pd.DataFrame({"solar": [1.0, 2.0, 3.0]}, index=idx[:3]),
        "b": pd.DataFrame({"wind": [4.0, 5.0, 6.0]}, index=idx[:3]),
    })
    write_pickle("dict_mismatch.pkl", {
        "a": pd.DataFrame({"solar": [1.0, 2.0, 3.0]}, index=[0.0, 1.0, 2.0]),
        "b": pd.DataFrame({"wind": [4.0, 5.0, 6.0]}, index=[0.0, 1.0, 9.0]),
    })
    write_pickle("duplicate_columns.pkl", pd.DataFrame(
        [[1.0, 10.0], [2.0, 20.0], [3.0, 30.0]],
        columns=["dup", "dup"],
    ))
    write_pickle("mixed.pkl", pd.DataFrame({
        "nan_col": [1.0, np.nan, 3.0],
        "flag": [True, False, True],
        "name": ["a", "b", "c"],
        "big": [1, 2**54, 3],
    }, index=pd.RangeIndex(3)))
    tz_idx = pd.DatetimeIndex([pd.Timestamp("2024-01-01", tz="Europe/Madrid"), pd.NaT, pd.Timestamp("2024-01-01 02:00", tz="Europe/Madrid")])
    write_pickle("datetime_tz_nat.pkl", pd.DataFrame({"a": [1.0, 2.0, 3.0]}, index=tz_idx))
    row_mi = pd.MultiIndex.from_tuples([("a", 1), ("a", 2), ("b", 1)])
    write_pickle("row_multiindex.pkl", pd.DataFrame({"a": [1.0, 2.0, 3.0]}, index=row_mi))
    (OUT / "compressed.pkl").write_bytes(gzip.compress((OUT / "datetime_df.pkl").read_bytes()))
    write_pickle("unsupported.pkl", object())
    return True


def fake_module(name: str) -> types.ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    module = types.ModuleType(name)
    sys.modules[name] = module
    if "." in name:
        parent_name, attr = name.rsplit(".", 1)
        parent = sys.modules.get(parent_name) or fake_module(parent_name)
        setattr(parent, attr, module)
    return module


def publish(module: str, name: str, value):
    mod = fake_module(module)
    value.__module__ = module
    value.__name__ = name
    value.__qualname__ = name
    setattr(mod, name, value)
    return value


class dtype:
    def __init__(self, spec: str):
        self.spec = spec

    def __reduce__(self):
        return (dtype, (self.spec,))


class ndarray:
    def __init__(self, shape, dtype_spec: str, data):
        self.shape = tuple(shape)
        self.dtype = dtype(dtype_spec)
        self.data = data

    def __reduce_ex__(self, _protocol):
        raw = pack_values(self.dtype.spec, self.data)
        return (_reconstruct, (ndarray, (0,), self.dtype), (1, self.shape, self.dtype, False, raw))


def _reconstruct(_subtype, shape, dtype_obj):
    return ndarray(shape, dtype_obj.spec, [])


def _unpickle_block(values, placement, ndim):
    return Block(values, placement, ndim)


def _new_Index(cls, state):
    return cls(**state)


def _new_DatetimeIndex(cls, state):
    return cls(**state)


def pack_values(dtype_spec: str, data):
    if dtype_spec in ("f8", "<f8"):
        return b"".join(struct.pack("<d", float(v)) for v in data)
    if dtype_spec in ("f4", "<f4"):
        return b"".join(struct.pack("<f", float(v)) for v in data)
    if dtype_spec in ("i8", "<i8", "M8[ns]", "m8[ns]"):
        return b"".join(struct.pack("<q", int(v)) for v in data)
    if dtype_spec in ("u8", "<u8"):
        return b"".join(struct.pack("<Q", int(v)) for v in data)
    if dtype_spec in ("i4", "<i4"):
        return b"".join(struct.pack("<i", int(v)) for v in data)
    if dtype_spec in ("?", "b1", "|b1"):
        return b"".join(struct.pack("B", 1 if v else 0) for v in data)
    if dtype_spec == "O":
        return list(data)
    raise ValueError(f"unsupported fake dtype: {dtype_spec}")


class Index:
    def __init__(self, data=None, name=None, **_kwargs):
        self.data = data if data is not None else ndarray((0,), "O", [])
        self.name = name

    def __reduce__(self):
        return (_new_Index, (Index, {"data": self.data, "name": self.name}))


class RangeIndex:
    def __init__(self, start=0, stop=0, step=1, name=None, **_kwargs):
        self.start = start
        self.stop = stop
        self.step = step
        self.name = name

    def __reduce__(self):
        return (_new_Index, (RangeIndex, {"start": self.start, "stop": self.stop, "step": self.step, "name": self.name}))


class DatetimeIndex(Index):
    def __reduce__(self):
        return (_new_DatetimeIndex, (DatetimeIndex, {"data": self.data, "name": self.name}))


class MultiIndex:
    def __init__(self, levels=None, codes=None, names=None, **_kwargs):
        self.levels = levels or []
        self.codes = codes or []
        self.names = names

    def __reduce__(self):
        return (_new_Index, (MultiIndex, {"levels": self.levels, "codes": self.codes, "names": self.names}))


class Block:
    def __init__(self, values, placement, ndim=2):
        self.values = values
        self.placement = placement
        self.ndim = ndim

    def __reduce__(self):
        return (_unpickle_block, (self.values, self.placement, self.ndim))


class BlockManager:
    def __init__(self, blocks=None, axes=None):
        self.blocks = blocks or []
        self.axes = axes or []


class DataFrame:
    def __init__(self, mgr):
        self._mgr = mgr
        self.attrs = {}

    def __getstate__(self):
        return {"_mgr": self._mgr, "_typ": "dataframe", "_metadata": [], "attrs": self.attrs}


class Series:
    def __init__(self, mgr, name=None):
        self._mgr = mgr
        self._name = name

    def __getstate__(self):
        return {"_mgr": self._mgr, "_typ": "series", "_metadata": [], "_name": self._name}


class CustomUnsupported:
    pass


def install_fake_modules():
    publish("numpy", "dtype", dtype)
    publish("numpy", "ndarray", ndarray)
    publish("numpy.core.multiarray", "_reconstruct", _reconstruct)
    publish("numpy.core.multiarray", "ndarray", ndarray)
    publish("numpy._core.multiarray", "_reconstruct", _reconstruct)
    publish("pandas._libs.internals", "_unpickle_block", _unpickle_block)
    publish("pandas.core.indexes.base", "_new_Index", _new_Index)
    publish("pandas.core.indexes.datetimes", "_new_DatetimeIndex", _new_DatetimeIndex)
    publish("pandas.core.indexes.base", "Index", Index)
    publish("pandas.core.indexes.range", "RangeIndex", RangeIndex)
    publish("pandas.core.indexes.datetimes", "DatetimeIndex", DatetimeIndex)
    publish("pandas.core.indexes.multi", "MultiIndex", MultiIndex)
    publish("pandas.core.internals.managers", "BlockManager", BlockManager)
    publish("pandas.core.frame", "DataFrame", DataFrame)
    publish("pandas.core.series", "Series", Series)


def ns(dt_hours: int) -> int:
    return 1704067200000000000 + dt_hours * 3600 * 1_000_000_000


def df(index, columns, column_data, dtypes=None):
    dtypes = dtypes or ["f8"] * len(column_data)
    blocks = []
    for i, values in enumerate(column_data):
        arr = ndarray((1, len(values)), dtypes[i], values)
        blocks.append(Block(arr, [i], 2))
    return DataFrame(BlockManager(blocks, [columns, index]))


def fake_fixtures():
    install_fake_modules()
    OUT.mkdir(parents=True, exist_ok=True)

    hours = 24 * 365
    dt_index = DatetimeIndex(ndarray((hours,), "M8[ns]", [ns(i) for i in range(hours)]))
    base = df(
        dt_index,
        Index(ndarray((3,), "O", ["solar", "wind", "load"])),
        [
            [math.sin(i / 24.0) for i in range(hours)],
            [math.cos(i / 24.0) for i in range(hours)],
            [10 + 10 * i / (hours - 1) for i in range(hours)],
        ],
    )
    write_pickle("datetime_df.pkl", base)
    write_pickle("protocol2.pkl", df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(i) for i in range(3)])), Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]), protocol=2)
    write_pickle("protocol4.pkl", df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(i) for i in range(3)])), Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]), protocol=4)
    write_pickle("protocol5.pkl", df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(i) for i in range(3)])), Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]), protocol=5)

    mi2 = MultiIndex(
        levels=[Index(ndarray((2,), "O", ["Generator", "Load"])), Index(ndarray((2,), "O", ["p", "p_set"]))],
        codes=[ndarray((2,), "i4", [0, 1]), ndarray((2,), "i4", [0, 1])],
        names=["component", "attr"],
    )
    write_pickle("multiindex_columns_2.pkl", df(DatetimeIndex(ndarray((2,), "M8[ns]", [ns(0), ns(1)])), mi2, [[1.0, 3.0], [2.0, 4.0]]))

    mi3 = MultiIndex(
        levels=[Index(ndarray((1,), "O", ["Generator"])), Index(ndarray((1,), "O", ["gen1"])), Index(ndarray((2,), "O", ["p", "q"]))],
        codes=[ndarray((2,), "i4", [0, 0]), ndarray((2,), "i4", [0, 0]), ndarray((2,), "i4", [0, 1])],
        names=["component", "asset", "attr"],
    )
    write_pickle("multiindex_columns_3.pkl", df(DatetimeIndex(ndarray((2,), "M8[ns]", [ns(0), ns(1)])), mi3, [[1.0, 3.0], [2.0, 4.0]]))

    write_pickle("range_index.pkl", df(RangeIndex(0, 3, 1), Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]))
    write_pickle("numeric_index.pkl", df(Index(ndarray((3,), "f8", [0.0, 0.5, 1.0])), Index(ndarray((1,), "O", ["a"])), [[10.0, 11.0, 12.0]]))
    write_pickle("series.pkl", Series(BlockManager([Block(ndarray((3,), "f8", [5.0, 6.0, 7.0]), [0], 1)], [DatetimeIndex(ndarray((3,), "M8[ns]", [ns(0), ns(1), ns(2)]))]), "power"))
    write_pickle("dict.pkl", {
        "a": df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(0), ns(1), ns(2)])), Index(ndarray((1,), "O", ["solar"])), [[1.0, 2.0, 3.0]]),
        "b": df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(0), ns(1), ns(2)])), Index(ndarray((1,), "O", ["wind"])), [[4.0, 5.0, 6.0]]),
    })
    write_pickle("dict_mismatch.pkl", {
        "a": df(Index(ndarray((3,), "f8", [0.0, 1.0, 2.0])), Index(ndarray((1,), "O", ["solar"])), [[1.0, 2.0, 3.0]]),
        "b": df(Index(ndarray((3,), "f8", [0.0, 1.0, 9.0])), Index(ndarray((1,), "O", ["wind"])), [[4.0, 5.0, 6.0]]),
    })
    write_pickle("duplicate_columns.pkl", df(
        RangeIndex(0, 3, 1),
        Index(ndarray((2,), "O", ["dup", "dup"])),
        [[1.0, 2.0, 3.0], [10.0, 20.0, 30.0]],
    ))
    write_pickle("mixed.pkl", df(
        RangeIndex(0, 3, 1),
        Index(ndarray((4,), "O", ["nan_col", "flag", "name", "big"])),
        [[1.0, math.nan, 3.0], [True, False, True], ["a", "b", "c"], [1, 2**54, 3]],
        ["f8", "?", "O", "i8"],
    ))
    write_pickle("datetime_tz_nat.pkl", df(DatetimeIndex(ndarray((3,), "M8[ns]", [ns(0), NAT, ns(2)])), Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]))
    row_mi = MultiIndex(
        levels=[Index(ndarray((2,), "O", ["a", "b"])), Index(ndarray((2,), "i4", [1, 2]))],
        codes=[ndarray((3,), "i4", [0, 0, 1]), ndarray((3,), "i4", [0, 1, 0])],
        names=["letter", "num"],
    )
    write_pickle("row_multiindex.pkl", df(row_mi, Index(ndarray((1,), "O", ["a"])), [[1.0, 2.0, 3.0]]))
    (OUT / "compressed.pkl").write_bytes(gzip.compress((OUT / "datetime_df.pkl").read_bytes()))
    write_pickle("unsupported.pkl", CustomUnsupported())


def main() -> int:
    clear_output()
    used_real = try_real_pandas()
    if not used_real:
        fake_fixtures()
    manifest = {
        "generator": "real-pandas" if used_real else "fake-pandas-modules",
        "fixtures": sorted(path.name for path in OUT.glob("*.pkl")),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(manifest['fixtures'])} pickle fixtures to {OUT}")
    print(f"Mode: {manifest['generator']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
