"""CSV ingestion: read arbitrary instrument CSVs and parse coordinate values
that may be plain decimal numbers or DMS strings (e.g. 7°18'19.0837")."""
import io
import re

import pandas as pd

DMS_RE = re.compile(
    r"""^\s*
    (?P<sign>[+-])?
    (?P<deg>\d+(?:\.\d+)?)\s*[°d]\s*
    (?:(?P<min>\d+(?:\.\d+)?)\s*['′m]\s*)?
    (?:(?P<sec>\d+(?:\.\d+)?)\s*["″s]\s*)?
    (?P<dir>[NSEWnsew])?
    \s*$""",
    re.VERBOSE,
)


def read_csv(file_bytes: bytes) -> pd.DataFrame:
    """Read a CSV file, tolerant of BOM and stray whitespace in headers."""
    text = file_bytes.decode("utf-8-sig", errors="replace")
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    return df


def parse_dms(value: str) -> float | None:
    """Parse a DMS coordinate string like 7°18'19.0837"S into decimal degrees.
    Returns None if the string doesn't match the DMS pattern."""
    m = DMS_RE.match(value)
    if not m:
        return None
    deg = float(m.group("deg"))
    minutes = float(m.group("min") or 0)
    seconds = float(m.group("sec") or 0)
    decimal = deg + minutes / 60 + seconds / 3600
    if m.group("sign") == "-" or (m.group("dir") or "").upper() in ("S", "W"):
        decimal = -decimal
    return decimal


def parse_coordinate(raw: str) -> float:
    """Parse a coordinate cell as plain decimal or DMS. Raises ValueError
    if the value can't be interpreted as a coordinate."""
    raw = (raw or "").strip()
    if raw == "":
        raise ValueError("empty coordinate value")
    try:
        return float(raw)
    except ValueError:
        pass
    dms = parse_dms(raw)
    if dms is not None:
        return dms
    raise ValueError(f"unrecognized coordinate format: {raw!r}")


def detect_column_format(series: pd.Series, sample_size: int = 10) -> str:
    """Best-effort guess of a column's coordinate format: 'decimal', 'dms',
    or 'unknown' (not a coordinate-looking column at all)."""
    sample = [v for v in series.head(sample_size).tolist() if str(v).strip()]
    if not sample:
        return "unknown"
    decimal_hits = 0
    dms_hits = 0
    for v in sample:
        v = str(v).strip()
        if DMS_RE.match(v):
            dms_hits += 1
            continue
        try:
            float(v)
            decimal_hits += 1
        except ValueError:
            continue
    if dms_hits >= max(1, len(sample) // 2):
        return "dms"
    if decimal_hits >= max(1, len(sample) // 2):
        return "decimal"
    return "unknown"


def profile_columns(df: pd.DataFrame) -> list[dict]:
    """Return per-column metadata to drive the frontend's column mapper."""
    profiles = []
    for col in df.columns:
        series = df[col]
        fmt = detect_column_format(series)
        sample = [v for v in series.head(3).tolist()]
        profiles.append({"name": col, "format": fmt, "sample": sample})
    return profiles
