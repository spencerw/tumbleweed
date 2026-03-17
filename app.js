// app.js
// File loading, rendering, and UI event handling.

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeBadge(type) {
  const cls   = { triggerOnce: 'once', triggerFront: 'front', triggerStart: 'start' }[type] || 'unk';
  const label = { once: 'ONCE', front: 'FRONT', start: 'START', unk: type || 'UNKNOWN' }[cls] || type;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// ── Mission bar ───────────────────────────────────────────────────────────────

function renderMissionBar(filename, theatre, date) {
  const dateStr = date ? `${date.Day}/${date.Month}/${date.Year}` : '—';
  return `
    <div class="chip"><span class="label">File</span><span class="value">${esc(filename)}</span></div>
    <div class="chip"><span class="label">Map</span><span class="value">${esc(theatre)}</span></div>
    <div class="chip"><span class="label">Date</span><span class="value">${dateStr}</span></div>
  `;
}

// ── Warnings ──────────────────────────────────────────────────────────────────

function renderWarnings(warnings) {
  const errors    = warnings.filter(w => w.severity === 'ERROR').length;
  const warnings_ = warnings.filter(w => w.severity === 'WARNING').length;

  const header = warnings.length === 0
    ? `<div class="warnings-header warnings-pass"><span class="warnings-icon">✓</span> QC check passed — no problems found.</div>`
    : `<div class="warnings-summary">Problems found: ${errors} error${errors !== 1 ? 's' : ''}, ${warnings_} warning${warnings_ !== 1 ? 's' : ''}.</div>`;

  const items = warnings.map(w => `
    <div class="warning ${w.severity === 'ERROR' ? 'warning-error' : 'warning-warn'}">
      <span class="warning-icon">${w.severity === 'ERROR' ? '✗' : '⚠'}</span>
      <span class="warning-text">${esc(w.message)}</span>
    </div>
  `).join('');

  return `<div class="warnings-section">${header}${items}</div>`;
}

// ── Trigger table ─────────────────────────────────────────────────────────────

function renderTriggerRow(t, depth = 0) {
  const indent      = depth * 24;
  const childMarker = depth > 0 ? `<span class="child-indicator">└</span> ` : '';

  const comment = t.comment
    ? `<span class="comment">${esc(t.comment)}</span>`
    : `<span class="comment empty">—</span>`;

  const rules = t.rules.length
    ? `<div class="pill-list">${t.rules.map(r => `<div class="pill cond">${esc(r)}</div>`).join('')}</div>`
    : `<span class="none">always</span>`;

  const actions = t.actions.length
    ? `<div class="pill-list">${t.actions.map(a => `<div class="pill act">${esc(a)}</div>`).join('')}</div>`
    : `<span class="none">none</span>`;

  const rowClass  = depth === 0 && t.children?.length > 0 ? 'row-root' : depth > 0 ? 'row-child' : '';
  const childRows = (t.children || []).map(c => renderTriggerRow(c, depth + 1)).join('');

  return `<tr class="${rowClass}">
    <td class="idx">${t.idx}</td>
    <td style="padding-left:${12 + indent}px">${childMarker}${comment}</td>
    <td>${typeBadge(t.type)}</td>
    <td>${rules}</td>
    <td>${actions}</td>
  </tr>${childRows}`;
}

function renderTriggers(tree) {
  const { roots, isolated } = tree;
  if (!roots.length && !isolated.length) return '<p class="none">No triggers found.</p>';

  const rootRows     = roots.map(t => renderTriggerRow(t, 0)).join('');
  const isolatedRows = isolated.map(t => renderTriggerRow(t, 0)).join('');

  return `
    <table id="trigger-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Comment</th>
          <th>Type</th>
          <th>Conditions</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rootRows}</tbody>
      ${isolated.length ? `<tbody class="isolated-group"><tr><td colspan="6" class="group-label">Isolated Triggers</td></tr></tbody><tbody>${isolatedRows}</tbody>` : ''}
    </table>
  `;
}

// ── Dependency graph (D3) ─────────────────────────────────────────────────────

function renderGraph(triggers, edges) {
  const allIds = new Set(triggers.map(t => t.idx));

  const section = document.getElementById('graph-section');
  if (allIds.size === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const triggerMap = new Map(triggers.map(t => [t.idx, t]));
  const commentOf  = new Map(triggers.map(t => [t.idx, t.comment || `#${t.idx}`]));
  const roleOf     = new Map(triggers.map(t => [t.idx, t.chainDepth?.role || 'leaf']));

  const chainEdges = [];
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if (allIds.has(from) && allIds.has(to))
        chainEdges.push({ source: from, target: to });
    }
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  const inDegree = new Map([...allIds].map(id => [id, 0]));
  for (const { target } of chainEdges) inDegree.set(target, (inDegree.get(target) || 0) + 1);

  const col = new Map();
  const queue = [...allIds].filter(id => inDegree.get(id) === 0);
  queue.forEach(id => col.set(id, 0));

  const adjOut = new Map([...allIds].map(id => [id, []]));
  for (const { source, target } of chainEdges) adjOut.get(source).push(target);

  const visited = new Set(queue);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const child of adjOut.get(id) || []) {
      col.set(child, Math.max(col.get(child) || 0, (col.get(id) || 0) + 1));
      if (!visited.has(child)) { visited.add(child); queue.push(child); }
    }
  }

  const byCol = new Map();
  for (const id of allIds) {
    const c = col.get(id) || 0;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(id);
  }

  // Node dimensions
  const HEADER_H  = 32;
  const COND_H    = 17;
  const COND_PAD  = 8;
  const COL_GAP   = 40;  // gap between columns (added to node widths)
  const ROW_GAP   = 16;
  const PAD       = 40;
  const MIN_W     = 180;
  const TEXT_PAD  = 20;  // horizontal padding inside node

  // Measure text width using a hidden SVG element
  const measureSvg = d3.select(document.body).append('svg')
    .attr('visibility', 'hidden')
    .style('position', 'absolute');

  function measureText(text, fontFamily, fontSize) {
    const t = measureSvg.append('text')
      .attr('font-family', fontFamily)
      .attr('font-size', fontSize)
      .text(text);
    const w = t.node().getBBox().width;
    t.remove();
    return w;
  }

  // Calculate per-node width based on longest text line
  const nodeW = new Map();
  for (const id of allIds) {
    const t = triggerMap.get(id);
    const comment = commentOf.get(id) || `#${id}`;
    let maxTextW = measureText(comment, 'Barlow, sans-serif', '13px');
    for (const rule of (t?.rules || [])) {
      maxTextW = Math.max(maxTextW, measureText(rule, 'Share Tech Mono, monospace', '10px'));
    }
    for (const action of (t?.actions || [])) {
      maxTextW = Math.max(maxTextW, measureText(action, 'Share Tech Mono, monospace', '10px'));
    }
    nodeW.set(id, Math.max(MIN_W, maxTextW + TEXT_PAD * 2));
  }

  measureSvg.remove();

  function nodeHeight(id) {
    const t      = triggerMap.get(id);
    const nConds = t?.rules?.length   || 0;
    const nActs  = t?.actions?.length || 0;
    const condsH = nConds > 0 ? COND_PAD + nConds * COND_H + COND_PAD : 0;
    const actsH  = nActs  > 0 ? COND_PAD + nActs  * COND_H + COND_PAD : 0;
    return HEADER_H + condsH + actsH;
  }

  // Build parent lookup: child → [parent, ...]
  const parents = new Map([...allIds].map(id => [id, []]));
  for (const { source, target } of chainEdges) {
    parents.get(target).push(source);
  }

  // Track max node width per column for column x positioning
  const colMaxW = new Map();
  for (const [c, ids] of byCol) {
    colMaxW.set(c, Math.max(...ids.map(id => nodeW.get(id))));
  }

  // Calculate column x offsets
  const sortedCols = [...byCol.keys()].sort((a, b) => a - b);
  const colX = new Map();
  let xOffset = PAD;
  for (const c of sortedCols) {
    colX.set(c, xOffset);
    xOffset += colMaxW.get(c) + COL_GAP + PAD;
  }

  // Assign positions column by column, sorting each column by parent y after
  // the previous column has been positioned
  const pos = new Map();
  let maxW = 0;
  let maxH = 0;

  for (const c of sortedCols) {
    const ids = byCol.get(c);

    // Sort: nodes with children first, then by average parent y (or idx for col 0)
    ids.sort((a, b) => {
      const aHasChildren = (adjOut.get(a) || []).length > 0;
      const bHasChildren = (adjOut.get(b) || []).length > 0;

      // Nodes with children come before isolated nodes in the same column
      if (aHasChildren !== bHasChildren) return aHasChildren ? -1 : 1;

      if (c === 0) return a - b;

      // Sort by average y of parents that have already been positioned
      const parentY = id => {
        const ps = (parents.get(id) || []).filter(p => pos.has(p));
        return ps.length
          ? ps.reduce((sum, p) => sum + pos.get(p).y, 0) / ps.length
          : Infinity;
      };
      return parentY(a) - parentY(b);
    });

    let y = PAD;
    const x = colX.get(c) + colMaxW.get(c) / 2;
    maxW = Math.max(maxW, colX.get(c) + colMaxW.get(c) + PAD);
    for (const id of ids) {
      const h = nodeHeight(id);
      pos.set(id, { x, y: y + h / 2 });
      y += h + ROW_GAP;
    }
    maxH = Math.max(maxH, y);
  }

  const W = Math.max(maxW, 600);
  const H = Math.max(maxH + PAD, 200);

  // Colors
  const colors = {
    root:         { fill: 'rgba(255,107,53,0.15)', stroke: '#ff6b35', title: '#ff6b35', cond: '#c8843a' },
    intermediate: { fill: 'rgba(0,229,255,0.08)',  stroke: '#00e5ff', title: '#00e5ff', cond: '#4ab8c8' },
    leaf:         { fill: '#141820',               stroke: '#4a5568', title: '#8899aa', cond: '#667788' },
  };

  const container = document.getElementById('cy');
  container.innerHTML = '';

  const CANVAS_H = 900;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', CANVAS_H)
    .style('cursor', 'grab');

  svg.append('defs').append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#2a3444');

  // Zoomable/pannable container
  const g = svg.append('g');

  svg.call(d3.zoom()
    .scaleExtent([0.2, 3])
    .on('zoom', e => g.attr('transform', e.transform))
  );

  // Edges
  g.append('g').selectAll('line')
    .data(chainEdges).enter().append('line')
      .attr('x1', d => pos.get(d.source).x + nodeW.get(d.source) / 2)
      .attr('y1', d => pos.get(d.source).y)
      .attr('x2', d => pos.get(d.target).x - nodeW.get(d.target) / 2 - 8)
      .attr('y2', d => pos.get(d.target).y)
      .attr('stroke', '#2a3444')
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arrow)');

  // Nodes
  const node = g.append('g').selectAll('g')
    .data([...allIds]).enter().append('g')
      .attr('transform', id => {
        const { x, y } = pos.get(id);
        return `translate(${x - nodeW.get(id) / 2},${y - nodeHeight(id) / 2})`;
      });

  // Background rect
  node.append('rect')
    .attr('width',  id => nodeW.get(id))
    .attr('height', id => nodeHeight(id))
    .attr('rx', 4)
    .attr('fill',         id => colors[roleOf.get(id)]?.fill   || colors.leaf.fill)
    .attr('stroke',       id => colors[roleOf.get(id)]?.stroke || colors.leaf.stroke)
    .attr('stroke-width', id => roleOf.get(id) === 'root' ? 2 : 1);

  // Header divider
  node.append('line')
    .attr('x1', 0).attr('x2', id => nodeW.get(id))
    .attr('y1', HEADER_H).attr('y2', HEADER_H)
    .attr('stroke', id => colors[roleOf.get(id)]?.stroke || colors.leaf.stroke)
    .attr('stroke-opacity', 0.3)
    .attr('stroke-width', 1);

  // Comment label
  node.append('text')
    .attr('x', id => nodeW.get(id) / 2)
    .attr('y', HEADER_H / 2)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('font-family', 'Barlow, sans-serif')
    .attr('font-size', '13px')
    .attr('font-weight', id => roleOf.get(id) === 'root' ? 'bold' : 'normal')
    .attr('fill', id => colors[roleOf.get(id)]?.title || colors.leaf.title)
    .text(id => commentOf.get(id) || `#${id}`);

  // Condition lines
  node.each(function(id) {
    const t = triggerMap.get(id);
    const role      = roleOf.get(id);
    const condColor = colors[role]?.cond || colors.leaf.cond;
    const actColor  = colors[role]?.title || colors.leaf.title;
    const nConds    = t?.rules?.length   || 0;
    const nActs     = t?.actions?.length || 0;

    // Conditions
    (t?.rules || []).forEach((rule, i) => {
      d3.select(this).append('text')
        .attr('x', 8)
        .attr('y', HEADER_H + COND_PAD + i * COND_H + COND_H / 2)
        .attr('dominant-baseline', 'middle')
        .attr('font-family', 'Share Tech Mono, monospace')
        .attr('font-size', '10px')
        .attr('fill', condColor)
        .text(rule);
    });

    if (nConds === 0 || nActs === 0) return;

    // Divider between conditions and actions
    const divY = HEADER_H + COND_PAD + nConds * COND_H + COND_PAD;
    d3.select(this).append('line')
      .attr('x1', 0).attr('x2', nodeW.get(id))
      .attr('y1', divY).attr('y2', divY)
      .attr('stroke', colors[role]?.stroke || colors.leaf.stroke)
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', 1);

    // Actions
    (t?.actions || []).forEach((action, i) => {
      d3.select(this).append('text')
        .attr('x', 8)
        .attr('y', divY + COND_PAD + i * COND_H + COND_H / 2)
        .attr('dominant-baseline', 'middle')
        .attr('font-family', 'Share Tech Mono, monospace')
        .attr('font-size', '10px')
        .attr('fill', actColor)
        .attr('opacity', 0.7)
        .text(action);
    });
  });
}

