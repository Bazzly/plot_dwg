from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import crs as crs_module
import csv_parser
import scr_generator

app = FastAPI(title="plot_dwg")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_csv(file: UploadFile):
    raw = await file.read()
    try:
        df = csv_parser.read_csv(raw)
    except Exception as exc:
        raise HTTPException(400, f"could not parse CSV: {exc}") from exc
    if df.empty:
        raise HTTPException(400, "CSV has no data rows")
    columns = csv_parser.profile_columns(df)
    rows = [
        {"_row_id": f"row-{i}", **row}
        for i, row in enumerate(df.to_dict(orient="records"))
    ]
    return {"columns": columns, "rows": rows, "row_count": len(rows)}


class DetectCrsRequest(BaseModel):
    x_values: list[float]
    y_values: list[float]


@app.post("/api/detect-crs")
def detect_crs(req: DetectCrsRequest):
    return crs_module.guess_crs(req.x_values, req.y_values)


@app.get("/api/crs-presets")
def crs_presets():
    return crs_module.preset_list()


@app.get("/api/crs-lookup")
def crs_lookup(epsg: int):
    try:
        return crs_module.lookup_epsg(epsg)
    except Exception as exc:
        raise HTTPException(404, f"unknown EPSG code {epsg}: {exc}") from exc


class RawPoint(BaseModel):
    id: str
    label: str
    x_raw: str
    y_raw: str
    z_raw: str | None = None


class TransformRequest(BaseModel):
    points: list[RawPoint]
    src_epsg: int
    dst_epsg: int


@app.post("/api/transform")
def transform(req: TransformRequest):
    xs, ys, zs, ids, labels, errors = [], [], [], [], [], []
    for p in req.points:
        try:
            x = csv_parser.parse_coordinate(p.x_raw)
            y = csv_parser.parse_coordinate(p.y_raw)
        except ValueError as exc:
            errors.append({"id": p.id, "label": p.label, "error": str(exc)})
            continue
        z = None
        if p.z_raw:
            try:
                z = float(p.z_raw)
            except ValueError:
                z = None
        xs.append(x)
        ys.append(y)
        zs.append(z)
        ids.append(p.id)
        labels.append(p.label)

    if not xs:
        raise HTTPException(400, "no valid coordinates to transform")

    try:
        transformed = crs_module.transform_points(xs, ys, zs, req.src_epsg, req.dst_epsg)
    except Exception as exc:
        raise HTTPException(400, f"transform failed: {exc}") from exc

    points = [
        {"id": i, "label": lb, "x": x, "y": y, "z": z}
        for i, lb, (x, y, z) in zip(ids, labels, transformed)
    ]
    warning = None
    if req.src_epsg == req.dst_epsg:
        warning = (
            f"Source and target are both EPSG:{req.src_epsg} — this is a no-op "
            "transform; the output is just your input coordinates unchanged."
        )
    return {"points": points, "errors": errors, "warning": warning}


class Group(BaseModel):
    point_ids: list[str]
    closed: bool = False
    layer: str | None = None
    color: int | None = None


class GenerateScrRequest(BaseModel):
    points: list[dict]
    groups: list[Group] = []
    style: dict = {}
    use_3d: bool = False


@app.post("/api/generate-scr", response_class=PlainTextResponse)
def generate_scr(req: GenerateScrRequest):
    groups = [g.model_dump() for g in req.groups]
    text = scr_generator.generate_scr(req.points, groups, req.style, req.use_3d)
    return PlainTextResponse(text, media_type="text/plain")


frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
