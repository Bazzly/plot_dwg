const API = "/api";
const $ = (id) => document.getElementById(id);

const state = {
  columns: [],
  rows: [],
  mapping: { label: null, mode: "latlong", x: null, y: null, z: null },
  presets: [],
  crsGuess: null,
  srcCrsGuessId: null,   // preset id guessed on columns.html, applied on crs.html
  crsGuessNote: null,    // explanatory text for the guess, shown on crs.html
  srcEpsg: null,
  dstEpsg: null,
  transformed: [],       // [{id,label,x,y,z}] in arranged order
  included: new Set(),   // ids included in boundary polyline
  showCoords: new Set(), // ids labeled with their coordinates on the traverse preview (besides start/diagonal)
  maxStage: 1,           // furthest stage the user has unlocked, for the stepper
  fields: {},            // last known value of every FIELD_IDS input, across all pages visited
  ptBoundaryOrder: [],       // ids, user-orderable/prunable order for the PT-only boundary polyline
  ptBoundaryInitialized: false, // becomes true once ptBoundaryOrder has been auto- or manually populated
};

const STAGES = [
  { n: 1, label: "Upload", href: "index.html" },
  { n: 2, label: "Map Columns", href: "columns.html" },
  { n: 3, label: "Confirm CRS", href: "crs.html" },
  { n: 4, label: "Arrange Points", href: "arrange.html" },
  { n: 5, label: "Style & Generate", href: "style.html" },
];

function goTo(href) {
  saveState();
  location.href = href;
}

function advanceTo(stageNum, href) {
  state.maxStage = Math.max(state.maxStage || 1, stageNum);
  goTo(href);
}

// ---- animated stage stepper (present on every page as <div id="stepper">) ----
function renderStepper() {
  const container = $("stepper");
  if (!container) return;
  const current = parseInt(document.body.dataset.stage || "1", 10);
  const maxStage = state.maxStage || 1;

  let html = `<div class="stepper-track"><div class="stepper-fill" id="stepper-fill"></div></div><ol class="stepper-list">`;
  STAGES.forEach((s) => {
    const status = s.n < current ? "done" : s.n === current ? "active" : "upcoming";
    const clickable = s.n <= maxStage && s.n !== current;
    html += `<li class="stepper-item ${status}${clickable ? " clickable" : ""}" data-href="${s.href}">
      <span class="stepper-dot">${status === "done" ? "&#10003;" : s.n}</span>
      <span class="stepper-label">${s.label}</span>
    </li>`;
  });
  html += "</ol>";
  container.innerHTML = html;

  container.querySelectorAll(".stepper-item.clickable").forEach((li) => {
    li.addEventListener("click", () => goTo(li.dataset.href));
  });

  const pct = ((current - 1) / (STAGES.length - 1)) * 100;
  requestAnimationFrame(() => {
    const fill = $("stepper-fill");
    if (fill) fill.style.width = `${pct}%`;
  });
}

