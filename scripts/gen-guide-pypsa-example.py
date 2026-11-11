"""The PyPSA network the animated guide opens (src/ui/guide-chapters.js).

A made-up island grid, small enough to ship with the app: three buses, solar,
wind, a diesel plant and a battery, one week of hourly snapshots, solved for
least cost. Everything is synthetic and seeded, so the file is reproducible:

    pip install pypsa highspy netcdf4
    python scripts/gen-guide-pypsa-example.py

writes public/examples/guide/island_grid.nc.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pypsa

OUT = Path(__file__).resolve().parent.parent / "public" / "examples" / "guide" / "island_grid.nc"

rng = np.random.default_rng(7)
snapshots = pd.date_range("2025-06-02 00:00", periods=7 * 24, freq="h")
hour = snapshots.hour.to_numpy()
weekday = snapshots.dayofweek.to_numpy() < 5

# Demand: a morning and an evening peak, lower at the weekend.
shape = 0.55 + 0.25 * np.exp(-((hour - 9) ** 2) / 10) + 0.45 * np.exp(-((hour - 19) ** 2) / 7)
shape = shape * np.where(weekday, 1.0, 0.82)
town = 42 * shape * (1 + 0.03 * rng.standard_normal(len(snapshots)))
harbour = 18 * (0.7 + 0.3 * np.exp(-((hour - 13) ** 2) / 18)) * (1 + 0.04 * rng.standard_normal(len(snapshots)))

# Sun: a bell over the day, dimmed by a slowly varying cloud cover.
cloud = np.clip(0.75 + 0.25 * np.sin(np.arange(len(snapshots)) / 19.0) + 0.1 * rng.standard_normal(len(snapshots)), 0.2, 1)
solar = np.clip(np.sin(np.pi * (hour - 6) / 12), 0, None) * cloud
# Wind: a smoothed random walk, calm in the middle of the week.
walk = np.cumsum(rng.standard_normal(len(snapshots)))
walk = np.convolve(walk, np.ones(9) / 9, mode="same")
wind = np.clip(0.45 + 0.3 * (walk - walk.mean()) / walk.std() - 0.25 * np.exp(-((np.arange(len(snapshots)) - 84) ** 2) / 600), 0.02, 1)

n = pypsa.Network()
n.set_snapshots(snapshots)
n.add("Carrier", ["solar", "wind", "diesel", "battery", "AC"])
for name, x, y in [("Town", 0.0, 0.0), ("Harbour", 0.4, -0.2), ("Ridge", -0.3, 0.5)]:
    n.add("Bus", name, v_nom=20, x=x, y=y, carrier="AC")

n.add("Line", "Town-Harbour", bus0="Town", bus1="Harbour", x=0.1, r=0.02, s_nom=40)
n.add("Line", "Town-Ridge", bus0="Town", bus1="Ridge", x=0.15, r=0.03, s_nom=45)

n.add("Load", "Town demand", bus="Town", p_set=town)
n.add("Load", "Harbour demand", bus="Harbour", p_set=harbour)

n.add("Generator", "Solar farm", bus="Town", carrier="solar", p_nom=55, p_max_pu=solar, marginal_cost=0.1)
n.add("Generator", "Wind park", bus="Ridge", carrier="wind", p_nom=40, p_max_pu=wind, marginal_cost=0.2)
n.add("Generator", "Diesel plant", bus="Harbour", carrier="diesel", p_nom=60, marginal_cost=180)

n.add("StorageUnit", "Battery", bus="Town", carrier="battery", p_nom=20, max_hours=4,
      efficiency_store=0.95, efficiency_dispatch=0.95, cyclic_state_of_charge=True)

status, condition = n.optimize(solver_name="highs")
assert status == "ok", (status, condition)

OUT.parent.mkdir(parents=True, exist_ok=True)
n.export_to_netcdf(OUT)
print(OUT, OUT.stat().st_size, "bytes")
print(n.generators_t.p.sum().round(1).to_dict())
