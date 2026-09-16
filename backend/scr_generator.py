"""Build an AutoCAD .scr script from transformed points.

.scr files have no comment syntax -- every line is fed straight to the
AutoCAD command line, so the generator emits only valid command input.
Points and text labels loop within a single DONUT/markerless block where
the AutoCAD command supports it (DONUT accepts repeated centers in one
call); POINT, INSERT and TEXT do not loop, so those repeat the command
once per point.
"""
import math

DEFAULT_STYLE = {
    "marker_type": "DONUT",       # "DONUT" | "POINT" | "BLOCK" | "NONE"
    "donut_inside": 0,
    "donut_outside": 0.5,
    "block_name": "",
    "block_scale": 1,
    "marker_layer": "SURVEY_POINTS",
    "marker_color": 2,
    "text_layer": "SURVEY_LABELS",
    "text_color": 7,
    "text_height": 2.5,
    "text_rotation": 0,
    "boundary_layer": "SURVEY_BOUNDARY",
    "boundary_color": 1,
    "leg_labels": True,              # bearing/distance -TEXT along each boundary leg
    "leg_text_layer": "SURVEY_LEG_LABELS",
    "leg_text_color": 7,
    # "cw_north": rotation value sent to AutoCAD *is* the bearing (0=North,
    # clockwise) -- correct when the drawing's UNITS/Direction Control is
    # set to match survey bearings directly, common on cadastral templates.
    # "ccw_east": AutoCAD's out-of-the-box default (0=East, counterclockwise)
    # -- the bearing is converted so the text still lies along the line.
    "angle_convention": "cw_north",
}


def _coord(point: dict, use_3d: bool) -> str:
    if use_3d and point.get("z") is not None:
        return f"{point['x']:.3f},{point['y']:.3f},{point['z']:.3f}"
    return f"{point['x']:.3f},{point['y']:.3f}"


def _set_layer(lines: list[str], name: str, color: int) -> None:
    lines += ["-LAYER", "M", name, "C", str(color), name, ""]


def _bearing_distance(a: dict, b: dict) -> tuple[float, float]:
    """Whole-circle bearing (degrees, clockwise from North) and 2D horizontal
    distance from point a to point b."""
    dE = b["x"] - a["x"]
    dN = b["y"] - a["y"]
    distance = math.hypot(dE, dN)
    bearing = math.degrees(math.atan2(dE, dN))
    if bearing < 0:
        bearing += 360
    return bearing, distance


def _format_bearing(deg: float) -> str:
    """DDD°MM'SS.S" using AutoCAD's %%d control code for the degree symbol,
    since a literal ° is not reliably rendered by every text style/font."""
    d = int(deg)
    min_float = (deg - d) * 60
    m = int(min_float)
    sec = (min_float - m) * 60
    return f"{d:03d}%%d{m:02d}'{sec:.1f}\""


def _text_rotation(bearing_deg: float, convention: str) -> float:
    """Rotation value to send to AutoCAD's -TEXT command so the label lies
    along a line with this bearing, in whichever angle convention the
    drawing uses.

    `align` is always the true on-screen alignment angle in AutoCAD's
    *default* system (0=East, counterclockwise) -- this is what actually
    determines whether the glyphs would render upside down, regardless of
    which convention we ultimately emit. The upside-down check has to
    include exactly one of the two axis-aligned boundaries (90 and 270),
    not both or neither: excluding both left a due-North leg and the same
    physical line's due-South leg (i.e. the same leg walked in the other
    point order) landing on different, inconsistent orientations even
    though they're the same line. Including only 270 fixes that: North
    stays unflipped (reads bottom-to-top, the drafting-standard way to set
    vertical text) and South flips to match it instead of reading
    top-to-bottom.
    """
    align = (90 - bearing_deg) % 360
    needs_flip = 90 < align <= 270
    rotation = bearing_deg if convention == "cw_north" else align
    if needs_flip:
        rotation = (rotation + 180) % 360
    return rotation


def _rotated_aabb(cx: float, cy: float, w: float, h: float, angle_deg: float) -> tuple[float, float, float, float]:
    """Axis-aligned box enclosing a w x h box centered at (cx,cy) rotated by
    angle_deg -- used to collision-check rotated label text without having
    to reason about rotated rectangles directly."""
    rad = math.radians(angle_deg)
    c, sn = abs(math.cos(rad)), abs(math.sin(rad))
    half_w = (w / 2) * c + (h / 2) * sn
    half_h = (w / 2) * sn + (h / 2) * c
    return (cx - half_w, cy - half_h, cx + half_w, cy + half_h)


def _boxes_overlap(a: tuple, b: tuple) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def _estimate_text_width(text: str, height: float) -> float:
    """No real font metrics available server-side, so approximate using a
    typical CAD proportional-font average character width. AutoCAD's %%d
    control code renders as a single degree-symbol glyph, not three
    characters, so it's counted as one for this estimate."""
    visual_length = len(text.replace("%%d", "d"))
    return visual_length * height * 0.62


