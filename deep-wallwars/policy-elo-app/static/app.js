const SVG_NS = "http://www.w3.org/2000/svg";
const palette = {};
let variantNames = {};
let data;
let enabled = new Set();
let view = "all";

const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};
const compact = value => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function setupControls() {
  const root = document.querySelector("#line-controls");
  const groups = data.conditions.reduce((result, item) => {
    (result[item.variant] ??= []).push(item);
    return result;
  }, {});
  Object.entries(groups).forEach(([variant, conditions]) => {
    const group = document.createElement("section");
    group.className = "variant-group";
    group.innerHTML = `<div class="variant-name">${variantNames[variant]}</div>`;
    conditions.forEach(condition => {
      enabled.add(condition.id);
      const clean = condition.components.reduce((sum, component) => sum + component.cleanGames, 0);
      const edgeCounts = condition.components.flatMap(component => [component.minCleanGamesPerEdge, component.maxCleanGamesPerEdge]);
      const minPerEdge = edgeCounts.length ? Math.min(...edgeCounts) : null;
      const maxPerEdge = edgeCounts.length ? Math.max(...edgeCounts) : null;
      const edgeWeight = minPerEdge === null ? "no rated edges" : (minPerEdge === maxPerEdge ? `${minPerEdge}/edge` : `${minPerEdge}–${maxPerEdge}/edge`);
      const label = document.createElement("label");
      label.className = `line-toggle ${condition.setup === "random-start" ? "random" : "fixed"}`;
      label.style.setProperty("--line", palette[condition.id]);
      const scaleNote = condition.components.length ? `${condition.components.length} local scale${condition.components.length === 1 ? "" : "s"}` : "no connected evidence";
      const prefix = `${variantNames[variant]} `;
      const shortLabel = condition.label.startsWith(prefix) ? condition.label.slice(prefix.length) : condition.label;
      label.innerHTML = `<span class="swatch"></span><span class="line-copy"><b>${shortLabel}</b><small>${compact(clean)} clean · ${edgeWeight} · ${scaleNote}</small></span><input type="checkbox" checked aria-label="Show ${condition.label}"><span class="check"></span>`;
      label.querySelector("input").addEventListener("change", event => {
        event.target.checked ? enabled.add(condition.id) : enabled.delete(condition.id);
        render(); updateAllButton();
      });
      group.append(label);
    });
    root.append(group);
  });
  document.querySelector("#toggle-all").addEventListener("click", () => {
    const shouldEnable = enabled.size !== data.conditions.length;
    enabled = new Set(shouldEnable ? data.conditions.map(item => item.id) : []);
    document.querySelectorAll(".line-toggle input").forEach(input => input.checked = shouldEnable);
    updateAllButton(); render();
  });
  document.querySelectorAll(".view-switch button").forEach(button => button.addEventListener("click", () => {
    view = button.dataset.view;
    document.querySelectorAll(".view-switch button").forEach(item => item.classList.toggle("active", item === button));
    render();
  }));
}

function updateAllButton() {
  document.querySelector("#toggle-all").textContent = enabled.size ? "Hide all" : "Show all";
}

function visibleConditions() {
  return data.conditions.filter(condition => enabled.has(condition.id) && (view === "all" || condition.setup === view));
}

