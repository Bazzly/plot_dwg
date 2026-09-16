"""Curated CRS presets, value-range-based CRS guessing, and pyproj-backed
coordinate transforms.

Guessing is deliberately conservative: it ranks candidates by how well the
sample coordinate values fit each CRS's typical value range, but the caller
(the frontend) must always show these as a confirm/override step rather
than transforming silently -- several Nigerian projected CRSs produce
overlapping-looking value ranges (e.g. plain UTM vs a Minna belt) and only
the false-easting proximity separates them, which is a heuristic, not proof.
"""
from dataclasses import dataclass

from pyproj import CRS, Transformer


@dataclass
class CrsPreset:
    id: str
    label: str
    epsg: int
    kind: str  # "geographic" | "projected"
    note: str = ""


CURATED_PRESETS: list[CrsPreset] = [
    CrsPreset("wgs84", "WGS84 (geographic, lat/long)", 4326, "geographic",
              "Standard GPS output. Longitude = X, Latitude = Y."),
    CrsPreset("minna_geo", "Minna (geographic, lat/long)", 4263, "geographic",
              "Nigerian local datum, geographic coordinates."),
    CrsPreset("minna_west", "Minna / Nigeria West Belt", 26391, "projected",
              "False easting 670,000. CM 4°30'W."),
    CrsPreset("minna_mid", "Minna / Nigeria Mid Belt", 26392, "projected",
              "False easting 670,000. CM 8°30'E."),
    CrsPreset("minna_east", "Minna / Nigeria East Belt", 26393, "projected",
              "False easting 1,150,000. CM 12°30'E."),
    CrsPreset("wgs84_utm31n", "WGS84 / UTM zone 31N", 32631, "projected",
              "False easting 500,000. Covers 0-6°E."),
    CrsPreset("wgs84_utm32n", "WGS84 / UTM zone 32N", 32632, "projected",
              "False easting 500,000. Covers 6-12°E."),
    CrsPreset("minna_utm31n", "Minna / UTM zone 31N", 26331, "projected",
              "False easting 500,000. Covers 0-6°E."),
    CrsPreset("minna_utm32n", "Minna / UTM zone 32N", 26332, "projected",
              "False easting 500,000. Covers 6-12°E."),
]

_PRESET_BY_EPSG = {p.epsg: p for p in CURATED_PRESETS}


def preset_list() -> list[dict]:
    return [p.__dict__ for p in CURATED_PRESETS]


def lookup_epsg(epsg: int) -> dict:
    """Resolve any EPSG code (curated or not) to a display-friendly dict,
    used when the user searches/enters a code outside the curated list."""
    preset = _PRESET_BY_EPSG.get(epsg)
    if preset:
        return preset.__dict__
    crs = CRS.from_epsg(epsg)
    return {
        "id": f"epsg-{epsg}",
        "label": crs.name,
        "epsg": epsg,
        "kind": "geographic" if crs.is_geographic else "projected",
        "note": "",
    }


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def guess_crs(x_values: list[float], y_values: list[float]) -> dict:
    """Rank CURATED_PRESETS candidates against the sample x/y values.
    x is treated as the easting/longitude-like axis, y as northing/latitude."""
    if not x_values or not y_values:
        return {"top": None, "candidates": []}

    x_abs = [abs(v) for v in x_values]
    y_abs = [abs(v) for v in y_values]
    looks_geographic = max(x_abs) <= 180 and max(y_abs) <= 90

    candidates = []
    if looks_geographic:
        candidates.append({**_PRESET_BY_EPSG[4326].__dict__, "confidence": "likely"})
        candidates.append({**_PRESET_BY_EPSG[4263].__dict__, "confidence": "possible"})
    else:
        mean_x = _mean(x_values)
        scored = []
        for epsg, false_easting in ((32631, 500_000), (32632, 500_000),
                                     (26331, 500_000), (26332, 500_000),
                                     (26391, 670_000), (26392, 670_000),
                                     (26393, 1_150_000)):
            distance = abs(mean_x - false_easting)
            scored.append((distance, epsg))
        scored.sort()
        for rank, (distance, epsg) in enumerate(scored):
            confidence = "likely" if rank == 0 and distance < 200_000 else "possible"
            candidates.append({**_PRESET_BY_EPSG[epsg].__dict__, "confidence": confidence})

    return {"top": candidates[0] if candidates else None, "candidates": candidates}


def transform_points(
    xs: list[float], ys: list[float], zs: list[float | None],
    src_epsg: int, dst_epsg: int,
) -> list[tuple[float, float, float | None]]:
    """Transform a batch of points from src_epsg to dst_epsg. Z passes
    through unchanged (no vertical datum transform applied)."""
    transformer = Transformer.from_crs(
        CRS.from_epsg(src_epsg), CRS.from_epsg(dst_epsg), always_xy=True
    )
    out_x, out_y = transformer.transform(xs, ys)
    return list(zip(out_x, out_y, zs))