def _place_leg_labels(legs: list[tuple[dict, dict]], s: dict, use_3d: bool) -> list[str]:
    """Bearing/distance -TEXT for each (a, b) leg, sliding each label along
    its own line to dodge already-placed labels (including ones from other
    groups/polylines processed earlier) and leaving a label out entirely if
    no clear spot exists on that leg, rather than overlapping it."""
    height = float(s["text_height"])
    pad = max(height * 0.15, 0.01)
    placed_boxes: list[tuple] = []
    commands: list[str] = []

    for a, b in legs:
        bearing, distance = _bearing_distance(a, b)
        dE, dN = b["x"] - a["x"], b["y"] - a["y"]
        length = math.hypot(dE, dN)
        if length < 1e-9:
            continue

        text = f"{_format_bearing(bearing)} / {distance:.2f}m"
        width = _estimate_text_width(text, height)
        align = (90 - bearing) % 360  # true on-screen angle, for sizing the rotated box
        rotation = _text_rotation(bearing, s["angle_convention"])

        ux, uy = dE / length, dN / length
        perp_x, perp_y = -uy, ux

        chosen = None
        # Try both sides of the line (not just one fixed side) at a spread of
        # positions and a couple of offset distances before giving up --
        # a label only needs *a* clear spot near its own leg, not necessarily
        # on the side tried first.
        for offset_mult in (0.8, 1.6):
            for side in (1, -1):
                for t in (0.5, 0.35, 0.65, 0.2, 0.8):
                    mx, my = a["x"] + t * dE, a["y"] + t * dN
                    lx = mx + perp_x * height * offset_mult * side
                    ly = my + perp_y * height * offset_mult * side
                    box = _rotated_aabb(lx, ly, width, height * 1.3, align)
                    padded = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
                    if not any(_boxes_overlap(padded, pb) for pb in placed_boxes):
                        chosen = (lx, ly, padded)
                        break
                if chosen:
                    break
            if chosen:
                break
        if not chosen:
            continue  # nowhere clear near this leg -- leave it out rather than overlap

        lx, ly, box = chosen
        placed_boxes.append(box)
        mz = None
        if use_3d and a.get("z") is not None and b.get("z") is not None:
            mz = (a["z"] + b["z"]) / 2
        label_point = {"x": lx, "y": ly, "z": mz}
        commands += ["-TEXT", _coord(label_point, use_3d and mz is not None),
                     str(s["text_height"]), f"{rotation:.2f}", text]

    return commands


def generate_scr(
    points: list[dict],
    groups: list[dict] | None,
    style: dict | None = None,
    use_3d: bool = False,
) -> str:
    """points: [{id, label, x, y, z}], ordered as the caller wants them drawn.
    `id` must be unique per point (labels alone may repeat, e.g. re-shot
    points in a survey); `label` is only the text drawn on the sheet.
    groups: [{point_ids: [...], closed: bool, layer: str|None, color: int|None}]
    boundary polylines, referencing points by id, drawn in the given order
    (may be empty). A group without its own layer/color falls back to
    style.boundary_layer/boundary_color, so multiple polylines (e.g. a
    general boundary plus a separate PT-only trace) can share one layer or
    each get their own. When style.leg_labels is true (default), every leg
    across all groups gets a bearing/distance -TEXT entity, placed to avoid
    overlapping any other leg label."""
    s = {**DEFAULT_STYLE, **(style or {})}
    groups = groups or []
    lines: list[str] = []

    if points and s["marker_type"] != "NONE":
        _set_layer(lines, s["marker_layer"], s["marker_color"])
        if s["marker_type"] == "DONUT":
            lines += ["DONUT", str(s["donut_inside"]), str(s["donut_outside"])]
            lines += [_coord(p, use_3d) for p in points]
            lines.append("")
        elif s["marker_type"] == "POINT":
            for p in points:
                lines += ["POINT", _coord(p, use_3d)]
        elif s["marker_type"] == "BLOCK" and s["block_name"]:
            for p in points:
                lines += ["-INSERT", s["block_name"], _coord(p, use_3d),
                          str(s["block_scale"]), str(s["block_scale"]), "0"]

    if points:
        _set_layer(lines, s["text_layer"], s["text_color"])
        for p in points:
            lines += ["-TEXT", _coord(p, use_3d), str(s["text_height"]),
                      str(s["text_rotation"]), str(p["label"])]

    if groups:
        by_id = {p["id"]: p for p in points}
        current_layer = None
        all_legs: list[tuple[dict, dict]] = []
        for group in groups:
            group_points = [by_id[pid] for pid in group.get("point_ids", [])
                             if pid in by_id]
            if len(group_points) < 2:
                continue
            layer = group.get("layer") or s["boundary_layer"]
            color = group.get("color") if group.get("color") is not None else s["boundary_color"]
            if layer != current_layer:
                _set_layer(lines, layer, color)
                current_layer = layer
            lines.append("3DPOLY" if use_3d else "PLINE")
            lines += [_coord(p, use_3d) for p in group_points]
            lines.append("C" if group.get("closed") else "")

            if s["leg_labels"]:
                leg_pairs = list(zip(group_points, group_points[1:]))
                if group.get("closed"):
                    leg_pairs.append((group_points[-1], group_points[0]))
                all_legs += leg_pairs

        if all_legs:
            leg_label_lines = _place_leg_labels(all_legs, s, use_3d)
            if leg_label_lines:
                _set_layer(lines, s["leg_text_layer"], s["leg_text_color"])
                lines += leg_label_lines

    if points:
        lines += ["ZOOM", "E"]

    return "\n".join(lines) + "\n"
