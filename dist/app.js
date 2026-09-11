const SVG_NS = "http://www.w3.org/2000/svg";
const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const GEOMETRY_SELECTOR = "path,rect,circle,ellipse,polygon,polyline";

const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const exportPanel = document.querySelector("#export-panel");
const exportSummary = document.querySelector("#export-summary");
const downloadOriginal = document.querySelector("#download-original");
const downloadMultilayer = document.querySelector("#download-multilayer");
const downloadIndividuals = document.querySelector("#download-individuals");
const individualExportCopy = document.querySelector("#individual-export-copy");
const statusElement = document.querySelector("#status");
const fileMeta = document.querySelector("#file-meta");
const previewImage = document.querySelector("#preview-image");
const emptyPreview = document.querySelector("#empty-preview");
const previewPanel = document.querySelector("#preview-panel");
const processingHost = document.querySelector("#processing-host");

let outputSvg = "";
let outputName = "clipped.svg";
let multilayerSvg = "";
let multilayerName = "multilayer.svg";
let individualExports = [];
let individualArchiveName = "layers.zip";
let previewUrl = "";
let vpypeOptimizerPromise = null;

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

downloadOriginal.addEventListener("click", () => downloadBlob(outputSvg, outputName, "image/svg+xml"));
downloadMultilayer.addEventListener("click", () => downloadBlob(multilayerSvg, multilayerName, "image/svg+xml"));
downloadIndividuals.addEventListener("click", () => {
  if (!individualExports.length) return;
  downloadBlob(buildZip(individualExports), individualArchiveName, "application/zip");
});

