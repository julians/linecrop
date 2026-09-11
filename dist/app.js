const SVG_NS = "http://www.w3.org/2000/svg";
const GEOMETRY_SELECTOR = "path,rect,circle,ellipse,polygon,polyline";

const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const downloadButton = document.querySelector("#download-button");
const statusElement = document.querySelector("#status");
const fileMeta = document.querySelector("#file-meta");
const previewImage = document.querySelector("#preview-image");
const emptyPreview = document.querySelector("#empty-preview");
const previewPanel = document.querySelector("#preview-panel");
const processingHost = document.querySelector("#processing-host");

let outputSvg = "";
let outputName = "clipped.svg";
let previewUrl = "";

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) processFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const file = [...event.dataTransfer.files].find(
    (candidate) => candidate.type === "image/svg+xml" || candidate.name.toLowerCase().endsWith(".svg"),
  );
  if (file) processFile(file);
  else setStatus("That file is not an SVG.", "error");
});

downloadButton.addEventListener("click", () => {
  if (!outputSvg) return;
  const url = URL.createObjectURL(new Blob([outputSvg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = outputName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function processFile(file) {
  resetOutput();
  setStatus("Reading and tracing mask boundaries…", "working");
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;

  try {
    const source = await file.text();
    const result = await clipSvgGeometry(source);
    outputSvg = result.svg;
    outputName = file.name.replace(/\.svg$/i, "") + "-clipped.svg";
    showPreview(outputSvg);
    downloadButton.disabled = false;
    setStatus(
      `${result.groups} ${plural(result.groups, "group")} · ${result.sourceLines} source ${plural(result.sourceLines, "line")} → ${result.outputLines} clipped ${plural(result.outputLines, "segment")}. Ready for the plotter.`,
      "success",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not process this SVG.", "error");
  } finally {
    processingHost.replaceChildren();
  }
}

async function clipSvgGeometry(source) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") {
    throw new Error("This file does not contain valid SVG markup.");
  }

  const svg = document.importNode(parsed.documentElement, true);
  sanitizeSvg(svg);
  processingHost.replaceChildren(svg);

  await nextFrame();

  const pairs = findGroupPairs(svg);
  if (!pairs.length) {
    throw new Error('No sibling "mask" + "lines" group pairs were found.');
  }
  const rootBox = getRootBox(svg);
  const tolerance = Math.max(0.12, Math.min(0.6, Math.max(rootBox.width, rootBox.height) / 1800));
  let sourceLineCount = 0;
  let outputLines = 0;
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    const { maskGroup, linesGroup } = pairs[pairIndex];
    setStatus(`Clipping group ${pairIndex + 1} of ${pairs.length}…`, "working");
    await nextFrame();

    const maskShapes = uniqueMaskShapes(
      [...maskGroup.querySelectorAll(GEOMETRY_SELECTOR)].filter(isGeometryElement),
    );
    const sourceLines = [...linesGroup.querySelectorAll("line")];
    const unsupported = [...linesGroup.querySelectorAll("path,polyline,polygon,rect,circle,ellipse")];

    if (!maskShapes.length) throw new Error(`The mask in group ${pairIndex + 1} has no filled vector shapes.`);
    if (!sourceLines.length) {
      if (unsupported.length) {
        throw new Error(`The lines in group ${pairIndex + 1} must be SVG <line> elements.`);
      }
      throw new Error(`The lines group ${pairIndex + 1} contains no SVG <line> elements.`);
    }

    sourceLineCount += sourceLines.length;
    const boundaries = maskShapes.map((shape) => traceBoundary(shape, tolerance)).filter(Boolean);
    if (!boundaries.length) throw new Error(`The mask in group ${pairIndex + 1} could not be traced.`);

    for (const line of sourceLines) {
      const fragments = clipLine(line, maskShapes, boundaries);
      const replacement = document.createDocumentFragment();

      fragments.forEach((fragment, fragmentIndex) => {
        const clipped = line.cloneNode(false);
        clipped.setAttribute("x1", tidy(fragment.x1));
        clipped.setAttribute("y1", tidy(fragment.y1));
        clipped.setAttribute("x2", tidy(fragment.x2));
        clipped.setAttribute("y2", tidy(fragment.y2));
        if (fragmentIndex > 0 && clipped.id) clipped.id = `${clipped.id}__clip_${fragmentIndex + 1}`;
        replacement.append(clipped);
        outputLines += 1;
      });

      line.replaceWith(replacement);
    }

    maskGroup.remove();
  }

  if (!outputLines) throw new Error("The mask and lines do not overlap, so there is nothing to export.");

  svg.setAttribute("xmlns", SVG_NS);
  const serialized = new XMLSerializer().serializeToString(svg);
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}\n`, sourceLines: sourceLineCount, outputLines, groups: pairs.length };
}

function clipLine(line, maskShapes, boundaries) {
  const matrix = line.getCTM();
  if (!matrix) return [];
  let inverse;
  try {
    inverse = matrix.inverse();
  } catch {
    return [];
  }

  const localStart = new DOMPoint(numberAttr(line, "x1"), numberAttr(line, "y1"));
  const localEnd = new DOMPoint(numberAttr(line, "x2"), numberAttr(line, "y2"));
  const start = localStart.matrixTransform(matrix);
  const end = localEnd.matrixTransform(matrix);
  const lineBox = segmentBox(start, end);
  const cuts = [0, 1];

  for (const boundary of boundaries) {
    if (!boxesOverlap(lineBox, boundary.box)) continue;
    for (let index = 1; index < boundary.points.length; index += 1) {
      const t = segmentIntersectionParameter(start, end, boundary.points[index - 1], boundary.points[index]);
      if (t !== null) cuts.push(t);
    }
  }

  cuts.sort((a, b) => a - b);
  const uniqueCuts = cuts.filter((value, index) => index === 0 || Math.abs(value - cuts[index - 1]) > 1e-6);
  const fragments = [];

  for (let index = 1; index < uniqueCuts.length; index += 1) {
    const from = uniqueCuts[index - 1];
    const to = uniqueCuts[index];
    if (to - from < 1e-7) continue;
    const middle = pointOnSegment(start, end, (from + to) / 2);
    if (!pointInsideMask(middle, maskShapes)) continue;

    const clippedStart = pointOnSegment(start, end, from).matrixTransform(inverse);
    const clippedEnd = pointOnSegment(start, end, to).matrixTransform(inverse);
    fragments.push({ x1: clippedStart.x, y1: clippedStart.y, x2: clippedEnd.x, y2: clippedEnd.y });
  }

  return fragments;
}

function traceBoundary(shape, tolerance) {
  const matrix = shape.getCTM();
  if (!matrix || typeof shape.getTotalLength !== "function") return null;
  let length;
  try {
    length = shape.getTotalLength();
  } catch {
    return null;
  }
  if (!Number.isFinite(length) || length <= 0) return null;

  const segmentCount = Math.min(20000, Math.max(12, Math.ceil(length / tolerance)));
  const points = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let index = 0; index <= segmentCount; index += 1) {
    const localPoint = shape.getPointAtLength((length * index) / segmentCount);
    const point = new DOMPoint(localPoint.x, localPoint.y).matrixTransform(matrix);
    points.push(point);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return { points, box: { minX, minY, maxX, maxY } };
}

function pointInsideMask(point, shapes) {
  return shapes.some((shape) => {
    const matrix = shape.getCTM();
    if (!matrix || typeof shape.isPointInFill !== "function") return false;
    try {
      return shape.isPointInFill(point.matrixTransform(matrix.inverse()));
    } catch {
      return false;
    }
  });
}

function segmentIntersectionParameter(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) < 1e-10) return null;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, rx, ry) / denominator;
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
  return Math.max(0, Math.min(1, t));
}

function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

function pointOnSegment(start, end, t) {
  return new DOMPoint(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
}

function segmentBox(start, end) {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function boxesOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function isGeometryElement(element) {
  return typeof element.getTotalLength === "function" && typeof element.isPointInFill === "function";
}

function findGroupPairs(svg) {
  const groups = [...svg.querySelectorAll("g[id]")];
  const lineGroups = groups.filter((group) => /^lines(?:[ _-].+)?$/i.test(group.id));
  return lineGroups.flatMap((linesGroup) => {
    const suffix = linesGroup.id.slice(5);
    const wantedMaskId = `mask${suffix}`.toLowerCase();
    const siblings = [...linesGroup.parentElement.children];
    const maskGroup = siblings.find(
      (element) => element.localName === "g" && (element.id || "").toLowerCase() === wantedMaskId,
    );
    return maskGroup ? [{ maskGroup, linesGroup }] : [];
  });
}

function uniqueMaskShapes(shapes) {
  const seen = new Set();
  return shapes.filter((shape) => {
    const matrix = shape.getCTM();
    const geometry = ["d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "points"]
      .map((name) => shape.getAttribute(name) || "")
      .join("|");
    const transform = matrix
      ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map((value) => value.toFixed(5)).join(",")
      : "";
    const key = `${shape.localName}|${geometry}|${transform}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeSvg(svg) {
  svg.querySelectorAll("script,foreignObject,iframe,object,embed").forEach((element) => element.remove());
  svg.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    }
  });
}

