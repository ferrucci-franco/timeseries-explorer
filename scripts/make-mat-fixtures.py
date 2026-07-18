"""Generate small general-purpose MATLAB fixtures for the JS parser tests."""

from pathlib import Path

import h5py
import numpy as np
from scipy.io import savemat
from scipy import sparse


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-files" / "matlab"
OUT.mkdir(parents=True, exist_ok=True)

time = np.linspace(0.0, 4.0, 5)
signals = np.column_stack((time * 10.0, 100.0 + time))
payload = {
    "time": time,
    "signals": signals,
    "scalar": np.array([[42.5]]),
    "flags": np.array([False, True, False, True, True], dtype=np.bool_),
    "complex_signal": np.exp(1j * time),
    "label": "fixture",
    "config": {
        "gain": np.array([[2.5]]),
        "profile": time * 2.0,
        "nested": {"offset": np.array([[1.25]])},
    },
}
samples_cell = np.empty((1, 2), dtype=object)
samples_cell[0, 0] = time * 3.0
samples_cell[0, 1] = np.array([[7.0]])
payload["samples_cell"] = samples_cell
payload["sparse_signals"] = sparse.csc_matrix(signals)

savemat(OUT / "general-v4.mat", {
    key: value for key, value in payload.items() if key not in {"config", "samples_cell", "sparse_signals"}
}, format="4")
savemat(OUT / "general-v5.mat", payload, format="5", do_compression=False)
savemat(OUT / "general-v7-compressed.mat", payload, format="5", do_compression=True)

# MATLAB 7.3 is an HDF5 container. These datasets carry the MATLAB_class
# attributes used by MATLAB itself; groups exercise hierarchical names.
v73_path = OUT / "general-v73.mat"
with h5py.File(v73_path, "w", userblock_size=512) as handle:
    datasets = {
        "time": time,
        "signals": signals,
        "scalar": np.array([[42.5]]),
        "flags": np.array([0, 1, 0, 1, 1], dtype=np.uint8),
    }
    for name, values in datasets.items():
        dataset = handle.create_dataset(name, data=values)
        dataset.attrs["MATLAB_class"] = np.bytes_("logical" if name == "flags" else "double")
    group = handle.create_group("experiment")
    nested = group.create_dataset("temperature", data=273.15 + time)
    nested.attrs["MATLAB_class"] = np.bytes_("double")
    label = handle.create_dataset("label", data=np.asarray([ord(char) for char in "fixture"], dtype=np.uint16))
    label.attrs["MATLAB_class"] = np.bytes_("char")
    complex_dtype = np.dtype([("real", np.float64), ("imag", np.float64)])
    complex_values = np.empty(time.shape, dtype=complex_dtype)
    complex_values["real"] = np.cos(time)
    complex_values["imag"] = np.sin(time)
    complex_dataset = handle.create_dataset("complex_signal", data=complex_values)
    complex_dataset.attrs["MATLAB_class"] = np.bytes_("double")
    refs = handle.create_group("#refs#")
    cell_target = refs.create_dataset("cell_vector", data=time * 3.0)
    cell_target.attrs["MATLAB_class"] = np.bytes_("double")
    cell = handle.create_dataset("samples_cell", shape=(1,), dtype=h5py.ref_dtype)
    cell[0] = cell_target.ref
    cell.attrs["MATLAB_class"] = np.bytes_("cell")
    structure = handle.create_group("settings")
    structure.attrs["MATLAB_class"] = np.bytes_("struct")
    gain_target = refs.create_dataset("struct_gain", data=np.array([[2.5]]))
    gain_target.attrs["MATLAB_class"] = np.bytes_("double")
    gain_field = structure.create_dataset("gain", shape=(1,), dtype=h5py.ref_dtype)
    gain_field[0] = gain_target.ref

# Real MATLAB v7.3 files use an HDF5 user block with this identifying header;
# the HDF5 signature begins at byte 512 rather than byte zero.
header = b"MATLAB 7.3 MAT-file, Platform: synthetic, Created by timeseries-explorer tests"
with v73_path.open("r+b") as stream:
    stream.write(header.ljust(116, b" "))
    stream.write(b"\x00" * 8)
    stream.write(b"\x00\x02IM")

print(f"Generated MATLAB fixtures in {OUT}")