async function processFile(file) {
  resetOutput();
  setStatus("Reading and tracing mask boundaries…", "working");
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;

  try {
    const source = await file.text();
    const result = await clipSvgGeometry(source);
    const baseName = file.name.replace(/\.svg$/i, "");
    outputSvg = result.svg;
    outputName = `${baseName}-clipped.svg`;
    multilayerSvg = result.multilayerSvg;
    multilayerName = `${baseName}-multilayer.svg`;
    individualExports = result.layers.map((layer, index) => ({
      name: `${baseName}-${String(index + 1).padStart(2, "0")}-${filenamePart(layer.label)}.svg`,
      content: layer.svg,
    }));
    individualArchiveName = `${baseName}-layers.zip`;
    showPreview(outputSvg);
    showExports(result.layers, result.optimization);
    setStatus(
      successMessage(result),
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
  const registered = buildRegisteredExports(svg, pairs);
  const optimized = await optimizeRegisteredExports(registered);
  return {
    svg: xmlDocument(serialized),
    multilayerSvg: optimized.svg,
    layers: optimized.layers,
    registration: registered.registration,
    optimization: optimized.stats,
    sourceLines: sourceLineCount,
    outputLines,
    groups: pairs.length,
  };
}

async function optimizeRegisteredExports(registered) {
  setStatus("Loading the plotter optimizer…", "working");
  const vpype = await loadVpypeOptimizer();
  const quantization = vpype.convertLength("0.05mm");
  const mergeTolerance = vpype.convertLength("0.1mm");
  const simplifyTolerance = vpype.convertLength("0.05mm");
  const document = new vpype.Document();
  const optimizedLayers = [];
  let pageSize = null;
  let pathsBefore = 0;
  let pathsAfter = 0;
  let segmentsBefore = 0;
  let segmentsAfter = 0;
  let penUpBefore = 0;
  let penUpAfter = 0;

  for (let index = 0; index < registered.layers.length; index += 1) {
    const layer = registered.layers[index];
    setStatus(`Optimizing color layer ${index + 1} of ${registered.layers.length}…`, "working");
    await nextFrame();

    const parsed = vpype.readSvg(layer.svg, quantization);
    if (!pageSize) pageSize = [parsed.width, parsed.height];
    pathsBefore += parsed.lines.count;
    segmentsBefore += parsed.lines.segmentCount();
    penUpBefore += parsed.lines.penUpLength()[0];

    let lines = vpype.linemerge(parsed.lines, { tolerance: mergeTolerance });
    lines = vpype.linesort(lines, { twoOpt: true });
    lines = vpype.linesimplify(lines, { tolerance: simplifyTolerance });
    lines.setProperty(vpype.METADATA_FIELD_NAME, layer.label);

    pathsAfter += lines.count;
    segmentsAfter += lines.segmentCount();
    penUpAfter += lines.penUpLength()[0];
    document.add(lines, index + 1, true);

    const individual = new vpype.Document({ pageSize });
    individual.add(lines, 1, true);
    optimizedLayers.push({
      label: layer.label,
      svg: vpype.writeSvg(individual, { colorMode: "default" }),
    });
  }

  if (!pageSize) throw new Error("The color layers contain no plottable geometry.");
  document.pageSize = pageSize;
  const reduction = penUpBefore > 0
    ? Math.max(0, Math.min(100, Math.round((1 - penUpAfter / penUpBefore) * 100)))
    : 0;

  return {
    svg: vpype.writeSvg(document, { colorMode: "default" }),
    layers: optimizedLayers,
    stats: {
      pathsBefore,
      pathsAfter,
      segmentsBefore,
      segmentsAfter,
      penUpBefore,
      penUpAfter,
      reduction,
    },
  };
}

function loadVpypeOptimizer() {
  if (!vpypeOptimizerPromise) vpypeOptimizerPromise = import("./vpype-optimizer.js");
  return vpypeOptimizerPromise;
}

function buildRegisteredExports(sourceSvg, pairs) {
  const registeredSvg = sourceSvg.cloneNode(false);
  registeredSvg.replaceChildren();
  registeredSvg.setAttribute("xmlns", SVG_NS);
  registeredSvg.setAttributeNS(XMLNS_NS, "xmlns:inkscape", INKSCAPE_NS);

  const rootMatrix = sourceSvg.getCTM();
  let rootInverse;
  try {
    rootInverse = rootMatrix ? rootMatrix.inverse() : new DOMMatrix();
  } catch {
    rootInverse = new DOMMatrix();
  }

  const layers = pairs.map(({ linesGroup }, index) => {
    const label = layerLabel(linesGroup, index);
    const layer = document.createElementNS(SVG_NS, "g");
    layer.id = `layer-${index + 1}-${filenamePart(label)}`;
    layer.setAttributeNS(INKSCAPE_NS, "inkscape:groupmode", "layer");
    layer.setAttributeNS(INKSCAPE_NS, "inkscape:label", label);
    layer.setAttribute("data-plotter-layer", String(index + 1));

    for (const sourceLine of linesGroup.querySelectorAll("line")) {
      const matrix = sourceLine.getCTM();
      if (!matrix) continue;
      const start = new DOMPoint(numberAttr(sourceLine, "x1"), numberAttr(sourceLine, "y1"))
        .matrixTransform(matrix)
        .matrixTransform(rootInverse);
      const end = new DOMPoint(numberAttr(sourceLine, "x2"), numberAttr(sourceLine, "y2"))
        .matrixTransform(matrix)
        .matrixTransform(rootInverse);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", tidy(start.x));
      line.setAttribute("y1", tidy(start.y));
      line.setAttribute("x2", tidy(end.x));
      line.setAttribute("y2", tidy(end.y));
      if (sourceLine.id) line.id = sourceLine.id;
      copyResolvedLineStyle(sourceLine, line);
      layer.append(line);
    }

    registeredSvg.append(layer);
    return { label, node: layer };
  });

  const svg = xmlDocument(new XMLSerializer().serializeToString(registeredSvg));
  const individualLayers = layers.map(({ label, node }) => {
    const individualSvg = registeredSvg.cloneNode(false);
    individualSvg.append(node.cloneNode(true));
    return { label, svg: xmlDocument(new XMLSerializer().serializeToString(individualSvg)) };
  });

  return {
    svg,
    layers: individualLayers,
    registration: {
      width: registeredSvg.getAttribute("width") || "",
      height: registeredSvg.getAttribute("height") || "",
      viewBox: registeredSvg.getAttribute("viewBox") || "",
    },
  };
}

function copyResolvedLineStyle(source, target) {
  const style = getComputedStyle(source);
  const properties = [
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "vector-effect",
  ];
  target.setAttribute("fill", "none");
  for (const property of properties) {
    const value = style.getPropertyValue(property);
    if (value) target.setAttribute(property, value);
  }
}

function layerLabel(group, index) {
  const suffix = group.id.replace(/^lines(?:[ _-])?/i, "").trim();
  return suffix || `Layer ${index + 1}`;
}

function xmlDocument(serialized) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}\n`;
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
  multilayerSvg = "";
  individualExports = [];
  downloadOriginal.disabled = true;
  downloadMultilayer.disabled = true;
  downloadIndividuals.disabled = true;
  exportPanel.hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  emptyPreview.hidden = false;
  previewPanel.hidden = true;
}

function showExports(layers, optimization) {
  const count = layers.length;
  exportSummary.textContent = optimization.penUpBefore > 0
    ? `${count} ${plural(count, "layer")} · ${optimization.reduction}% less pen travel`
    : `${count} optimized color ${plural(count, "layer")}`;
  individualExportCopy.textContent = `${count} optimized, registered ${plural(count, "SVG")} in one ZIP`;
  downloadOriginal.disabled = false;
  downloadMultilayer.disabled = false;
  downloadIndividuals.disabled = false;
  exportPanel.hidden = false;
}

function successMessage(result) {
  const clipped = `${result.groups} ${plural(result.groups, "group")} · ${result.sourceLines} source ${plural(result.sourceLines, "line")} → ${result.outputLines} clipped ${plural(result.outputLines, "segment")}`;
  const optimized = result.optimization.penUpBefore > 0
    ? `${result.optimization.reduction}% less pen-up travel`
    : "plot paths optimized";
  return `${clipped} · ${optimized}. Ready for the plotter.`;
}

function downloadBlob(content, filename, type) {
  if (!content) return;
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenamePart(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "layer";
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = zipTimestamp(new Date());

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const checksum = crc32(data);
    const localHeader = concatBytes(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    );
    localParts.push(localHeader, data);

    centralParts.push(concatBytes(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ));
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = concatBytes(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(offset), u16(0),
  );
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTimestamp(value) {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function u16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
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
          const baseName = filename.replace(/\.svg$/i, "");
          outputSvg = result.svg;
          outputName = `${baseName}-clipped.svg`;
          multilayerSvg = result.multilayerSvg;
          multilayerName = `${baseName}-multilayer.svg`;
          individualExports = result.layers.map((layer, index) => ({
            name: `${baseName}-${String(index + 1).padStart(2, "0")}-${filenamePart(layer.label)}.svg`,
            content: layer.svg,
          }));
          individualArchiveName = `${baseName}-layers.zip`;
          fileMeta.textContent = filename;
          showPreview(outputSvg);
          showExports(result.layers, result.optimization);
          setStatus(
            successMessage(result),
            "success",
          );
          return {
            groups: result.groups,
            sourceLines: result.sourceLines,
            clippedSegments: result.outputLines,
            filename: outputName,
            multilayerFilename: multilayerName,
            layerFilenames: individualExports.map((entry) => entry.name),
            registration: result.registration,
            optimization: result.optimization,
          };
        },
      }),
    ).catch(() => {});
  } catch {
    // Browsers without WebMCP keep the normal drop-and-download experience.
  }
}

registerWebMcpTool();