function getRootBox(svg) {
  const viewBox = svg.viewBox && svg.viewBox.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) return viewBox;
  return { width: svg.clientWidth || 1000, height: svg.clientHeight || 1000 };
}

function numberAttr(element, name) {
  const value = Number.parseFloat(element.getAttribute(name) || "0");
  return Number.isFinite(value) ? value : 0;
}

function tidy(value) {
  return Number(value.toFixed(4)).toString();
}

function plural(count, singular) { return count === 1 ? singular : `${singular}s`; }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nextFrame() { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }

function setStatus(message, type) {
  statusElement.className = `status${type ? ` is-${type}` : ""}`;
  statusElement.lastElementChild.textContent = message;
}

function resetOutput() {
  outputSvg = "";
  downloadButton.disabled = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  emptyPreview.hidden = false;
  previewPanel.hidden = true;
}

function showPreview(svgText) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  previewImage.src = previewUrl;
  previewImage.hidden = false;
  emptyPreview.hidden = true;
  previewPanel.hidden = false;
}

function registerWebMcpTool() {
  const context = document.modelContext;
  if (!context?.registerTool) return;

  try {
    void Promise.resolve(
      context.registerTool({
        name: "clip_svg_line_geometry",
        title: "Clip SVG line geometry",
        description: "Process SVG source using every sibling mask/lines group pair and prepare the clipped SVG for download in the page.",
        inputSchema: {
          type: "object",
          properties: {
            svg: { type: "string", description: "Complete SVG source markup." },
            filename: { type: "string", description: "Original SVG filename." },
          },
          required: ["svg"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input) {
          if (!input || typeof input.svg !== "string" || !input.svg.trim()) {
            throw new Error("svg must be a non-empty SVG source string.");
          }
          resetOutput();
          setStatus("Reading and tracing mask boundaries…", "working");
          const result = await clipSvgGeometry(input.svg);
          const filename = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim() : "drawing.svg";
          outputSvg = result.svg;
          outputName = filename.replace(/\.svg$/i, "") + "-clipped.svg";
          fileMeta.textContent = filename;
          showPreview(outputSvg);
          downloadButton.disabled = false;
          setStatus(
            `${result.groups} ${plural(result.groups, "group")} · ${result.sourceLines} source ${plural(result.sourceLines, "line")} → ${result.outputLines} clipped ${plural(result.outputLines, "segment")}. Ready for the plotter.`,
            "success",
          );
          return { groups: result.groups, sourceLines: result.sourceLines, clippedSegments: result.outputLines, filename: outputName };
        },
      }),
    ).catch(() => {});
  } catch {
    // Browsers without WebMCP keep the normal drop-and-download experience.
  }
}

registerWebMcpTool();
