# %% Noisy chirp CSV generator
# Edit these values in Spyder and run the cells.

from pathlib import Path
import csv
import math
import random


# %% User parameters

# Output file. By default it writes directly to the app examples folder.
script_dir = Path(__file__).resolve().parent
output_csv = script_dir.parent / "public" / "examples" / "noisy_chirp_fourier_transform.csv"

# Chirp setup.
start_frequency_hz = 10
end_frequency_hz = 1000
sampling_frequency_hz = 20e3
time_to_end_frequency_s = 3

# Signal setup.
amplitude = 1.0
noise_rms = 0.75
random_seed = 123456789

# Optional browser preview with Plotly from the Spyder environment.
show_preview = True
preview_start_s = 0.0
preview_duration_s = 8.0


# %% Build signal

dt_s = 1.0 / sampling_frequency_hz
number_of_samples = int(round(time_to_end_frequency_s * sampling_frequency_hz)) + 1

chirp_rate_hz_per_s = (end_frequency_hz - start_frequency_hz) / time_to_end_frequency_s

time_s = []
chirp_clean = []
noise = []
chirp_noisy = []
instantaneous_frequency_hz = []

rng = random.Random(random_seed)

for sample_index in range(number_of_samples):
    t = sample_index * dt_s
    phase_rad = 2.0 * math.pi * (
        start_frequency_hz * t
        + 0.5 * chirp_rate_hz_per_s * t**2
    )
    clean_value = amplitude * math.sin(phase_rad)
    noise_value = noise_rms * rng.gauss(0.0, 1.0)
    noisy_value = clean_value + noise_value
    frequency_value = start_frequency_hz + chirp_rate_hz_per_s * t

    time_s.append(t)
    chirp_clean.append(clean_value)
    noise.append(noise_value)
    chirp_noisy.append(noisy_value)
    instantaneous_frequency_hz.append(frequency_value)


# %% Save CSV

output_csv.parent.mkdir(parents=True, exist_ok=True)

with output_csv.open("w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file)
    writer.writerow([
        "time [s]",
        "chirp_clean [pu]",
        "chirp_noisy [pu]",
        "noise [pu]",
        "instantaneous_frequency [Hz]",
    ])
    for row_index in range(number_of_samples):
        writer.writerow([
            f"{time_s[row_index]:.8f}",
            f"{chirp_clean[row_index]:.8f}",
            f"{chirp_noisy[row_index]:.8f}",
            f"{noise[row_index]:.8f}",
            f"{instantaneous_frequency_hz[row_index]:.8f}",
        ])

print(f"CSV written: {output_csv}")
print(f"Rows: {number_of_samples:,}")
print(f"Duration: {time_s[-1]:.3f} s")
print(f"Sampling frequency: {sampling_frequency_hz:.3f} Hz")
print(f"Start frequency: {start_frequency_hz:.3f} Hz")
print(f"End frequency: {end_frequency_hz:.3f} Hz")
print(f"Noise RMS: {noise_rms:.3f} pu")


# %% Plotly preview

if show_preview:
    import plotly.graph_objects as go

    preview_end_s = preview_start_s + preview_duration_s
    preview_time_s = []
    preview_chirp_noisy = []
    preview_chirp_clean = []
    preview_frequency_hz = []
    for row_index, t in enumerate(time_s):
        if preview_start_s <= t <= preview_end_s:
            preview_time_s.append(t)
            preview_chirp_noisy.append(chirp_noisy[row_index])
            preview_chirp_clean.append(chirp_clean[row_index])
            preview_frequency_hz.append(instantaneous_frequency_hz[row_index])

    fig = go.Figure()
    fig.add_trace(go.Scattergl(
        x=preview_time_s,
        y=preview_chirp_noisy,
        mode="lines",
        name="chirp_noisy",
        line={"width": 1.0, "color": "#2196F3"},
    ))
    fig.add_trace(go.Scattergl(
        x=preview_time_s,
        y=preview_chirp_clean,
        mode="lines",
        name="chirp_clean",
        line={"width": 1.5, "color": "#FF5722"},
    ))
    fig.add_trace(go.Scattergl(
        x=preview_time_s,
        y=preview_frequency_hz,
        mode="lines",
        name="instantaneous_frequency",
        yaxis="y2",
        line={"width": 1.5, "color": "#4CAF50"},
    ))
    fig.update_layout(
        title="Noisy Chirp Fourier Transform - preview",
        xaxis_title="time [s]",
        yaxis_title="amplitude [pu]",
        yaxis2={
            "title": "frequency [Hz]",
            "overlaying": "y",
            "side": "right",
            "showgrid": False,
        },
        hovermode="x unified",
        template="plotly_white",
        legend={"orientation": "h"},
        margin={"l": 60, "r": 24, "t": 54, "b": 54},
    )
    fig.show(renderer="browser")