// ---- client-side coordinate parsing (mirrors backend csv_parser.py) ----
const DMS_RE = /^\s*([+-])?(\d+(?:\.\d+)?)\s*[°d]\s*(?:(\d+(?:\.\d+)?)\s*['′m]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]\s*)?([NSEWnsew])?\s*$/;

function parseCoordinate(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  const asNum = Number(v);
  if (!Number.isNaN(asNum) && v !== "") return asNum;
  const m = DMS_RE.exec(v);
  if (!m) return null;
  const deg = parseFloat(m[2]);
  const min = parseFloat(m[3] || "0");
  const sec = parseFloat(m[4] || "0");
  let dec = deg + min / 60 + sec / 3600;
  const dir = (m[5] || "").toUpperCase();
  if (m[1] === "-" || dir === "S" || dir === "W") dec = -dec;
  return dec;
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Point-name prefix convention (PT = boundary/plot point, ST = stream, RD = road).
// Only PT-prefixed points count as boundary by default — everything else is a
// different kind of survey point that happens to be in the same CSV.
function classifyPointType(label) {
  const s = (label || "").trim().toUpperCase();
  if (s.startsWith("PT")) return { code: "PT", name: "Boundary", boundary: true };
  if (s.startsWith("ST")) return { code: "ST", name: "Stream", boundary: false };
  if (s.startsWith("RD")) return { code: "RD", name: "Road", boundary: false };
  return { code: "—", name: "Other", boundary: false };
}

function autoSelectBoundaryByName() {
  state.included = new Set(state.transformed.filter((p) => classifyPointType(p.label).boundary).map((p) => p.id));
}

// ---- PT-only boundary polyline: points that are PT-classified AND still
// ticked "boundary" on the Arrange page, with their own user-adjustable
// order/membership independent of that general boundary set. ----
function eligiblePtBoundaryPoints() {
  return state.transformed.filter((p) => classifyPointType(p.label).boundary && state.included.has(p.id));
}

function resetPtBoundaryOrder() {
  state.ptBoundaryOrder = eligiblePtBoundaryPoints().map((p) => p.id);
  state.ptBoundaryInitialized = true;
}

let ptBoundaryDragId = null;

function renderPtBoundaryList() {
  const ul = $("pt-boundary-list");
  const resetBtn = $("btn-pt-boundary-reset");
  if (!ul) return;
  const enabled = $("opt-pt-boundary").checked;
  ul.hidden = !enabled;
  if (resetBtn) resetBtn.hidden = !enabled;
  if (!enabled) return;

  // Points unticked "boundary" on Arrange (or no longer PT-classified) are
  // dropped here automatically — this list can never include them.
  const eligibleIds = new Set(eligiblePtBoundaryPoints().map((p) => p.id));
  state.ptBoundaryOrder = state.ptBoundaryOrder.filter((id) => eligibleIds.has(id));
  if (!state.ptBoundaryInitialized) resetPtBoundaryOrder();

  const byId = new Map(state.transformed.map((p) => [p.id, p]));
  ul.innerHTML = "";
  state.ptBoundaryOrder.forEach((id) => {
    const p = byId.get(id);
    if (!p) return;
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = id;
    li.innerHTML = `
      <span class="handle">&#9776;</span>
      <span class="label">${escapeHtml(p.label)}</span>
      <button type="button" class="btn-remove" title="Remove from this polyline">&times;</button>
    `;
    li.querySelector(".btn-remove").addEventListener("click", () => {
      state.ptBoundaryOrder = state.ptBoundaryOrder.filter((x) => x !== id);
      renderPtBoundaryList();
      saveState();
    });
    li.addEventListener("dragstart", () => { ptBoundaryDragId = id; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (ptBoundaryDragId === null || ptBoundaryDragId === id) return;
      const fromIdx = state.ptBoundaryOrder.indexOf(ptBoundaryDragId);
      const toIdx = state.ptBoundaryOrder.indexOf(id);
      const [moved] = state.ptBoundaryOrder.splice(fromIdx, 1);
      state.ptBoundaryOrder.splice(toIdx, 0, moved);
      renderPtBoundaryList();
      saveState();
    });
    ul.appendChild(li);
  });
  if (!state.ptBoundaryOrder.length) {
    ul.innerHTML = '<li class="hint" style="cursor:default;">No PT points are currently ticked "boundary" on the Arrange page.</li>';
  }
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- shared UI builders (each a no-op if its page doesn't have the element) ----
function populateColumnStep() {
  if (!$("col-label")) return;
  const names = state.columns.map((c) => c.name);
  const fill = (el, includeNone) => {
    el.innerHTML = "";
    if (includeNone) el.appendChild(new Option("(none)", ""));
    names.forEach((n) => el.appendChild(new Option(n, n)));
  };
  fill($("col-label"), false);
  fill($("col-x"), false);
  fill($("col-y"), false);
  fill($("col-z"), true);

  const guess = (patterns) => names.find((n) => patterns.some((p) => n.toLowerCase().includes(p)));
  $("col-label").value = guess(["point name", "name", "label", "id"]) || names[0];
  const lonGuess = guess(["longitude", "long", "east"]);
  const latGuess = guess(["latitude", "lat", "north"]);
  if (lonGuess) $("col-x").value = lonGuess;
  if (latGuess) $("col-y").value = latGuess;
  const elevGuess = guess(["elevation", "ellipsoidal height", "height"]);
  if (elevGuess) $("col-z").value = elevGuess;

  renderPreviewTable();
}

function renderPreviewTable() {
  const table = $("preview-table");
  if (!table) return;
  const names = state.columns.map((c) => c.name);
  const sampleRows = state.rows.slice(0, 5);
  let html = "<tr>" + names.map((n) => `<th>${escapeHtml(n)}</th>`).join("") + "</tr>";
  for (const row of sampleRows) {
    html += "<tr>" + names.map((n) => `<td>${escapeHtml(row[n])}</td>`).join("") + "</tr>";
  }
  table.innerHTML = html;
}

function updateCoordModeLabels() {
  if (!$("coord-mode")) return;
  const mode = $("coord-mode").value;
  $("lbl-x").firstChild.textContent = mode === "latlong" ? "Longitude (X) column" : "Easting / North-col value (X) column";
  $("lbl-y").firstChild.textContent = mode === "latlong" ? "Latitude (Y) column" : "Northing / East-col value (Y) column";
}

function fillCrsSelects() {
  if (!$("src-crs")) return;
  const fill = (el) => {
    el.innerHTML = "";
    state.presets.forEach((p) => el.appendChild(new Option(`${p.label} (EPSG:${p.epsg})`, p.id)));
  };
  fill($("src-crs"));
  // Target has no auto-guess, and its list is in the same order as source's
  // (WGS84 first) — defaulting it to the first option would silently select
  // the same CRS as the source, producing a no-op "conversion" that just
  // echoes the input back. Force an explicit choice instead.
  fill($("dst-crs"));
  $("dst-crs").insertBefore(new Option("— select target CRS —", ""), $("dst-crs").firstChild);
  $("dst-crs").value = "";
}

function resolveEpsg(selectEl, customEl) {
  const custom = customEl.value.trim();
  if (custom) return parseInt(custom, 10);
  const preset = state.presets.find((p) => p.id === selectEl.value);
  return preset ? preset.epsg : null;
}

let dragSrcId = null;
let pointFilterText = "";

function movePoint(id, delta) {
  const idx = state.transformed.findIndex((p) => p.id === id);
  const newIdx = idx + delta;
  if (idx === -1 || newIdx < 0 || newIdx >= state.transformed.length) return;
  const [moved] = state.transformed.splice(idx, 1);
  state.transformed.splice(newIdx, 0, moved);
  renderPointList();
  saveState();
}

function applyPointFilter() {
  const q = pointFilterText.trim().toLowerCase();
  $("point-list").querySelectorAll("li").forEach((li) => {
    li.hidden = q !== "" && !li.dataset.label.includes(q);
  });
}

function renderPointList() {
  const ul = $("point-list");
  if (!ul) return;
  ul.innerHTML = "";
  state.transformed.forEach((p, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = p.id;
    li.dataset.label = p.label.toLowerCase();
    const zTxt = p.z !== null && p.z !== undefined ? `, z=${p.z.toFixed(3)}` : "";
    const type = classifyPointType(p.label);
    li.innerHTML = `
      <span class="handle">&#9776;</span>
      <span class="reorder-btns">
        <button type="button" class="btn-up" ${i === 0 ? "disabled" : ""} title="Move up">&#9650;</button>
        <button type="button" class="btn-down" ${i === state.transformed.length - 1 ? "disabled" : ""} title="Move down">&#9660;</button>
      </span>
      <span class="type-badge type-${type.code === "—" ? "other" : type.code.toLowerCase()}" title="${type.name} (name starts with \"${type.code}\")">${type.code}</span>
      <span class="toggle-group"><input type="checkbox" class="include-toggle" ${state.included.has(p.id) ? "checked" : ""} title="Include in boundary" />boundary</span>
      <span class="toggle-group"><input type="checkbox" class="showcoords-toggle" ${state.showCoords.has(p.id) ? "checked" : ""} title="Label coordinates on traverse preview" />coords</span>
      <span class="label">${escapeHtml(p.label)}</span>
      <span class="coords">x=${p.x.toFixed(3)}, y=${p.y.toFixed(3)}${zTxt}</span>
    `;
    li.querySelector(".include-toggle").addEventListener("change", (e) => {
      if (e.target.checked) state.included.add(p.id);
      else state.included.delete(p.id);
      saveState();
      renderTraversePreview();
    });
    li.querySelector(".showcoords-toggle").addEventListener("change", (e) => {
      if (e.target.checked) state.showCoords.add(p.id);
      else state.showCoords.delete(p.id);
      saveState();
      renderTraversePreview();
    });
    li.querySelector(".btn-up").addEventListener("click", () => movePoint(p.id, -1));
    li.querySelector(".btn-down").addEventListener("click", () => movePoint(p.id, 1));
    li.addEventListener("dragstart", () => { dragSrcId = p.id; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragSrcId === null || dragSrcId === p.id) return;
      const fromIdx = state.transformed.findIndex((x) => x.id === dragSrcId);
      const toIdx = state.transformed.findIndex((x) => x.id === p.id);
      const [moved] = state.transformed.splice(fromIdx, 1);
      state.transformed.splice(toIdx, 0, moved);
      renderPointList();
      saveState();
    });
    ul.appendChild(li);
  });

  applyPointFilter();
  populateTraverseSelects();
  renderTraversePreview();
}

// ---- arrange-page toolbar: filter, bulk boundary actions, quick sorts, name-order tool ----
if ($("point-filter")) {
  $("point-filter").addEventListener("input", (e) => {
    pointFilterText = e.target.value;
    applyPointFilter();
  });
}

if ($("btn-auto-select-pt")) {
  $("btn-auto-select-pt").addEventListener("click", () => {
    autoSelectBoundaryByName();
    renderPointList();
    saveState();
  });
}
if ($("btn-boundary-all")) {
  $("btn-boundary-all").addEventListener("click", () => {
    state.included = new Set(state.transformed.map((p) => p.id));
    renderPointList();
    saveState();
  });
}
if ($("btn-boundary-none")) {
  $("btn-boundary-none").addEventListener("click", () => {
    state.included = new Set();
    renderPointList();
    saveState();
  });
}
if ($("btn-boundary-invert")) {
  $("btn-boundary-invert").addEventListener("click", () => {
    const inverted = new Set();
    state.transformed.forEach((p) => { if (!state.included.has(p.id)) inverted.add(p.id); });
    state.included = inverted;
    renderPointList();
    saveState();
  });
}
if ($("btn-sort-name")) {
  $("btn-sort-name").addEventListener("click", () => {
    state.transformed.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    renderPointList();
    saveState();
  });
}
if ($("btn-sort-original")) {
  $("btn-sort-original").addEventListener("click", () => {
    state.transformed.sort((a, b) => {
      const na = parseInt(String(a.id).replace(/\D/g, ""), 10);
      const nb = parseInt(String(b.id).replace(/\D/g, ""), 10);
      return na - nb;
    });
    renderPointList();
    saveState();
  });
}
if ($("btn-reverse-order")) {
  $("btn-reverse-order").addEventListener("click", () => {
    state.transformed.reverse();
    renderPointList();
    saveState();
  });
}

if ($("btn-apply-name-order")) {
  $("btn-apply-name-order").addEventListener("click", () => {
    const raw = $("order-by-name-input").value;
    const wanted = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) {
      $("order-by-name-status").textContent = "Type or paste at least one point name.";
      return;
    }
    const pool = [...state.transformed]; // consumed as matches are found
    const newOrder = [];
    const notFound = [];
    wanted.forEach((name) => {
      const idx = pool.findIndex((p) => p.label.toLowerCase() === name.toLowerCase());
      if (idx === -1) {
        notFound.push(name);
        return;
      }
      newOrder.push(pool.splice(idx, 1)[0]);
    });
    // anything not mentioned keeps its relative order, appended at the end
    newOrder.push(...pool);
    state.transformed = newOrder;
    renderPointList();
    saveState();
    $("order-by-name-status").textContent = notFound.length
      ? `Applied. ${notFound.length} name(s) not found and skipped: ${notFound.join(", ")}`
      : `Applied — ${wanted.length} point(s) placed in the order you gave.`;
  });
}

// ---- traverse selects (starting / diagonal point) ----
function populateTraverseSelects() {
  const startEl = $("traverse-start");
  const diagEl = $("traverse-diagonal");
  if (!startEl || !diagEl) return;
  const prevStart = startEl.value;
  const prevDiag = diagEl.value;
  startEl.innerHTML = "";
  diagEl.innerHTML = "";
  diagEl.appendChild(new Option("(none)", ""));
  state.transformed.forEach((p) => {
    startEl.appendChild(new Option(p.label, p.id));
    diagEl.appendChild(new Option(p.label, p.id));
  });
  if (prevStart && state.transformed.some((p) => p.id === prevStart)) startEl.value = prevStart;
  else if (state.transformed.length) startEl.value = state.transformed[0].id;
  if (prevDiag && state.transformed.some((p) => p.id === prevDiag)) diagEl.value = prevDiag;
}

// ---- bearing & distance (whole-circle bearing, clockwise from North, 2D horizontal) ----
function bearingDistance(from, to) {
  const dE = to.x - from.x;
  const dN = to.y - from.y;
  const distance = Math.sqrt(dE * dE + dN * dN);
  let bearingDeg = (Math.atan2(dE, dN) * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  return { distance, bearingDeg };
}

function formatBearing(deg) {
  const d = Math.floor(deg);
  const minFloat = (deg - d) * 60;
  const m = Math.floor(minFloat);
  const s = (minFloat - m) * 60;
  return `${String(d).padStart(3, "0")}° ${String(m).padStart(2, "0")}' ${s.toFixed(1)}"`;
}

// SVG's rotate() is clockwise-positive in screen space (Y grows downward),
// which is the same convention as a whole-circle bearing (clockwise from
// North) — so a line's on-screen angle, converted this way, both aligns
// label text with the line AND tracks its true bearing direction. Flipped
// 180° on the "return" half so text is never drawn upside down.
function lineRotationDeg(ax, ay, bx, by) {
  let angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  const norm = ((angle % 360) + 360) % 360;
  if (norm > 90 && norm < 270) angle += 180;
  return angle;
}

// Surveyor's / shoelace formula, 2D horizontal area of a closed polygon.
function polygonArea(points) {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// Axis-aligned bounding box that encloses a w×h box centered at (cx,cy) and
// rotated by angleDeg — used to collision-check rotated leg-label text
// without needing to reason about rotated rectangles directly.
function rotatedAABB(cx, cy, w, h, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const halfW = (w / 2) * c + (h / 2) * s;
  const halfH = (w / 2) * s + (h / 2) * c;
  return { x1: cx - halfW, x2: cx + halfW, y1: cy - halfH, y2: cy + halfH };
}

// Position each leg's bearing/distance label, sliding it along its own line
// (not just sitting dead-center) to dodge already-placed labels; if no spot
// on the line is clear, hide that one label rather than let it overlap —
// the figure stays in the table below either way. Runs before point labels
// so point labels also treat visible leg labels as obstacles to avoid.
function layoutLegLabels(svgContainer) {
  const groups = [...svgContainer.querySelectorAll(".trav-legline")];
  const placed = [];
  const PAD = 2;
  const HEIGHT = 11;

  groups.forEach((g) => {
    const ax = parseFloat(g.dataset.ax), ay = parseFloat(g.dataset.ay);
    const bx = parseFloat(g.dataset.bx), by = parseFloat(g.dataset.by);
    const textEl = g.querySelector("text");
    let width = 70;
    try {
      width = textEl.getComputedTextLength() || width;
    } catch (err) {
      // text metrics unavailable — keep estimate
    }
    const rot = lineRotationDeg(ax, ay, bx, by);

    let chosenBox = null, chosenPos = null;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const lcx = ax + t * (bx - ax);
      const lcy = ay + t * (by - ay);
      const box = rotatedAABB(lcx, lcy, width, HEIGHT, rot);
      const padded = { x1: box.x1 - PAD, y1: box.y1 - PAD, x2: box.x2 + PAD, y2: box.y2 + PAD };
      const overlaps = placed.some((pb) => !(padded.x2 < pb.x1 || padded.x1 > pb.x2 || padded.y2 < pb.y1 || padded.y1 > pb.y2));
      if (!overlaps) { chosenBox = padded; chosenPos = { x: lcx, y: lcy }; break; }
    }

    if (!chosenPos) {
      g.style.display = "none"; // no clear spot on this line — leave it out, it's still in the table
      return;
    }
    textEl.setAttribute("x", chosenPos.x.toFixed(1));
    textEl.setAttribute("y", chosenPos.y.toFixed(1));
    textEl.setAttribute("text-anchor", "middle");
    g.setAttribute("transform", `rotate(${rot.toFixed(2)} ${chosenPos.x.toFixed(1)} ${chosenPos.y.toFixed(1)})`);
    placed.push(chosenBox);
  });

  return placed;
}

// Greedy label placement: try 4 close candidate positions per label
// (right/left/above/below the point) using the label's *actual* rendered
// text width (via getComputedTextLength, so it's exact, not estimated).
// If all 4 are already taken, escalate to a widening ring of "callout"
// positions further from the point, and draw a thin leader line with an
// arrowhead from that relocated label back to the point it describes —
// same technique used on printed survey/cadastral plans for crowded labels.
// Runs after the SVG is in the live DOM so text metrics are real.
function resolveLabelOverlaps(svgContainer, seedPlaced) {
  const groups = [...svgContainer.querySelectorAll(".trav-label")];
  const placed = seedPlaced ? [...seedPlaced] : [];
  const leaders = [];
  const PAD = 2;
  const fits = (c) => {
    const box = { x1: c.x1 - PAD, y1: c.y1 - PAD, x2: c.x2 + PAD, y2: c.y2 + PAD };
    return !placed.some((pb) => !(box.x2 < pb.x1 || box.x1 > pb.x2 || box.y2 < pb.y1 || box.y1 > pb.y2));
  };

  groups.forEach((g) => {
    const cx = parseFloat(g.dataset.cx);
    const cy = parseFloat(g.dataset.cy);
    const nameEl = g.children[0];
    const coordEl = g.children.length > 1 ? g.children[1] : null; // absent for name-only labels
    let nameWidth = 40, coordWidth = 0;
    try {
      nameWidth = nameEl.getComputedTextLength() || nameWidth;
      if (coordEl) coordWidth = coordEl.getComputedTextLength() || 60;
    } catch (err) {
      // text metrics unavailable (e.g. non-browser test env) — keep estimates
      if (coordEl) coordWidth = 60;
    }
    const width = Math.max(nameWidth, coordWidth);

    // Two-line (name + coords) labels need a taller box than name-only ones.
    const makeCandidate = (anchor, lcx, lcy) => {
      const nameY = coordEl ? lcy - 8 : lcy + 3;
      const coordY = coordEl ? lcy + 7 : null;
      const y1 = nameY - 9;
      const y2 = coordEl ? coordY + 3 : nameY + 3;
      const x1 = anchor === "start" ? lcx : anchor === "end" ? lcx - width : lcx - width / 2;
      const x2 = anchor === "start" ? lcx + width : anchor === "end" ? lcx : lcx + width / 2;
      return { anchor, nameX: lcx, nameY, coordX: lcx, coordY, x1, x2, y1, y2 };
    };

    const closeCandidates = [
      makeCandidate("start", cx + 8, coordEl ? cy - 0.5 : cy),   // right (default)
      makeCandidate("end", cx - 8, coordEl ? cy - 0.5 : cy),     // left
      makeCandidate("middle", cx, coordEl ? cy - 10 : cy - 9),   // above
      makeCandidate("middle", cx, coordEl ? cy + 22 : cy + 9),   // below
    ];

    let chosen = closeCandidates.find(fits);
    let isCallout = false;

    if (!chosen) {
      const angles = [0, 45, 90, 135, 180, 225, 270, 315, 22, 158, 202, 338];
      searchRings:
      for (const radius of [30, 46, 64, 84, 106]) {
        for (const angleDeg of angles) {
          const rad = (angleDeg * Math.PI) / 180;
          const lcx = cx + radius * Math.cos(rad);
          const lcy = cy + radius * Math.sin(rad);
          const anchor = Math.cos(rad) > 0.35 ? "start" : Math.cos(rad) < -0.35 ? "end" : "middle";
          const cand = makeCandidate(anchor, lcx, lcy);
          if (fits(cand)) { chosen = cand; isCallout = true; break searchRings; }
        }
      }
    }
    if (!chosen) chosen = closeCandidates[0]; // extremely rare: nowhere is clear

    nameEl.setAttribute("x", chosen.nameX.toFixed(1));
    nameEl.setAttribute("y", chosen.nameY.toFixed(1));
    nameEl.setAttribute("text-anchor", chosen.anchor);
    if (coordEl) {
      coordEl.setAttribute("x", chosen.coordX.toFixed(1));
      coordEl.setAttribute("y", chosen.coordY.toFixed(1));
      coordEl.setAttribute("text-anchor", chosen.anchor);
    }
    placed.push({ x1: chosen.x1 - PAD, y1: chosen.y1 - PAD, x2: chosen.x2 + PAD, y2: chosen.y2 + PAD });

    if (isCallout) {
      // leader line from the nearest edge of the relocated label box back to the point
      const ex = Math.min(Math.max(cx, chosen.x1), chosen.x2);
      const ey = Math.min(Math.max(cy, chosen.y1), chosen.y2);
      leaders.push({ x1: ex, y1: ey, x2: cx, y2: cy });
    }
  });

  if (leaders.length) drawLeaderLines(svgContainer, leaders);
}

function drawLeaderLines(svgContainer, leaders) {
  const ns = "http://www.w3.org/2000/svg";
  const svgEl = svgContainer.querySelector("svg");
  let defs = svgEl.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svgEl.insertBefore(defs, svgEl.firstChild);
  }
  if (!defs.querySelector("#trav-leader-arrow")) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "trav-leader-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8.5");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M0,0 L10,5 L0,10 Z");
    path.setAttribute("class", "trav-leader-arrowhead");
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  const firstLabel = svgEl.querySelector(".trav-label");
  leaders.forEach((l) => {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", l.x1.toFixed(1));
    line.setAttribute("y1", l.y1.toFixed(1));
    line.setAttribute("x2", l.x2.toFixed(1));
    line.setAttribute("y2", l.y2.toFixed(1));
    line.setAttribute("class", "trav-leader");
    line.setAttribute("marker-end", "url(#trav-leader-arrow)");
    svgEl.insertBefore(line, firstLabel);
  });
}

// ---- closing traverse preview: SVG diagram + bearing/distance table ----
function renderTraversePreview() {
  const svgContainer = $("traverse-svg");
  const table = $("traverse-table");
  const stats = $("traverse-stats");
  const pointsTable = $("traverse-points-table");
  if (!svgContainer || !table) return;

  const included = state.transformed.filter((p) => state.included.has(p.id));
  if (included.length < 2) {
    svgContainer.innerHTML = '<p class="hint" style="margin:12px;">Include at least 2 points in the boundary to preview the traverse.</p>';
    table.innerHTML = "";
    if (stats) stats.innerHTML = "";
    if (pointsTable) pointsTable.innerHTML = "";
    return;
  }

  const startId = $("traverse-start") ? $("traverse-start").value : "";
  const diagId = $("traverse-diagonal") ? $("traverse-diagonal").value : "";
  const startPoint = state.transformed.find((p) => p.id === startId) || included[0];
  const diagPoint = diagId ? state.transformed.find((p) => p.id === diagId) : null;
  const closed = $("opt-closed") ? $("opt-closed").checked : true;

  const xs = included.map((p) => p.x);
  const ys = included.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = 640, h = 440, pad = 44;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const toSvg = (p) => [
    pad + (p.x - minX) * scale,
    h - pad - (p.y - minY) * scale, // flip Y so North points up
  ];

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="traverse-drawing" xmlns="http://www.w3.org/2000/svg">`;

  const pathPts = included.map(toSvg);
  let pathD = pathPts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  if (closed) pathD += " Z";
  svg += `<path d="${pathD}" class="trav-boundary" />`;

  // Leg labels are emitted as placeholder groups (geometry only, via data-*
  // attributes) and text is added/positioned later by layoutLegLabels() —
  // combining bearing+distance onto one line and sliding/skipping labels
  // that would overlap, instead of drawing every one at a fixed spot.
  const legs = [];
  const legCount = included.length - (closed ? 0 : 1);
  for (let i = 0; i < legCount; i++) {
    const a = included[i];
    const b = included[(i + 1) % included.length];
    const bd = bearingDistance(a, b);
    legs.push({ from: a, to: b, ...bd });
    const [ax, ay] = toSvg(a);
    const [bx, by] = toSvg(b);
    const text = `${formatBearing(bd.bearingDeg)} / ${bd.distance.toFixed(2)}m`;
    svg += `<g class="trav-legline" data-ax="${ax}" data-ay="${ay}" data-bx="${bx}" data-by="${by}"><text class="trav-leg-label">${text}</text></g>`;
  }

  let diagonalLeg = null;
  if (diagPoint && startPoint.id !== diagPoint.id) {
    const [ax, ay] = toSvg(startPoint);
    const [bx, by] = toSvg(diagPoint);
    svg += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="trav-diagonal" />`;
    diagonalLeg = { from: startPoint, to: diagPoint, ...bearingDistance(startPoint, diagPoint) };
    const dtext = `${formatBearing(diagonalLeg.bearingDeg)} / ${diagonalLeg.distance.toFixed(2)}m`;
    svg += `<g class="trav-legline" data-ax="${ax}" data-ay="${ay}" data-bx="${bx}" data-by="${by}"><text class="trav-leg-label trav-diagonal-label">${dtext}</text></g>`;
  }

  const isStartPt = (p) => p.id === startPoint.id;
  const isDiagPt = (p) => diagPoint && p.id === diagPoint.id;

  // Circles for every included point (unselected ones are unlabeled markers).
  included.forEach((p) => {
    const [x, y] = toSvg(p);
    const cls = isStartPt(p) ? "trav-pt trav-pt-start" : isDiagPt(p) ? "trav-pt trav-pt-diag" : "trav-pt";
    svg += `<circle cx="${x}" cy="${y}" r="${isStartPt(p) || isDiagPt(p) ? 6 : 4}" class="${cls}" />`;
  });

  // Every included (boundary) point gets its NAME shown — names matter enough
  // that hiding them isn't the right tradeoff. Coordinates are still opt-in
  // (start / diagonal / ticked "coords") since they're a lot more text to fit.
  // Start/diagonal go first so they claim the best slots; drawn as placeholder
  // groups here and repositioned by resolveLabelOverlaps() once they're in the
  // live DOM and real text metrics are available.
  const withCoords = included.filter((p) => isStartPt(p) || isDiagPt(p) || state.showCoords.has(p.id));
  const labelOrder = [...included].sort(
    (a, b) => (isStartPt(a) ? 0 : isDiagPt(a) ? 1 : 2) - (isStartPt(b) ? 0 : isDiagPt(b) ? 1 : 2)
  );
  labelOrder.forEach((p) => {
    const [x, y] = toSvg(p);
    const showPointCoords = isStartPt(p) || isDiagPt(p) || state.showCoords.has(p.id);
    svg += `<g class="trav-label" data-cx="${x}" data-cy="${y}">`;
    svg += `<text class="trav-pt-label">${escapeHtml(p.label)}</text>`;
    if (showPointCoords) svg += `<text class="trav-pt-coords">${p.x.toFixed(2)}, ${p.y.toFixed(2)}</text>`;
    svg += `</g>`;
  });

  svg += "</svg>";
  svgContainer.innerHTML = svg;
  const placed = layoutLegLabels(svgContainer);
  resolveLabelOverlaps(svgContainer, placed);

  if (pointsTable) {
    const withCoordsSorted = withCoords.sort(
      (a, b) => (isStartPt(a) ? 0 : isDiagPt(a) ? 1 : 2) - (isStartPt(b) ? 0 : isDiagPt(b) ? 1 : 2)
    );
    const hasZ = withCoordsSorted.some((p) => p.z !== null && p.z !== undefined);
    let prows = `<tr><th>Point</th><th>Role</th><th>X</th><th>Y</th>${hasZ ? "<th>Z</th>" : ""}</tr>`;
    withCoordsSorted.forEach((p) => {
      const role = isStartPt(p) ? "Start (pillar)" : isDiagPt(p) ? "Diagonal" : "Selected";
      const zCell = hasZ ? `<td>${p.z !== null && p.z !== undefined ? p.z.toFixed(3) : ""}</td>` : "";
      prows += `<tr><td>${escapeHtml(p.label)}</td><td>${role}</td><td>${p.x.toFixed(3)}</td><td>${p.y.toFixed(3)}</td>${zCell}</tr>`;
    });
    pointsTable.innerHTML = prows;
  }

  const perimeter = legs.reduce((sum, l) => sum + l.distance, 0);
  if (stats) {
    if (closed) {
      const areaM2 = polygonArea(included);
      const areaHa = areaM2 / 10000;
      stats.innerHTML =
        `<strong>Perimeter:</strong> ${perimeter.toLocaleString(undefined, { maximumFractionDigits: 2 })} m` +
        ` &nbsp;·&nbsp; <strong>Area:</strong> ${areaM2.toLocaleString(undefined, { maximumFractionDigits: 2 })} m²` +
        ` (${areaHa.toLocaleString(undefined, { maximumFractionDigits: 4 })} ha)`;
    } else {
      stats.innerHTML =
        `<strong>Total traverse length:</strong> ${perimeter.toLocaleString(undefined, { maximumFractionDigits: 2 })} m` +
        ` <span class="hint">(tick "Close boundary" above to compute area)</span>`;
    }
  }

  let rows = "<tr><th>Line</th><th>Bearing</th><th>Distance (m)</th></tr>";
  legs.forEach((l) => {
    rows += `<tr><td>${escapeHtml(l.from.label)} → ${escapeHtml(l.to.label)}</td><td>${formatBearing(l.bearingDeg)}</td><td>${l.distance.toFixed(3)}</td></tr>`;
  });
  if (diagonalLeg) {
    rows += `<tr class="trav-diagonal-row"><td>Diagonal: ${escapeHtml(diagonalLeg.from.label)} → ${escapeHtml(diagonalLeg.to.label)}</td><td>${formatBearing(diagonalLeg.bearingDeg)}</td><td>${diagonalLeg.distance.toFixed(3)}</td></tr>`;
  }
  table.innerHTML = rows;
}

// ---- persistence: survive a page refresh / page-to-page navigation ----
const STORAGE_KEY = "plot_dwg_state_v2";
const FIELD_IDS = [
  "col-label", "coord-mode", "col-x", "col-y", "col-z",
  "src-crs", "src-epsg-custom", "dst-crs", "dst-epsg-custom",
  "opt-draw-boundary", "opt-closed", "opt-3d",
  "traverse-start", "traverse-diagonal",
  "paper-size", "paper-orientation", "paper-margin", "paper-custom-w", "paper-custom-h",
  "plan-scale", "auto-annotation-size",
  "style-marker-type", "style-marker-layer", "style-marker-color",
  "style-donut-inside", "style-donut-outside",
  "style-text-layer", "style-text-color", "style-text-height",
  "style-boundary-layer", "style-boundary-color",
  "opt-leg-labels", "style-angle-convention", "style-leg-text-layer", "style-leg-text-color",
  "opt-pt-boundary", "style-pt-boundary-layer", "style-pt-boundary-color",
];
const TEXT_IDS = ["upload-status", "transform-status", "generate-status", "crs-guess-note"];

function saveState() {
  try {
    // Start from what we already know (fields from pages visited earlier this
    // session) and overwrite with whatever the current page's DOM has, so a
    // field's value survives even on pages where that input doesn't exist.
    const fields = { ...state.fields };
    FIELD_IDS.forEach((id) => {
      const el = $(id);
      if (el) fields[id] = el.type === "checkbox" ? el.checked : el.value;
    });
    state.fields = fields;
    const texts = {};
    TEXT_IDS.forEach((id) => {
      const el = $(id);
      if (el) texts[id] = el.textContent;
    });
    const snapshot = {
      columns: state.columns,
      rows: state.rows,
      mapping: state.mapping,
      presets: state.presets,
      crsGuess: state.crsGuess,
      srcCrsGuessId: state.srcCrsGuessId,
      crsGuessNote: state.crsGuessNote,
      srcEpsg: state.srcEpsg,
      dstEpsg: state.dstEpsg,
      transformed: state.transformed,
      included: Array.from(state.included),
      showCoords: Array.from(state.showCoords),
      ptBoundaryOrder: state.ptBoundaryOrder,
      ptBoundaryInitialized: state.ptBoundaryInitialized,
      maxStage: state.maxStage,
      fields,
      texts,
      scrOutput: $("scr-output") ? $("scr-output").value : "",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("Could not save session state:", err);
  }
}

function restoreState() {
  let saved;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!saved) return;

  state.columns = saved.columns || [];
  state.rows = saved.rows || [];
  state.mapping = saved.mapping || state.mapping;
  state.presets = saved.presets || [];
  state.crsGuess = saved.crsGuess || null;
  state.srcCrsGuessId = saved.srcCrsGuessId || null;
  state.crsGuessNote = saved.crsGuessNote || null;
  state.srcEpsg = saved.srcEpsg || null;
  state.dstEpsg = saved.dstEpsg || null;
  state.transformed = saved.transformed || [];
  state.included = new Set(saved.included || []);
  state.showCoords = new Set(saved.showCoords || []);
  state.ptBoundaryOrder = saved.ptBoundaryOrder || [];
  state.ptBoundaryInitialized = !!saved.ptBoundaryInitialized;
  state.maxStage = saved.maxStage || 1;
  state.fields = saved.fields || {};

  if (state.columns.length) populateColumnStep();

  if (state.presets.length) {
    fillCrsSelects();
    if (state.srcCrsGuessId && $("src-crs")) $("src-crs").value = state.srcCrsGuessId;
    if (state.crsGuessNote && $("crs-guess-note")) $("crs-guess-note").textContent = state.crsGuessNote;
  }

  // Populate the point list (and the traverse-start/diagonal selects it fills)
  // BEFORE applying saved field values below, so those selects already have
  // options and the saved selection actually takes.
  if (state.transformed.length) renderPointList();

  // Saved field values win over guessed/default selections above.
  Object.entries(state.fields).forEach(([id, value]) => {
    const el = $(id);
    if (!el) return;
    if (el.type === "checkbox") el.checked = value;
    else el.value = value;
  });
  updateCoordModeLabels();
  renderTraversePreview();

  Object.entries(saved.texts || {}).forEach(([id, text]) => {
    const el = $(id);
    if (el) el.textContent = text;
  });

  if (saved.scrOutput && $("scr-output")) {
    $("scr-output").value = saved.scrOutput;
    $("btn-download").disabled = false;
    $("btn-download").onclick = () => downloadText(saved.scrOutput, "plot.scr");
  }
}

// Restore first so every page-specific block below sees the real saved state.
restoreState();
renderStepper();

document.querySelectorAll(".btn-back").forEach((btn) => {
  btn.addEventListener("click", () => goTo(btn.dataset.target));
});

if ($("btn-start-over")) {
  $("btn-start-over").addEventListener("click", () => {
    if (!confirm("Clear the loaded CSV and all selections, and start over?")) return;
    localStorage.removeItem(STORAGE_KEY);
    location.href = "index.html";
  });
}

// Auto-save on any form interaction (dropdowns, checkboxes, text/number inputs).
document.querySelector("main").addEventListener("change", () => {
  saveState();
  renderTraversePreview();
});

// ---- Stage 1: upload ----
if ($("file-input")) {
  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("upload-status").textContent = "Uploading...";
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const data = await res.json();
      state.columns = data.columns;
      state.rows = data.rows;
      state.transformed = [];
      state.included = new Set();
      $("upload-status").textContent = `Loaded ${data.row_count} rows, ${data.columns.length} columns.`;
      advanceTo(2, "columns.html");
    } catch (err) {
      $("upload-status").textContent = `Error: ${err.message}`;
    }
  });
}

