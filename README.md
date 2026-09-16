# plot_dwg

A local web app that takes raw coordinate CSVs exported from any survey
instrument (GNSS receivers, total stations, etc.), lets you pick which
columns hold the coordinates, transforms them between coordinate reference
systems (CRS), and generates an AutoCAD script (and optionally a DXF) to
plot the points, labels and boundary directly in AutoCAD.

## Why

Instrument exports are inconsistent — column names, coordinate formats
(decimal degrees vs DMS), and CRS all vary between devices and survey
sessions. Two real examples in this repo:

- [`bazeet_abata1.csv`](bazeet_abata1.csv) — GNSS RTK export with
  `Latitude`/`Longitude` in **decimal degrees**, plus a `North`/`East`
  pair that's already projected (Nigerian Transverse Mercator-style
  values, ~807xxx/557xxx).
- [`Alabata_bt.csv`](Alabata_bt.csv) — same instrument family, but
  `Latitude`/`Longitude` are in **DMS** (`7°18′19.0837″`), with its own
  `North`/`East` pair.

Today, turning either of these into an AutoCAD-ready drawing is manual.
[`file.md`](file.md) is a working example of the target output shape: a
CSV whose rows already contain literal AutoCAD script commands —
`point E,N`, `-TEXT E,N height rotation LABEL`, a `DONUT` point marker,
fixed `TEXT HEIGHT 6`. This app generalizes and parameterizes that
pattern so it works for any instrument's CSV, not just one hand-built
file.

## Workflow

1. **Upload** one or more instrument CSVs.
2. **Map columns** — tell the app which column is the point name/label,
   which columns hold the coordinates (a single Lat/Long pair, a
   North/East pair, or both), and which (if any) holds elevation.
   Decimal-degree and DMS formats are both auto-detected and parsed.
3. **Confirm source CRS** — the app inspects the selected coordinate
   column's value ranges and pre-selects a likely CRS (e.g. values in
   `-180..180` → geographic; values in the 500,000s/700,000s–800,000s →
   a Nigerian Minna belt). You always confirm or override this guess
   before anything is transformed — several Nigerian projected CRSs
   have overlapping value ranges, so silent auto-detection is not
   trusted on its own.
4. **Pick target CRS** — choose from curated Nigerian presets or search
   the full EPSG database for anything else.
5. **Arrange points** — a personalized, per-run setup:
   - Drag-and-drop to reorder points (the order drives any boundary
     polyline), independent of CSV row order.
   - Optionally group points (e.g. by a `code`/`group` column, or
     manually) into multiple separate boundaries/polylines in one run.
   - Toggle a boundary polyline on/off per group — not every CSV is a
     closed boundary (topo points, centerlines, etc. may just need
     points + labels).
   - Toggle 2D or 3D: 2D uses X,Y only (matches `file.md`); 3D uses the
     selected elevation column as Z for points and polyline vertices.
     Both are available per run.
6. **Configure output styling** — layer name, point marker (DONUT,
   POINT, or custom block), text height, text color/layer — instead of
   the fixed values baked into `file.md`.
7. **Generate** — download an AutoCAD `.scr` script to run inside
   AutoCAD, and/or a `.dxf` file written directly (no script execution
   needed).

## Features

- CSV ingestion for arbitrary/unknown column layouts, any instrument.
- Decimal-degree and DMS coordinate parsing.
- CRS auto-detection from value ranges, with mandatory user confirmation.
- Curated Nigerian CRS presets, backed by a full EPSG search for anything
  else:
  - `EPSG:4326` — WGS84 (geographic)
  - `EPSG:4263` — Minna (geographic)
  - `EPSG:26331` / `26332` / `26333` — Minna / Nigeria West, Mid, East Belt
  - `EPSG:32631` / `32632` — WGS84 / UTM zone 31N / 32N
  - `EPSG:26391` / `26392` — Minna / UTM zone 31N / 32N
- Accurate transforms via `pyproj` (full EPSG/PROJ database, not a
  hardcoded formula).
- Interactive point arrangement: drag-and-drop reorder, multi-group
  boundaries, per-group polyline toggle, 2D/3D toggle.
- Parameterized AutoCAD `.scr` generation (layer, marker, text style).
- Optional direct `.dxf` export via `ezdxf`.

## Tech stack (proposed)

- **Backend:** Python, FastAPI, `pandas` (CSV parsing), `pyproj` (CRS
  transforms), `ezdxf` (DXF export).
- **Frontend:** a plain multi-page browser UI served locally — one real
  HTML page per stage (upload → map columns → confirm CRS → arrange
  points → style/generate), each its own URL/history entry, with an
  animated progress stepper shared across all of them. No framework/build
  step; state (uploaded rows, mapping, CRS choice, point order, style
  fields) is carried between pages via `localStorage`, so navigating,
  refreshing, or coming back later resumes exactly where you left off.
- Runs entirely locally; no data leaves the machine.

## Project structure

```
plot_dwg/
├── backend/
│   ├── main.py            # FastAPI app (serves the API + the frontend as static files)
│   ├── csv_parser.py      # column detection, DMS/decimal parsing
│   ├── crs.py             # CRS presets, auto-detection, pyproj transforms
│   ├── scr_generator.py   # .scr script builder (parameterized)
│   └── dxf_generator.py   # ezdxf-based .dxf builder (phase 3, not yet built)
├── frontend/
│   ├── index.html         # stage 1: upload
│   ├── columns.html       # stage 2: map columns
│   ├── crs.html           # stage 3: confirm CRS + transform
│   ├── arrange.html       # stage 4: drag-arrange points/boundary, download CSV
│   ├── style.html         # stage 5: output styling + generate/download .scr
│   ├── app.js             # shared state, persistence, stepper, and per-page logic
│   └── style.css          # shared styling, incl. the animated stepper
├── bazeet_abata1.csv       # sample instrument export (decimal degrees)
├── Alabata_bt.csv          # sample instrument export (DMS)
├── file.md                 # reference: original hand-built .scr-style output
└── README.md
```

## Running it (Phase 1 MVP)

```
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8420 --host 127.0.0.1
```

Then open http://127.0.0.1:8420 — the same server serves the frontend
and the API, so there's nothing else to run. Upload a CSV, map columns,
confirm the CRS, drag-arrange points, set styling, and download the
generated `.scr`.

**Known finding from testing:** the two sample CSVs' own precomputed
`North`/`East` columns don't match any standard EPSG CRS tested (off by
13-23 km, consistently, against WGS84/Minna UTM 31N) — this looks like a
local/site-calibrated grid, which is a common RTK-GNSS localization
result, not a globally registered CRS. For real transforms with these
files, map from `Latitude`/`Longitude` instead; the CRS-confirm step
surfaces a warning when a column's values don't fit any curated preset
well.

## Roadmap

- **Phase 1 (MVP) — done:** upload → column mapping → CRS confirm →
  transform → drag-arrange points/boundary → styled `.scr` export.
  Verified end-to-end against both sample CSVs (decimal-degree and DMS
  formats).
- **Phase 2 — mostly done:** drag-and-drop point reordering, per-point
  boundary include/exclude toggle, 2D/3D toggle, configurable
  layer/marker/text styling. Still open: multiple independent boundary
  groups in one run (currently one boundary group per run).
- **Phase 3 — not started:** direct DXF export, saved styling presets,
  multi-file batch runs.

## Open questions

- Exact list of point-marker options to expose beyond DONUT (block
  reference upload?).
- Whether to persist per-user CRS/styling presets across sessions, or
  keep every run fully self-contained.