function render() {
  const svg = document.querySelector("#plot");
  const wrap = document.querySelector("#plot-wrap");
  const width = wrap.clientWidth || 900, height = wrap.clientHeight || 530;
  const margin = { top: 34, right: 20, bottom: 44, left: 55 };
  const innerW = width - margin.left - margin.right, innerH = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const defs = svgEl("defs");
  const pattern = svgEl("pattern", { id: "hatch", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pattern.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 8, stroke: "#4c596a", "stroke-width": 2 }));
  defs.append(pattern); svg.append(defs);
  const conditions = visibleConditions();
  const evidenceGenerations = [...new Set(conditions.flatMap(item => item.components.flatMap(component => component.generations)))].sort((a,b) => a-b);
  const globalEvidenceGenerations = [...new Set(data.conditions.flatMap(item => item.components.flatMap(component => component.generations)))].sort((a,b) => a-b);
  const coverageMax = Math.max(...data.artifactCoverage.map(item => item.end));
  const generationMax = Math.max(coverageMax, ...globalEvidenceGenerations, 1);
  const values = conditions.flatMap(item => item.components.flatMap(component => component.ratings.map(point => point.elo)));
  const maxY = Math.max(200, Math.ceil((Math.max(...values, 200) + 40) / 100) * 100);
  const x = generation => margin.left + generation / generationMax * innerW;
  const y = elo => margin.top + innerH - elo / maxY * innerH;
  data.artifactCoverage.filter(item => item.status === "missing").forEach(item => {
    svg.append(svgEl("rect", { class: "missing-band", x: x(item.start), y: margin.top, width: Math.max(2, x(item.end+1)-x(item.start)), height: innerH }));
  });
  const evidenceGaps = globalEvidenceGenerations.slice(1).flatMap((generation, index) => {
    const previous = globalEvidenceGenerations[index];
    return generation - previous > 1 ? [{ start: previous+1, end: generation-1, next: generation }] : [];
  });
  evidenceGaps.forEach(gap => {
    svg.append(svgEl("rect", { class: "incompatible-band", x: x(gap.start), y: margin.top, width: x(gap.next)-x(gap.start), height: innerH }));
    const label = svgEl("text", { class: "gap-label", x: (x(gap.start)+x(gap.next))/2, y: margin.top+18, "text-anchor": "middle" });
    label.textContent = `${gap.start}–${gap.end} · NO CONNECTED EVIDENCE`; svg.append(label);
  });
  (data.resultRuleBoundaries ?? []).forEach(boundary => {
    const boundaryX = x(boundary.generation);
    svg.append(svgEl("line", { class: "rule-boundary", x1: boundaryX, x2: boundaryX, y1: margin.top, y2: margin.top+innerH }));
    const label = svgEl("text", { class: "rule-boundary-label", x: boundaryX-5, y: margin.top+12, "text-anchor": "end" });
    label.textContent = boundary.label; svg.append(label);
  });
  const componentRanges = new Map();
  conditions.forEach(condition => condition.components.forEach(component => {
    const start = Math.min(...component.generations), end = Math.max(...component.generations);
    componentRanges.set(`${start}-${end}`, { start, end });
  }));
  componentRanges.forEach(range => {
    const label = svgEl("text", { class: "component-label", x: (x(range.start)+x(range.end))/2, y: 16, "text-anchor": "middle" });
    label.textContent = `${range.start}–${range.end} COMPONENTS · LOCAL ELO`; svg.append(label);
  });
  for (let tick = 0; tick <= maxY; tick += 100) {
    svg.append(svgEl("line", { class: "grid-line", x1: margin.left, x2: width-margin.right, y1: y(tick), y2: y(tick) }));
    const label = svgEl("text", { class: "axis-label", x: margin.left-10, y: y(tick)+3, "text-anchor": "end" }); label.textContent = tick; svg.append(label);
  }
  const xTicks = [...Array(Math.floor(generationMax/20)+1)].map((_,index) => index*20);
  if (xTicks.at(-1) !== generationMax) xTicks.push(generationMax);
  xTicks.forEach(tick => {
    svg.append(svgEl("line", { class: "grid-line", x1: x(tick), x2: x(tick), y1: margin.top, y2: margin.top+innerH }));
    const label = svgEl("text", { class: "axis-label", x: x(tick), y: height-17, "text-anchor": "middle" }); label.textContent = tick; svg.append(label);
  });
  const yTitle = svgEl("text", { class: "axis-title", x: 12, y: margin.top + innerH/2, transform: `rotate(-90 12 ${margin.top + innerH/2})`, "text-anchor": "middle" }); yTitle.textContent = "Relative Elo"; svg.append(yTitle);
  const xTitle = svgEl("text", { class: "axis-title", x: margin.left+innerW/2, y: height-1, "text-anchor": "middle" }); xTitle.textContent = "Model generation"; svg.append(xTitle);
  const points = [];
  conditions.forEach(condition => condition.components.forEach((component, componentIndex) => {
    const sorted = [...component.ratings].sort((a,b) => a.generation-b.generation);
    const d = sorted.map((point,index) => `${index ? "L" : "M"}${x(point.generation).toFixed(2)},${y(point.elo).toFixed(2)}`).join(" ");
    svg.append(svgEl("path", { d, class: `series ${condition.setup === "random-start" ? "random" : "fixed"} ${componentIndex ? "disconnected" : ""}`, stroke: palette[condition.id] }));
    sorted.forEach(point => {
      const circle = svgEl("circle", { class: "point", cx: x(point.generation), cy: y(point.elo), r: 2.7, fill: palette[condition.id] });
      svg.append(circle); points.push({ condition, component, point, px:x(point.generation), py:y(point.elo) });
    });
  }));
  const overlay = svgEl("rect", { x: margin.left, y: margin.top, width: innerW, height: innerH, fill: "transparent" }); svg.append(overlay);
  const tooltip = document.querySelector("#tooltip");
  overlay.addEventListener("mousemove", event => {
    if (!points.length) return;
    const bounds = svg.getBoundingClientRect();
    const mx = (event.clientX-bounds.left)/bounds.width*width, my=(event.clientY-bounds.top)/bounds.height*height;
    const nearest = points.reduce((best,item) => Math.hypot(item.px-mx,item.py-my) < best.distance ? { item, distance:Math.hypot(item.px-mx,item.py-my) } : best, {distance:Infinity}).item;
    tooltip.hidden = false;
    const perEdge = nearest.component.minCleanGamesPerEdge === nearest.component.maxCleanGamesPerEdge ? `${nearest.component.minCleanGamesPerEdge}` : `${nearest.component.minCleanGamesPerEdge}–${nearest.component.maxCleanGamesPerEdge}`;
    const independence = nearest.condition.setup === "random-start" ? "independently seeded" : "deterministic seat orders";
    tooltip.innerHTML = `<b style="color:${palette[nearest.condition.id]}">${nearest.condition.label}</b><span>Generation ${nearest.point.generation} · ${Math.round(nearest.point.elo)} component-local Elo</span><span>${nearest.point.games} games involving this model</span><span>${perEdge} clean ${independence} per edge</span><span>${nearest.component.cleanGames.toLocaleString()} clean games in component</span><em>Not comparable vertically across disconnected components.</em>`;
    const left = Math.min(wrap.clientWidth-190, Math.max(8, event.clientX-wrap.getBoundingClientRect().left+14));
    const top = Math.min(wrap.clientHeight-90, Math.max(8, event.clientY-wrap.getBoundingClientRect().top-45));
    tooltip.style.left=`${left}px`; tooltip.style.top=`${top}px`;
  });
  overlay.addEventListener("mouseleave", () => tooltip.hidden = true);
}