// ---- Stage 2: column mapping ----
if ($("coord-mode")) {
  $("coord-mode").addEventListener("change", updateCoordModeLabels);
}

if ($("btn-detect-crs")) {
  $("btn-detect-crs").addEventListener("click", async () => {
    state.mapping = {
      label: $("col-label").value,
      mode: $("coord-mode").value,
      x: $("col-x").value,
      y: $("col-y").value,
      z: $("col-z").value || null,
    };
    const sample = state.rows.slice(0, 25);
    const xValues = sample.map((r) => parseCoordinate(r[state.mapping.x])).filter((v) => v !== null);
    const yValues = sample.map((r) => parseCoordinate(r[state.mapping.y])).filter((v) => v !== null);

    if (!state.presets.length) {
      state.presets = await (await fetch(`${API}/crs-presets`)).json();
    }

    try {
      const res = await fetch(`${API}/detect-crs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x_values: xValues, y_values: yValues }),
      });
      const guess = await res.json();
      state.crsGuess = guess;
      if (guess.top) {
        state.srcCrsGuessId = guess.top.id;
        const others = guess.candidates.slice(1, 4).map((c) => `${c.label} (${c.confidence})`).join(", ");
        state.crsGuessNote =
          `Best guess: ${guess.top.label} — confirm this is correct before continuing. ` +
          (others ? `Other candidates: ${others}.` : "") +
          ` Note: if this column's values don't closely match any preset, it may be a local/site-calibrated grid rather than a standard CRS — consider mapping from Latitude/Longitude instead.`;
      } else {
        state.srcCrsGuessId = null;
        state.crsGuessNote = "Could not guess a CRS from these values — pick one manually.";
      }
    } catch (err) {
      state.srcCrsGuessId = null;
      state.crsGuessNote = `CRS detection failed: ${err.message}`;
    }
    advanceTo(3, "crs.html");
  });
}

// ---- Stage 3: confirm CRS + transform ----
if ($("btn-transform")) {
  $("btn-transform").addEventListener("click", async () => {
    state.srcEpsg = resolveEpsg($("src-crs"), $("src-epsg-custom"));
    state.dstEpsg = resolveEpsg($("dst-crs"), $("dst-epsg-custom"));
    if (!state.srcEpsg || !state.dstEpsg) {
      $("transform-status").textContent = "Pick both a source and target CRS.";
      return;
    }
    if (state.srcEpsg === state.dstEpsg) {
      $("transform-status").textContent =
        `Source and target are both EPSG:${state.srcEpsg} — converting a CRS to itself just echoes your input back unchanged. Pick a different target CRS.`;
      return;
    }
    const points = state.rows.map((r) => ({
      id: r._row_id,
      label: String(r[state.mapping.label] ?? r._row_id),
      x_raw: r[state.mapping.x],
      y_raw: r[state.mapping.y],
      z_raw: state.mapping.z ? r[state.mapping.z] : null,
    }));
    $("transform-status").textContent = "Transforming...";
    try {
      const res = await fetch(`${API}/transform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points, src_epsg: state.srcEpsg, dst_epsg: state.dstEpsg }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const data = await res.json();
      state.transformed = data.points;
      autoSelectBoundaryByName();
      // No PT-prefixed points at all (naming convention doesn't apply to this
      // CSV) — fall back to including everything rather than an empty boundary.
      let autoNote = `${state.included.size} point(s) with names starting "PT" auto-included as the boundary — adjust below as needed.`;
      if (state.included.size === 0) {
        state.included = new Set(data.points.map((p) => p.id));
        autoNote = `No "PT"-prefixed point names found, so all ${state.included.size} points were included by default — adjust below as needed.`;
      }
      $("transform-status").textContent = (data.errors.length
        ? `Transformed ${data.points.length} points. ${data.errors.length} rows skipped (bad coordinates). `
        : `Transformed ${data.points.length} points. `) + autoNote;
      advanceTo(4, "arrange.html");
    } catch (err) {
      $("transform-status").textContent = `Error: ${err.message}`;
    }
  });
}