// ── File loading ──────────────────────────────────────────────────────────────

async function loadMiz(file) {
  try {
    const zip = await JSZip.loadAsync(file);

    const theatreFile = zip.file('theatre');
    const theatre = theatreFile ? (await theatreFile.async('string')).trim() : 'Unknown';

    const missionFile = zip.file('mission');
    if (!missionFile) throw new Error('No mission file found in archive');

    const missionText        = await missionFile.async('string');
    const mission            = parseLua(missionText);
    const { triggers, edges } = getTriggers(mission);
    const tree     = buildTriggerTree(triggers, edges);
    const warnings = runChecks(mission, triggers, edges);

    document.getElementById('mission-bar').innerHTML     = renderMissionBar(file.name, theatre, mission?.date);
    document.getElementById('trigger-count').textContent = `${triggers.length} found`;
    document.getElementById('trigger-list').innerHTML    = renderTriggers(tree);
    document.getElementById('warnings-list').innerHTML  = renderWarnings(warnings);

    renderGraph(triggers, edges);

    document.getElementById('dropzone').style.display = 'none';
    document.getElementById('app').classList.add('visible');

  } catch (e) {
    alert('Error loading mission: ' + e.message);
    console.error(e);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

const dropzone  = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');

fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadMiz(e.target.files[0]);
});

dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadMiz(e.dataTransfer.files[0]);
});