async function init() {
  const response = await fetch("/api/data");
  data = await response.json();
  if (!response.ok) throw new Error(data.error || "Evidence snapshot unavailable");
  data.conditions.forEach(condition => palette[condition.id] = condition.color);
  variantNames = data.variantLabels;
  const clean = data.conditions.reduce((sum,item) => sum + item.components.reduce((value,c) => value+c.cleanGames,0),0);
  const excluded = data.conditions.reduce((sum,item) => sum + item.unconnectedExcludedGames + item.components.reduce((value,c) => value+c.excludedGames,0),0);
  document.querySelector("#clean-games").textContent = clean.toLocaleString();
  document.querySelector("#excluded-games").textContent = excluded.toLocaleString();
  const loadable = data.artifactCoverage.filter(item => item.status === "available");
  document.querySelector("#loadable-range").textContent = loadable.map(item => item.start === item.end ? item.start : `${item.start}–${item.end}`).join(", ");
  document.querySelector("#updated").textContent = `Snapshot ${new Date(data.generatedAtUtc).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}`;
  const newestGeneration = Math.max(...data.conditions.flatMap(condition => condition.evidenceGenerations));
  const currentComponents = setup => data.conditions.filter(condition => condition.setup === setup).flatMap(condition => condition.components.filter(component => component.generations.includes(newestGeneration)));
  const range = components => {
    const low = Math.min(...components.map(component => component.minCleanGamesPerEdge));
    const high = Math.max(...components.map(component => component.maxCleanGamesPerEdge));
    return low === high ? `${low}` : `${low}–${high}`;
  };
  document.querySelector("#weight-note").innerHTML = `<b>Evidence weight at current generations:</b> fixed lines use ${range(currentComponents("fixed"))} deterministic seat-swapped games per edge; Random Start lines use ${range(currentComponents("random-start"))} independently seeded games per edge.`;
  document.querySelector("#settings").innerHTML = [
    ["Search", `${data.settings.samples} sample`], ["Root noise", data.settings.rootNoiseFactor],
    ["Move choice", data.settings.moveSelection], ["Fit", "Bradley–Terry + draw prior"],
    ["Result rule", "Generation 150 uses current rules; earlier points are preserved legacy-rule evidence"],
    ["Rating scope", data.ratingScope.reason],
    ["Scale", "Weakest = 0 per component"], ["Failures", "Quarantined before fit"],
    ["Next batch", `${data.incrementalPlan.summary.pairings} short pairings · ${data.incrementalPlan.summary.acceptedGamesNeeded} clean games needed`],
  ].map(([key,value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  const track = document.querySelector("#coverage-track");
  const labels = document.querySelector("#coverage-labels");
  const columns = data.artifactCoverage.map(item => Math.max(1, item.end-item.start+1)).join("fr ") + "fr";
  track.style.gridTemplateColumns = columns; labels.style.gridTemplateColumns = columns;
  track.innerHTML = data.artifactCoverage.map(item => `<span class="${item.status}"></span>`).join("");
  labels.innerHTML = data.artifactCoverage.map(item => `<div><strong>${item.start === item.end ? item.start : `${item.start}–${item.end}`}</strong><span>${item.label}</span></div>`).join("");
  const provenance = {};
  data.conditions.forEach(condition => {
    const sourceGroups = [...condition.components.map(component => component.sources), condition.unconnectedSources];
    sourceGroups.forEach(sources => Object.entries(sources).forEach(([name, source]) => {
      const target = provenance[name] ??= { clean: 0, excluded: 0, rawFiles: new Set() };
      target.clean += source.clean; target.excluded += source.excluded;
      source.rawFiles.forEach(file => target.rawFiles.add(file));
    }));
  });
  const sourceEntries = Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b));
  document.querySelector("#provenance-summary").textContent = `${sourceEntries.length} archived evidence sources`;
  document.querySelector("#provenance-list").innerHTML = sourceEntries.map(([name, source]) =>
    `<div><code title="${name}">${name}</code><span>${source.clean.toLocaleString()} clean · ${source.excluded} excluded · ${source.rawFiles.size} raw file${source.rawFiles.size === 1 ? "" : "s"}</span></div>`
  ).join("");
  setupControls(); render();
  addEventListener("resize", render);
}
init().catch(error => {
  document.querySelector("#updated").textContent = error.message;
  document.querySelector("#updated").style.color = "#ff806d";
});
