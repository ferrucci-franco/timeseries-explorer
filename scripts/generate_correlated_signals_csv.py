# %% Correlated signals CSV generator
# Edit these values in Spyder and run the cells.

from pathlib import Path
import csv
import math
import random


# %% User parameters

# Output file. By default it writes directly to the app examples folder.
script_dir = Path(__file__).resolve().parent
output_csv = script_dir.parent / "public" / "examples" / "correlated_signals_example.csv"

# Time setup.
sampling_frequency_hz = 10.0
duration_s = 60.0

# Signal setup.
random_seed = 20260722
base_noise_rms = 0.08
a_strong_noise_rms = 0.10
a_less_strong_noise_rms = 0.45
b_noise_rms = 0.06
b_quadratic_noise_rms = 0.18

# Relationship setup.
a_strong_gain = 1.8
a_strong_offset = 0.15
a_less_strong_gain = 0.9
a_less_strong_offset = -0.10
b_quadratic_linear_gain = 0.25
b_quadratic_gain = 0.85
b_quadratic_offset = -0.20

# Optional browser preview with Plotly from the Spyder environment.
show_preview = True


# %% Build signals

dt_s = 1.0 / sampling_frequency_hz
number_of_samples = int(round(duration_s * sampling_frequency_hz)) + 1
rng = random.Random(random_seed)

time_s = []
a = []
a_strong = []
a_less_strong = []
b = []
b_quadratic = []

for sample_index in range(number_of_samples):
    t = sample_index * dt_s

    slow = math.sin(2.0 * math.pi * 0.055 * t)
    medium = 0.35 * math.sin(2.0 * math.pi * 0.19 * t + 0.8)
    trend = 0.012 * (t - 0.5 * duration_s)
    a_value = slow + medium + trend + base_noise_rms * rng.gauss(0.0, 1.0)

    a_strong_value = (
        a_strong_offset
        + a_strong_gain * a_value
        + a_strong_noise_rms * rng.gauss(0.0, 1.0)
    )
    a_less_strong_value = (
        a_less_strong_offset
        + a_less_strong_gain * a_value
        + a_less_strong_noise_rms * rng.gauss(0.0, 1.0)
    )

    b_clean = (
        1.1 * math.sin(2.0 * math.pi * 0.075 * t + 1.6)
        - 0.45 * math.cos(2.0 * math.pi * 0.145 * t)
    )
    b_value = b_clean + b_noise_rms * rng.gauss(0.0, 1.0)
    b_quadratic_value = (
        b_quadratic_offset
        + b_quadratic_linear_gain * b_value
        + b_quadratic_gain * b_value**2
        + b_quadratic_noise_rms * rng.gauss(0.0, 1.0)
    )

    time_s.append(t)
    a.append(a_value)
    a_strong.append(a_strong_value)
    a_less_strong.append(a_less_strong_value)
    b.append(b_value)
    b_quadratic.append(b_quadratic_value)


# %% Save CSV

output_csv.parent.mkdir(parents=True, exist_ok=True)

with output_csv.open("w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file)
    writer.writerow([
        "time [s]",
        "A [pu]",
        "A_strong [pu]",
        "A_less_strong [pu]",
        "B [pu]",
        "B_quadratic [pu]",
    ])
    for row_index in range(number_of_samples):
        writer.writerow([
            f"{time_s[row_index]:.8f}",
            f"{a[row_index]:.8f}",
            f"{a_strong[row_index]:.8f}",
            f"{a_less_strong[row_index]:.8f}",
            f"{b[row_index]:.8f}",
            f"{b_quadratic[row_index]:.8f}",
        ])

print(f"CSV written: {output_csv}")
print(f"Rows: {number_of_samples:,}")
print(f"Duration: {time_s[-1]:.3f} s")
print(f"Sampling frequency: {sampling_frequency_hz:.3f} Hz")


# %% Plotly preview

if show_preview:
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    fig = make_subplots(
        rows=2,
        cols=3,
        subplot_titles=(
            "Signals over time",
            "A vs A_strong",
            "A vs A_less_strong",
            "B over time",
            "B vs B_quadratic",
            "A vs B",
        ),
        specs=[
            [{"type": "xy"}, {"type": "xy"}, {"type": "xy"}],
            [{"type": "xy"}, {"type": "xy"}, {"type": "xy"}],
        ],
    )

    fig.add_trace(go.Scattergl(x=time_s, y=a, mode="lines", name="A"), row=1, col=1)
    fig.add_trace(go.Scattergl(x=time_s, y=a_strong, mode="lines", name="A_strong"), row=1, col=1)
    fig.add_trace(go.Scattergl(x=time_s, y=a_less_strong, mode="lines", name="A_less_strong"), row=1, col=1)

    fig.add_trace(go.Scattergl(
        x=a,
        y=a_strong,
        mode="markers",
        name="A vs A_strong",
        marker={"size": 5, "opacity": 0.65},
        showlegend=False,
    ), row=1, col=2)

    fig.add_trace(go.Scattergl(
        x=a,
        y=a_less_strong,
        mode="markers",
        name="A vs A_less_strong",
        marker={"size": 5, "opacity": 0.65},
        showlegend=False,
    ), row=1, col=3)

    fig.add_trace(go.Scattergl(x=time_s, y=b, mode="lines", name="B"), row=2, col=1)
    fig.add_trace(go.Scattergl(x=time_s, y=b_quadratic, mode="lines", name="B_quadratic"), row=2, col=1)

    fig.add_trace(go.Scattergl(
        x=b,
        y=b_quadratic,
        mode="markers",
        name="B vs B_quadratic",
        marker={"size": 5, "opacity": 0.65},
        showlegend=False,
    ), row=2, col=2)

    fig.add_trace(go.Scattergl(
        x=a,
        y=b,
        mode="markers",
        name="A vs B",
        marker={"size": 5, "opacity": 0.65},
        showlegend=False,
    ), row=2, col=3)

    fig.update_xaxes(title_text="time [s]", row=1, col=1)
    fig.update_xaxes(title_text="A [pu]", row=1, col=2)
    fig.update_xaxes(title_text="A [pu]", row=1, col=3)
    fig.update_xaxes(title_text="time [s]", row=2, col=1)
    fig.update_xaxes(title_text="B [pu]", row=2, col=2)
    fig.update_xaxes(title_text="A [pu]", row=2, col=3)

    fig.update_yaxes(title_text="value [pu]", row=1, col=1)
    fig.update_yaxes(title_text="A_strong [pu]", row=1, col=2)
    fig.update_yaxes(title_text="A_less_strong [pu]", row=1, col=3)
    fig.update_yaxes(title_text="value [pu]", row=2, col=1)
    fig.update_yaxes(title_text="B_quadratic [pu]", row=2, col=2)
    fig.update_yaxes(title_text="B [pu]", row=2, col=3)

    fig.update_layout(
        title="Correlated Signals Example - preview",
        template="plotly_white",
        hovermode="closest",
        height=820,
        legend={"orientation": "h"},
        margin={"l": 60, "r": 24, "t": 90, "b": 54},
    )
    fig.show(renderer="browser")