// ---- Stage 4: arrange points & boundary ----
if ($("btn-style")) {
  $("btn-style").addEventListener("click", () => advanceTo(5, "style.html"));
}

if ($("btn-download-csv")) {
  $("btn-download-csv").addEventListener("click", () => {
    if (!state.transformed.length) return;
    const hasZ = state.transformed.some((p) => p.z !== null && p.z !== undefined);
    const header = ["Point Name", "X", "Y", ...(hasZ ? ["Z"] : []), "Include_in_Boundary", "Source_EPSG", "Target_EPSG"];
    const lines = [header.map(csvCell).join(",")];
    state.transformed.forEach((p) => {
      const row = [
        p.label,
        p.x.toFixed(3),
        p.y.toFixed(3),
        ...(hasZ ? [p.z !== null && p.z !== undefined ? p.z.toFixed(3) : ""] : []),
        state.included.has(p.id) ? "Yes" : "No",
        state.srcEpsg ?? "",
        state.dstEpsg ?? "",
      ];
      lines.push(row.map(csvCell).join(","));
    });
    downloadText(lines.join("\r\n") + "\r\n", "converted_coordinates.csv");
  });
}

// ---- Stage 5a: paper size -> auto-fit plan scale + annotation sizing ----
const PAPER_SIZES_MM = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297],
  Legal: [215.9, 355.6], // 8.5 x 14 in — common official size for survey/cadastral plans
};
const STANDARD_SCALES = [50, 100, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000, 10000, 20000];
const PRINT_TEXT_MM = 2.5;   // target printed text height at any chosen scale
const PRINT_DONUT_MM = 1.5;  // target printed marker diameter at any chosen scale
let planScaleManuallySet = false;
let paperSizeManuallySet = false;

