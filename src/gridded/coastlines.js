// The coastlines and borders drawn under a gridded map: Natural Earth
// polylines (packed offline in public/geo/) turned into Plotly line traces.
//
// Pure geometry, so scripts/test-gridded-dataset.mjs exercises it directly.

/**
 * Coastline polylines as one x/y pair of arrays with null breaks, shifted into
 * the map's longitude convention (a 0..360 grid that could not be rolled keeps
 * 0..360, so the coast goes there too) and cut where a line jumps the seam.
 *
 * With a `window` ({x, y} in degrees) only what falls in it is kept, plus the
 * point on either side of every crossing so a line still reaches the edge.
 * The window is wider than the map on screen (`coastlineWindow`), so panning
 * does not uncover a missing coast, and it is what keeps the detailed 1:50m
 * set — 80.000 points worldwide — down to what is in sight.
 */
export function coastlineTrace(lines, lonMin, lonMax, window = null) {
    const shift = lonMax > 180;
    const x = [];
    const y = [];
    const inside = point => !window
        || (point[0] >= window.x[0] && point[0] <= window.x[1]
            && point[1] >= window.y[0] && point[1] <= window.y[1]);
    for (const line of lines || []) {
        const points = [];
        for (let index = 0; index < line.length; index += 2) {
            const lon = line[index];
            points.push([shift && lon < 0 ? lon + 360 : lon, line[index + 1]]);
        }
        let previous = null;
        let open = false;
        for (let index = 0; index < points.length; index++) {
            const [lon, lat] = points[index];
            const keep = inside(points[index])
                || (index > 0 && inside(points[index - 1]))
                || (index < points.length - 1 && inside(points[index + 1]));
            if (!keep) {
                if (open) {
                    x.push(null);
                    y.push(null);
                    open = false;
                    previous = null;
                }
                continue;
            }
            if (previous !== null && Math.abs(lon - previous) > 180) {
                x.push(null);
                y.push(null);
            }
            x.push(lon);
            y.push(lat);
            previous = lon;
            open = true;
        }
        if (open) {
            x.push(null);
            y.push(null);
        }
    }
    return { x, y, lonMin, lonMax };
}

/**
 * The part of the world the coastlines are cut to: what the map shows, grown
 * by half of itself on every side so a pan has somewhere to go before the map
 * is drawn again. Latitudes never pass the poles.
 */
export function coastlineWindow(ranges) {
    const span = (low, high) => Math.abs(high - low) / 2;
    const x = [Math.min(...ranges.x), Math.max(...ranges.x)];
    const y = [Math.min(...ranges.y), Math.max(...ranges.y)];
    const padX = span(x[0], x[1]);
    const padY = span(y[0], y[1]);
    return {
        x: [x[0] - padX, x[1] + padX],
        y: [Math.max(-90, y[0] - padY), Math.min(90, y[1] + padY)],
    };
}

/** Whether a view still falls inside the window its coastlines were cut to. */
export function insideCoastlineWindow(window, ranges) {
    if (!window || !ranges) return false;
    const within = (range, limits) => Math.min(...range) >= limits[0] - 1e-9 && Math.max(...range) <= limits[1] + 1e-9;
    // The poles bound the window itself, so a view that reaches them is in it.
    const y = [Math.max(-90, Math.min(...ranges.y)), Math.min(90, Math.max(...ranges.y))];
    return within(ranges.x, window.x) && within(y, window.y);
}