function roundUpToStandardScale(n) {
  return STANDARD_SCALES.find((s) => s >= n) || STANDARD_SCALES[STANDARD_SCALES.length - 1];
}

function requiredScaleFor(widthM, heightM, paperWmm, paperHmm, marginMm) {
  const availW = Math.max(paperWmm - 2 * marginMm, 1);
  const availH = Math.max(paperHmm - 2 * marginMm, 1);
  return Math.max((widthM * 1000) / availW, (heightM * 1000) / availH, 1);
}

function currentPaperDimsMm() {
  const size = $("paper-size").value;
  if (size === "custom") {
    return [parseFloat($("paper-custom-w").value) || 841, parseFloat($("paper-custom-h").value) || 594];
  }
  return PAPER_SIZES_MM[size] || PAPER_SIZES_MM.Legal;
}

function bestFitForPaper(widthM, heightM, baseW, baseH, marginMm, orientationPref) {
  const options = [];
  if (orientationPref !== "landscape") options.push({ label: "portrait", w: baseW, h: baseH });
  if (orientationPref !== "portrait") options.push({ label: "landscape", w: baseH, h: baseW });
  let best = null;
  options.forEach((o) => {
    const required = requiredScaleFor(widthM, heightM, o.w, o.h, marginMm);
    const standard = roundUpToStandardScale(required);
    if (!best || standard < best.standard) best = { orientation: o.label, paperW: o.w, paperH: o.h, required, standard };
  });
  return best;
}

// Smallest to largest by sheet area — used to find the smallest standard
// paper that still achieves the best (finest) scale any of them could give.
const PAPER_SIZE_ORDER = ["A4", "Legal", "A3", "A2", "A1", "A0"];

// Evaluate every standard paper size for this job's extent and pick the
// smallest one that reaches the same finest achievable standard scale as
// the largest sheet would — no point suggesting A0 if Legal gets you the
// same 1:500 with a much more practical sheet to print and file.
function suggestBestPaperSize(widthM, heightM, marginMm, orientationPref) {
  const results = PAPER_SIZE_ORDER.map((size) => {
    const [w, h] = PAPER_SIZES_MM[size];
    return { size, ...bestFitForPaper(widthM, heightM, w, h, marginMm, orientationPref) };
  });
  const finestStandard = Math.min(...results.map((r) => r.standard));
  return results.find((r) => r.standard === finestStandard);
}

// Extent used for paper/scale fitting: the curated boundary set, not every
// transformed point — instrument CSVs often carry junk placeholder/reset
// rows (e.g. a "base" row at throwaway coordinates) that are technically in
// state.transformed but would blow the extent out to something meaningless.
function extentForScaling() {
  const boundaryPts = state.transformed.filter((p) => state.included.has(p.id));
  const source = boundaryPts.length >= 2 ? boundaryPts : state.transformed;
  const usedFallback = source === state.transformed && boundaryPts.length < 2;
  const xs = source.map((p) => p.x);
  const ys = source.map((p) => p.y);
  return { widthM: Math.max(...xs) - Math.min(...xs), heightM: Math.max(...ys) - Math.min(...ys), usedFallback };
}

function applyAutoAnnotationSizing() {
  if (!$("auto-annotation-size") || !$("auto-annotation-size").checked) return;
  const n = parseInt($("plan-scale").value, 10);
  if (!n) return;
  $("style-text-height").value = ((PRINT_TEXT_MM * n) / 1000).toFixed(3);
  $("style-donut-outside").value = ((PRINT_DONUT_MM * n) / 1000).toFixed(3);
  $("style-donut-inside").value = "0";
}

function updateScaleSuggestion() {
  const note = $("scale-suggestion");
  if (!note) return;
  if (!state.transformed.length) {
    note.textContent = "No points transformed yet — go back and complete the earlier steps first.";
    return;
  }
  const { widthM, heightM, usedFallback } = extentForScaling();
  const [baseW, baseH] = currentPaperDimsMm();
  const margin = parseFloat($("paper-margin").value) || 0;
  const orientationPref = $("paper-orientation").value;
  const best = bestFitForPaper(widthM, heightM, baseW, baseH, margin, orientationPref);

  note.textContent =
    (usedFallback ? "No boundary points marked yet, so this uses the full extent of all points (may include outliers). " : "") +
    `Drawing extent: ${widthM.toFixed(1)} × ${heightM.toFixed(1)} m. ` +
    `Best fit for the selected paper: 1:${best.standard} in ${best.orientation} ` +
    `(needs at least 1:${Math.ceil(best.required)} to fit the usable area) — ` +
    (planScaleManuallySet ? `you've set the plan scale manually below.` : `applied to "Plan scale" below.`);

  if (!planScaleManuallySet) {
    $("plan-scale").value = String(best.standard);
    applyAutoAnnotationSizing();
  }
}

// Evaluates all standard paper sizes for the current extent and selects the
// smallest one that reaches the best achievable scale, then re-fits the
// scale to it. Runs once automatically (first time this job reaches Style,
// before any manual paper choice) and again any time the user asks for it.
function suggestAndApplyBestPaper() {
  const note = $("paper-suggestion");
  if (!note || !state.transformed.length) return;
  const { widthM, heightM, usedFallback } = extentForScaling();
  const margin = parseFloat($("paper-margin").value) || 0;
  const orientationPref = $("paper-orientation").value;
  const best = suggestBestPaperSize(widthM, heightM, margin, orientationPref);

  $("paper-size").value = best.size;
  const isCustom = best.size === "custom";
  $("lbl-custom-w").hidden = !isCustom;
  $("lbl-custom-h").hidden = !isCustom;
  note.textContent =
    (usedFallback ? "No boundary points marked yet — based on the full extent of all points (may include outliers). " : "") +
    `Suggested paper: ${best.size} — the smallest standard sheet that still fits this drawing at the best available scale (1:${best.standard}).`;

  planScaleManuallySet = false;
  updateScaleSuggestion();
}

if ($("paper-size")) {
  $("paper-size").addEventListener("change", () => {
    paperSizeManuallySet = true;
    const isCustom = $("paper-size").value === "custom";
    $("lbl-custom-w").hidden = !isCustom;
    $("lbl-custom-h").hidden = !isCustom;
    updateScaleSuggestion();
  });
  ["paper-orientation", "paper-margin", "paper-custom-w", "paper-custom-h"].forEach((id) => {
    $(id).addEventListener("input", updateScaleSuggestion);
  });
  $("plan-scale").addEventListener("change", () => {
    planScaleManuallySet = true;
    applyAutoAnnotationSizing();
    updateScaleSuggestion();
  });
  $("auto-annotation-size").addEventListener("change", applyAutoAnnotationSizing);
  if ($("btn-suggest-paper")) {
    $("btn-suggest-paper").addEventListener("click", suggestAndApplyBestPaper);
  }

  // If paper size / plan scale were already restored from a previous visit,
  // respect them (don't silently override a manual choice) — otherwise
  // auto-suggest the best-fit paper for this job, then a scale for it.
  const isCustomInitial = $("paper-size").value === "custom";
  $("lbl-custom-w").hidden = !isCustomInitial;
  $("lbl-custom-h").hidden = !isCustomInitial;
  paperSizeManuallySet = !!(state.fields && state.fields["paper-size"]);
  planScaleManuallySet = !!(state.fields && state.fields["plan-scale"]);
  if (!paperSizeManuallySet) suggestAndApplyBestPaper();
  else updateScaleSuggestion();
}

if ($("opt-pt-boundary")) {
  $("opt-pt-boundary").addEventListener("change", () => {
    renderPtBoundaryList();
    saveState();
  });
  if ($("btn-pt-boundary-reset")) {
    $("btn-pt-boundary-reset").addEventListener("click", () => {
      resetPtBoundaryOrder();
      renderPtBoundaryList();
      saveState();
    });
  }
  renderPtBoundaryList();
}

// ---- Stage 5: styling + generate ----
if ($("btn-generate")) {
  $("btn-generate").addEventListener("click", async () => {
    const style = {
      marker_type: $("style-marker-type").value,
      marker_layer: $("style-marker-layer").value,
      marker_color: parseInt($("style-marker-color").value, 10),
      donut_inside: parseFloat($("style-donut-inside").value),
      donut_outside: parseFloat($("style-donut-outside").value),
      text_layer: $("style-text-layer").value,
      text_color: parseInt($("style-text-color").value, 10),
      text_height: parseFloat($("style-text-height").value),
      boundary_layer: $("style-boundary-layer").value,
      boundary_color: parseInt($("style-boundary-color").value, 10),
      leg_labels: $("opt-leg-labels").checked,
      angle_convention: $("style-angle-convention").value,
      leg_text_layer: $("style-leg-text-layer").value,
      leg_text_color: parseInt($("style-leg-text-color").value, 10),
    };
    // opt-3d / opt-draw-boundary / opt-closed live on arrange.html, not this page,
    // so read them from the persisted field values rather than the DOM.
    const use3d = !!state.fields["opt-3d"];
    const groups = [];
    if (state.fields["opt-draw-boundary"]) {
      const ids = state.transformed.filter((p) => state.included.has(p.id)).map((p) => p.id);
      if (ids.length >= 2) groups.push({ point_ids: ids, closed: state.fields["opt-closed"] !== false });
    }
    // Separate PT-only trace: the user-ordered/pruned list from the PT boundary
    // polyline section above, re-filtered to points still PT-classified AND
    // still ticked "boundary" on Arrange (so an unticked point can never sneak
    // back in even if it lingered in a previously saved order).
    if ($("opt-pt-boundary").checked) {
      const eligibleIds = new Set(eligiblePtBoundaryPoints().map((p) => p.id));
      const ptIds = state.ptBoundaryOrder.filter((id) => eligibleIds.has(id));
      if (ptIds.length >= 2) {
        groups.push({
          point_ids: ptIds,
          closed: state.fields["opt-closed"] !== false,
          layer: $("style-pt-boundary-layer").value,
          color: parseInt($("style-pt-boundary-color").value, 10),
        });
      }
    }
    $("generate-status").textContent = "Generating...";
    try {
      const res = await fetch(`${API}/generate-scr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: state.transformed, groups, style, use_3d: use3d }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const text = await res.text();
      $("scr-output").value = text;
      $("generate-status").textContent = "Script generated.";
      $("btn-download").disabled = false;
      $("btn-download").onclick = () => downloadText(text, "plot.scr");
      saveState();
    } catch (err) {
      $("generate-status").textContent = `Error: ${err.message}`;
    }
  });
}

const footerYear = document.getElementById("footer-year");
if (footerYear) footerYear.textContent = new Date().getFullYear();
