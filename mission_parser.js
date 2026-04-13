// mission_parser.js
// Extracts structured data from a parsed DCS mission object.

// ── Name lookup tables ────────────────────────────────────────────────────────

function buildGroupNames(mission) {
  // Returns Map<groupId, groupName>
  const map = new Map();
  const coalitions = mission?.coalition || {};
  for (const side of Object.values(coalitions)) {
    for (const country of Object.values(side?.country || {})) {
      for (const category of ['plane', 'helicopter', 'vehicle', 'ship', 'static']) {
        for (const group of Object.values(country?.[category]?.group || {})) {
          if (group?.groupId != null && group?.name) {
            map.set(group.groupId, group.name);
          }
        }
      }
    }
  }
  return map;
}

function buildUnitNames(mission) {
  // Returns Map<unitId, unitName>
  const map = new Map();
  const coalitions = mission?.coalition || {};
  for (const side of Object.values(coalitions)) {
    for (const country of Object.values(side?.country || {})) {
      for (const category of ['plane', 'helicopter', 'vehicle', 'ship', 'static']) {
        for (const group of Object.values(country?.[category]?.group || {})) {
          for (const unit of Object.values(group?.units || {})) {
            if (unit?.unitId != null && unit?.name) {
              map.set(unit.unitId, unit.name);
            }
          }
        }
      }
    }
  }
  return map;
}

function buildZoneNames(mission) {
  // Returns Map<zoneId, zoneName>
  const map = new Map();
  const zones = mission?.triggers?.zones || {};
  for (const zone of Object.values(zones)) {
    if (zone?.zoneId != null && zone?.name) {
      map.set(zone.zoneId, zone.name);
    }
  }
  return map;
}

// Helpers that format IDs with names when available
function gname(id, groupNames) {
  const name = groupNames.get(id);
  return name ? `"${name}"` : `group ${id}`;
}

function uname(id, unitNames) {
  const name = unitNames?.get(id);
  return name ? `"${name}"` : `unit ${id}`;
}

function zname(id, zoneNames) {
  const name = zoneNames.get(id);
  return name ? `"${name}"` : `zone ${id}`;
}

// ── Raw dependency extraction (operates on raw rule/action objects) ───────────

function flagsSetBy(actions) {
  // Returns Set of flag names set by this trigger's actions
  const flags = new Set();
  if (!actions) return flags;
  for (const a of Object.values(actions)) {
    if (typeof a !== 'object') continue;
    if (a.predicate === 'a_set_flag' && a.flag != null)           flags.add(String(a.flag));
    if (a.predicate === 'a_set_flag_value' && a.flag != null)     flags.add(String(a.flag));
    if (a.predicate === 'a_add_radio_item_for_group' && a.flag)   flags.add(String(a.flag));
  }
  return flags;
}

function flagsCheckedBy(rules) {
  // Returns Set of flag names checked by this trigger's conditions
  const flags = new Set();
  if (!rules) return flags;
  for (const r of Object.values(rules)) {
    if (typeof r !== 'object') continue;
    if (['c_flag_equals','c_flag_is_true','c_flag_is_false','c_time_since_flag'].includes(r.predicate) && r.flag != null)
      flags.add(String(r.flag));
  }
  return flags;
}

function groupsActivatedBy(actions) {
  const groups = new Set();
  if (!actions) return groups;
  for (const a of Object.values(actions)) {
    if (typeof a !== 'object') continue;
    if (a.predicate === 'a_activate_group' && a.group != null) groups.add(a.group);
    // a_ai_task also causes a group to act — treat as implicit activation
    if (a.predicate === 'a_ai_task' && a.ai_task?.[1] != null) groups.add(a.ai_task[1]);
  }
  return groups;
}

function groupsCheckedBy(rules) {
  const groups = new Set();
  if (!rules) return groups;
  for (const r of Object.values(rules)) {
    if (typeof r !== 'object') continue;
    if (r.group != null) groups.add(r.group);
  }
  return groups;
}

// ── Dependency graph ──────────────────────────────────────────────────────────

function buildDependencyGraph(rawTriggers) {
  // rawTriggers: array of { idx, rules, actions } with raw (unparsed) objects
  // Returns Map<idx, Set<idx>> of outgoing edges (A → B means A unlocks B)

  const edges = new Map();
  for (const t of rawTriggers) edges.set(t.idx, new Set());

  // Index: flag name → triggers that check it
  const flagCheckers  = new Map(); // flag → [idx, ...]
  // Index: group id  → triggers that check it
  const groupCheckers = new Map(); // groupId → [idx, ...]

  for (const t of rawTriggers) {
    for (const flag of flagsCheckedBy(t.rules)) {
      if (!flagCheckers.has(flag)) flagCheckers.set(flag, []);
      flagCheckers.get(flag).push(t.idx);
    }
    for (const gid of groupsCheckedBy(t.rules)) {
      if (!groupCheckers.has(gid)) groupCheckers.set(gid, []);
      groupCheckers.get(gid).push(t.idx);
    }
  }

  // Draw edges
  for (const t of rawTriggers) {
    for (const flag of flagsSetBy(t.actions)) {
      for (const downstream of (flagCheckers.get(flag) || [])) {
        if (downstream !== t.idx) edges.get(t.idx).add(downstream);
      }
    }
    for (const gid of groupsActivatedBy(t.actions)) {
      for (const downstream of (groupCheckers.get(gid) || [])) {
        if (downstream !== t.idx) edges.get(t.idx).add(downstream);
      }
    }
  }

  return edges;
}

function computeChainDepths(edges) {
  // Returns Map<idx, { role, value }> where:
  //   role='root'         value = total chain depth (no incoming, chain > 1)
  //   role='intermediate' value = number of direct children (has both incoming and outgoing)
  //   role='leaf'         value = null  (has incoming, no outgoing) -> show -
  //   not set             isolated (no edges at all)                -> show nothing

  const inDegree = new Map();
  for (const [from, tos] of edges) {
    if (!inDegree.has(from)) inDegree.set(from, 0);
    for (const to of tos) {
      inDegree.set(to, (inDegree.get(to) || 0) + 1);
    }
  }

  const memo = new Map();
  function longestPath(idx) {
    if (memo.has(idx)) return memo.get(idx);
    const children = edges.get(idx) || new Set();
    if (children.size === 0) { memo.set(idx, 1); return 1; }
    const depth = 1 + Math.max(...[...children].map(longestPath));
    memo.set(idx, depth);
    return depth;
  }

  const result = new Map();
  for (const idx of edges.keys()) {
    const hasIncoming = (inDegree.get(idx) || 0) > 0;
    const children    = edges.get(idx) || new Set();
    const hasOutgoing = children.size > 0;

    if (!hasIncoming && hasOutgoing) {
      result.set(idx, { role: 'root', value: longestPath(idx) });
    } else if (hasIncoming && hasOutgoing) {
      result.set(idx, { role: 'intermediate', value: children.size });
    } else if (hasIncoming && !hasOutgoing) {
      result.set(idx, { role: 'leaf', value: null });
    }
  }

  return result;
}



// ── Trigger extraction ────────────────────────────────────────────────────────

function getTriggers(mission) {
  const groupNames = buildGroupNames(mission);
  const unitNames  = buildUnitNames(mission);
  const zoneNames  = buildZoneNames(mission);
  const triggers   = [];

  // Newer trigrules format
  const tr = mission?.trigrules;
  if (tr) {
    const rawTriggers = [];
    for (const k of Object.keys(tr)) {
      const t = tr[k];
      if (typeof t !== 'object') continue;
      rawTriggers.push({ idx: parseInt(k), rules: t.rules, actions: t.actions });
    }

    const edges  = buildDependencyGraph(rawTriggers);
    const depths = computeChainDepths(edges);

    // Build flag → setter comment map
    // e.g. flag "1" is set by "Strike Package Flag" trigger
    const flagLabels = new Map();
    for (const k of Object.keys(tr)) {
      const t = tr[k];
      if (typeof t !== 'object' || !t.comment) continue;
      for (const a of Object.values(t.actions || {})) {
        if (typeof a !== 'object') continue;
        if (a.predicate === 'a_set_flag' && a.flag != null)
          flagLabels.set(String(a.flag), t.comment);
        if (a.predicate === 'a_set_flag_value' && a.flag != null)
          flagLabels.set(String(a.flag), t.comment);
        if (a.predicate === 'a_add_radio_item_for_group' && a.flag != null)
          flagLabels.set(String(a.flag), t.comment);
      }
    }

    // Count total descendants (not just chain depth) for each root/intermediate
    function countDescendants(idx, visited = new Set()) {
      if (visited.has(idx)) return 0;
      visited.add(idx);
      let count = 0;
      for (const child of (edges.get(idx) || [])) {
        count += 1 + countDescendants(child, visited);
      }
      return count;
    }

    for (const raw of rawTriggers) {
      const t = tr[String(raw.idx)];
      const d = depths.get(raw.idx);
      let chainDepth = undefined;
      if (d) {
        if (d.role === 'root' || d.role === 'intermediate') {
          chainDepth = { role: d.role, value: countDescendants(raw.idx) };
        } else {
          chainDepth = d; // leaf: keep as-is
        }
      }

      triggers.push({
        idx:        raw.idx,
        comment:    t.comment || '',
        type:       t.predicate || 'unknown',
        rules:      rulesFromObj(t.rules, groupNames, unitNames, zoneNames, flagLabels),
        actions:    actionsFromObj(t.actions, groupNames, flagLabels),
        chainDepth,
      });
    }
    triggers.sort((a, b) => a.idx - b.idx);
    return { triggers, edges };
  }

  // Older trig format (parallel arrays) — no graph analysis for now
  const trig = mission?.trig;
  if (trig) {
    const conds = trig.conditions || {};
    const acts  = trig.actions    || {};
    const funcs = trig.func       || {};

    const idxs = new Set([...Object.keys(conds), ...Object.keys(acts)].map(Number));
    for (const idx of [...idxs].sort((a, b) => a - b)) {
      const f = funcs[idx] || '';
      let type = 'triggerFront';
      if (f.includes(`func[${idx}]=nil`) || f.includes(`func[${idx}] = nil`))
        type = 'triggerOnce';

      triggers.push({
        idx,
        comment: '',
        type,
        rules:   conds[idx] ? [conds[idx]] : [],
        actions: acts[idx]  ? [acts[idx]]  : [],
      });
    }
  }

  return { triggers, edges: new Map() };
}

// ── Trigger tree ──────────────────────────────────────────────────────────────

function buildTriggerTree(triggers, edges) {
  // Returns { roots, isolated } where:
  //   roots:    triggers with no incoming edges that have children, each with a .children array
  //   isolated: triggers with no edges at all, flat list

  const triggerMap = new Map(triggers.map(t => [t.idx, { ...t, children: [] }]));

  // Determine which nodes have incoming edges
  const hasIncoming = new Set();
  for (const [from, tos] of edges) {
    for (const to of tos) hasIncoming.add(to);
  }

  // Attach children to parents
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const parent = triggerMap.get(from);
      const child  = triggerMap.get(to);
      if (parent && child) parent.children.push(child);
    }
  }

  const roots    = [];
  const isolated = [];

  for (const t of triggerMap.values()) {
    const isRoot     = !hasIncoming.has(t.idx);
    const hasChildren = t.children.length > 0;

    if (isRoot && hasChildren)  roots.push(t);
    else if (isRoot && !hasChildren && (edges.get(t.idx)?.size === 0 || !edges.has(t.idx))) isolated.push(t);
  }

  // Sort children by idx within each parent
  for (const root of roots) root.children.sort((a, b) => a.idx - b.idx);
  roots.sort((a, b) => a.idx - b.idx);
  isolated.sort((a, b) => a.idx - b.idx);

  return { roots, isolated };
}

function rulesFromObj(rules, groupNames, unitNames, zoneNames, flagLabels = new Map()) {
  if (!rules) return [];
  const items = Object.values(rules);
  if (!items.length) return [];

  const result = [];
  let nextOperator = null;

  for (const r of items) {
    if (typeof r !== 'object') continue;
    if (r.predicate === 'or')  { nextOperator = 'OR';  continue; }
    if (r.predicate === 'and') { nextOperator = 'AND'; continue; }

    const text = formatRule(r, groupNames, unitNames, zoneNames, flagLabels);

    // Append the operator that follows the previous condition
    if (nextOperator && result.length > 0) {
      result[result.length - 1] += ` ${nextOperator}`;
    }

    result.push(text);
    nextOperator = null;
  }

  return result;
}

function actionsFromObj(actions, groupNames, flagLabels = new Map()) {
  if (!actions) return [];
  return Object.values(actions)
    .filter(a => typeof a === 'object' && a.predicate)
    .map(a => formatAction(a, groupNames, flagLabels));
}

function flagLabel(flag, flagLabels) {
  const label = flagLabels.get(String(flag));
  return label ? `"${label}"` : `"${flag}"`;
}

function formatRule(r, groupNames, unitNames, zoneNames, flagLabels = new Map()) {
  const p  = r.predicate || '';
  const g  = id => gname(id, groupNames);
  const u  = id => uname(id, unitNames);
  const z  = id => zname(id, zoneNames);
  const fl = f  => flagLabel(f, flagLabels);

  if (p === 'c_flag_equals')               return `flag ${fl(r.flag)} = ${r.value}`;
  if (p === 'c_flag_is_true')              return `flag ${fl(r.flag)} is true`;
  if (p === 'c_time_since_flag')           return `${r.seconds}s since flag ${fl(r.flag)}`;
  if (p === 'c_time_after')                return `time > ${r.seconds}s`;
  if (p === 'c_unit_in_zone_unit')         return `${u(r.unit)} in ${z(r.zone)} (linked unit ${u(r.zoneunit)})`;
  if (p === 'c_unit_in_zone')              return `${u(r.unit)} in ${z(r.zone)}`;
  if (p === 'c_unit_altitude_higher')      return `${u(r.unit)} altitude > ${r.altitude}ft`;
  if (p === 'c_part_of_group_in_zone')     return `part of ${g(r.group)} in ${z(r.zone)}`;
  if (p === 'c_all_of_group_out_zone')     return `all of ${g(r.group)} out of ${z(r.zone)}`;
  if (p === 'c_part_of_coalition_in_zone') return `part of ${r.coalitionlist} in ${z(r.zone)}`;
  if (p === 'c_all_of_coalition_out_zone') return `all of ${r.coalitionlist} out of ${z(r.zone)}`;
  if (p === 'c_group_dead')                return `${g(r.group)} dead`;
  if (p === 'c_unit_dead')                 return `${u(r.unit)} dead`;
  if (p === 'c_unit_damaged')              return `${u(r.unit)} damaged`;
  if (p === 'c_missile_in_zone')           return `missile in ${z(r.zone)}`;
  return p + (r.flag ? ` ${fl(r.flag)}` : r.group ? ` ${g(r.group)}` : '');
}

function formatAction(a, groupNames, flagLabels = new Map()) {
  const p  = a.predicate || '';
  const g  = id => gname(id, groupNames);
  const fl = f  => flagLabel(f, flagLabels);

  if (p === 'a_set_flag')                     return `set flag ${fl(a.flag)}`;
  if (p === 'a_set_flag_value')               return `set flag ${fl(a.flag)} = ${a.value}`;
  if (p === 'a_clear_flag')                   return `clear flag ${fl(a.flag)}`;
  if (p === 'a_activate_group')               return `activate ${g(a.group)}`;
  if (p === 'a_deactivate_group')             return `deactivate ${g(a.group)}`;
  if (p === 'a_ai_task')                      return `AI task → ${g(a.ai_task?.[1])}, task ${a.ai_task?.[2]}`;
  if (p === 'a_add_radio_item_for_group')     return `add radio item to ${g(a.group)} (flag ${fl(a.flag)})`;
  if (p === 'a_remove_radio_item_for_group')  return `remove radio item from ${g(a.group)}`;
  if (p === 'a_out_text_delay_s')             return `message to ${a.coalitionlist}`;
  if (p === 'a_out_sound_s')                  return `play sound to ${a.coalitionlist}`;
  if (p === 'a_explosion_unit')               return `explosion on unit ${a.unit}`;
  if (p === 'a_do_script')                    return `run inline script`;
  if (p === 'a_do_script_file')               return `run script file`;
  if (p === 'a_set_ai_task')                  return `set AI task [${a.set_ai_task?.[1]}, ${a.set_ai_task?.[2]}]`;
  return p;
}

// ── QC checks ─────────────────────────────────────────────────────────────────

// ── Helper: walk all groups in mission ───────────────────────────────────────

function allGroups(mission) {
  const groups = [];
  const coalitions = mission?.coalition || {};
  for (const side of Object.values(coalitions)) {
    for (const country of Object.values(side?.country || {})) {
      for (const category of ['plane', 'helicopter', 'vehicle', 'ship', 'static']) {
        for (const group of Object.values(country?.[category]?.group || {})) {
          groups.push({ category, group });
        }
      }
    }
  }
  return groups;
}

// Walk all task IDs recursively in a waypoint task tree
function collectTaskIds(taskObj, out = new Set()) {
  if (!taskObj || typeof taskObj !== 'object') return out;
  if (taskObj.id) out.add(taskObj.id);
  for (const v of Object.values(taskObj)) {
    if (typeof v === 'object') collectTaskIds(v, out);
  }
  return out;
}

// ── runChecks ─────────────────────────────────────────────────────────────────

function runChecks(mission, triggers, edges) {
  // Each check category produces { label, issues: [{severity, message}] }
  const categories = [];

  const tr   = mission?.trigrules;
  const trig = mission?.trig;

  // ── Collect flags from both formats ───────────────────────────────────────
  const flagsSet     = new Set();
  const flagsChecked = new Map();

  if (tr) {
    for (const k of Object.keys(tr)) {
      const t = tr[k];
      if (typeof t !== 'object') continue;
      const comment = t.comment || `#${k}`;
      for (const a of Object.values(t.actions || {})) {
        if (typeof a !== 'object') continue;
        if ((a.predicate === 'a_set_flag' || a.predicate === 'a_set_flag_value') && a.flag != null)
          flagsSet.add(String(a.flag));
        if (a.predicate === 'a_add_radio_item_for_group' && a.flag != null)
          flagsSet.add(String(a.flag));
      }
      for (const r of Object.values(t.rules || {})) {
        if (typeof r !== 'object') continue;
        if (['c_flag_equals','c_flag_is_true','c_flag_is_false','c_time_since_flag'].includes(r.predicate) && r.flag != null) {
          const f = String(r.flag);
          if (!flagsChecked.has(f)) flagsChecked.set(f, []);
          flagsChecked.get(f).push(comment);
        }
      }
    }
  }

  if (trig) {
    for (const action of Object.values(trig.actions || {})) {
      if (typeof action !== 'string') continue;
      for (const m of action.matchAll(/a_set_flag(?:_value)?\(["']?(\w+)["']?[,)]/g))
        flagsSet.add(m[1]);
      for (const m of action.matchAll(/a_add_radio_item_for_group\([^,]+,[^,]+,\s*["'](\w+)["']/g))
        flagsSet.add(m[1]);
    }
    for (const [idx, condition] of Object.entries(trig.conditions || {})) {
      if (typeof condition !== 'string') continue;
      for (const m of condition.matchAll(/c_flag_(?:equals|is_true|is_false)\(["']?(\w+)["']?/g)) {
        const f = m[1];
        if (!flagsChecked.has(f)) flagsChecked.set(f, []);
        if (!flagsChecked.get(f).length) flagsChecked.get(f).push(`unnamed trigger #${idx}`);
      }
    }
  }

  // ── 1. Unset flags ────────────────────────────────────────────────────────
  {
    const issues = [];
    for (const [flag, checkers] of flagsChecked) {
      if (!flagsSet.has(flag)) {
        const unique = [...new Set(checkers)];
        issues.push({ severity: 'ERROR',
          message: `Flag "${flag}" is checked by ${unique.map(c=>`"${c}"`).join(', ')} but never set — condition can never be true.` });
      }
    }
    for (const flag of flagsSet) {
      if (!flagsChecked.has(flag)) {
        issues.push({ severity: 'WARNING',
          message: `Flag "${flag}" is set but never checked by any condition — may be unused or a leftover.` });
      }
    }
    categories.push({ label: 'Unset / unused flags', issues });
  }

  // ── 2. Duplicate trigger names ────────────────────────────────────────────
  {
    const issues = [];
    const nameCounts = new Map();
    if (tr) {
      for (const k of Object.keys(tr)) {
        const t = tr[k];
        if (typeof t !== 'object' || !t.comment) continue;
        nameCounts.set(t.comment, (nameCounts.get(t.comment) || 0) + 1);
      }
    }
    for (const [name, count] of nameCounts) {
      if (count > 1)
        issues.push({ severity: 'WARNING',
          message: `Trigger name "${name}" is used ${count} times — duplicate names make it hard to identify which trigger fired.` });
    }
    categories.push({ label: 'Duplicate trigger names', issues });
  }

  // ── 3. Empty triggers ─────────────────────────────────────────────────────
  {
    const issues = [];
    if (tr) {
      for (const k of Object.keys(tr)) {
        const t = tr[k];
        if (typeof t !== 'object') continue;
        const hasRules   = Object.keys(t.rules   || {}).length > 0;
        const hasActions = Object.keys(t.actions || {}).length > 0;
        if (!hasRules && !hasActions)
          issues.push({ severity: 'WARNING',
            message: `Trigger "${t.comment || '#'+k}" has no conditions and no actions.` });
      }
    }
    categories.push({ label: 'Empty triggers', issues });
  }

// ── 4. Isolated triggers ──────────────────────────────────────────────────
{
  const issues = [];

  // Build connection sets once (used by this check + circular dependency check)
  const hasIncoming = new Set();
  const hasOutgoing = new Set();

  for (const [from, tos] of edges) {
    if (tos.size > 0) {
      hasOutgoing.add(from);
      for (const to of tos) {
        hasIncoming.add(to);
      }
    }
  }

  if (tr) {
    for (const k of Object.keys(tr)) {
      const t = tr[k];
      if (typeof t !== 'object') continue;

      const idx = parseInt(k);
      const comment = t.comment || `#${k}`;

      // Does this trigger check any flag or activated group?
      const checksFlagOrGroup = Object.values(t.rules || {}).some(r => {
        if (!r || typeof r !== 'object') return false;
        // Flag checks
        if (['c_flag_equals', 'c_flag_is_true', 'c_flag_is_false', 'c_time_since_flag'].includes(r.predicate)) {
          return true;
        }
        // Group-based conditions (e.g. group in zone, group dead, etc.)
        if (r.group != null) return true;
        return false;
      });

      // Only warn if it depends on something external but nothing connects to it
      if (checksFlagOrGroup && !hasIncoming.has(idx) && !hasOutgoing.has(idx)) {
        issues.push({
          severity: 'WARNING',
          message: `Trigger "${comment}" has conditions that depend on flags or groups, but nothing sets those flags or activates those groups — condition may never become true.`
        });
      }
    }
  }

  categories.push({ label: 'Isolated triggers', issues });
}

  // ── 5. Circular dependencies ──────────────────────────────────────────────
  {
    const issues = [];
    const visited  = new Set();
    const inStack  = new Set();
    const cycles   = [];

    function dfs(node) {
      if (inStack.has(node)) { cycles.push(node); return; }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      for (const child of (edges.get(node) || [])) dfs(child);
      inStack.delete(node);
    }

    for (const node of (edges.keys() || [])) dfs(node);

    if (cycles.length > 0) {
      const names = cycles.map(idx => {
        const t = tr?.[String(idx)];
        return t?.comment ? `"${t.comment}"` : `#${idx}`;
      });
      issues.push({ severity: 'ERROR',
        message: `Circular dependency detected involving trigger(s): ${names.join(', ')}` });
    }
    categories.push({ label: 'Circular trigger dependencies', issues });
  }

  // ── 6. Late activation / group activate mismatch ──────────────────────────
  {
    const issues = [];

    // Groups activated by triggers
    const activatedByTrigger = new Set();
    if (tr) {
      for (const t of Object.values(tr)) {
        if (typeof t !== 'object') continue;
        for (const a of Object.values(t.actions || {})) {
          if (typeof a !== 'object') continue;
          if (a.predicate === 'a_activate_group' && a.group != null)
            activatedByTrigger.add(a.group);
        }
      }
    }

    for (const { group } of allGroups(mission)) {
      const gid  = group.groupId;
      const name = group.name || `group ${gid}`;
      const isLate = group.lateActivation === true;

      if (isLate && !activatedByTrigger.has(gid))
        issues.push({ severity: 'ERROR',
          message: `Group "${name}" is set to late activation but no trigger activates it — it will never spawn.` });

      if (!isLate && activatedByTrigger.has(gid))
        issues.push({ severity: 'WARNING',
          message: `Trigger activates group "${name}" but the group is not set to late activation — the activate trigger will have no effect.` });
    }
    categories.push({ label: 'Late activation / group activate mismatch', issues });
  }

  // ── 7. Tanker / AWACS orbit ───────────────────────────────────────────────
  {
    const issues = [];
    for (const { group } of allGroups(mission)) {
      const task = group.task;
      if (task !== 'Refueling' && task !== 'AWACS') continue;
      const name = group.name || `group ${group.groupId}`;

      // Check all waypoints for an Orbit task
      let hasOrbit = false;
      for (const point of Object.values(group?.route?.points || {})) {
        const taskIds = collectTaskIds(point.task);
        if (taskIds.has('Orbit')) { hasOrbit = true; break; }
      }
      if (!hasOrbit)
        issues.push({ severity: 'WARNING',
          message: `${task === 'AWACS' ? 'AWACS' : 'Tanker'} group "${name}" has no Orbit waypoint task.` });
    }
    categories.push({ label: 'Tanker / AWACS orbit', issues });
  }

  // ── 8. Tanker / AWACS immortal, invisible, unlimited fuel ─────────────────
  {
    const issues = [];
    for (const { group } of allGroups(mission)) {
      const task = group.task;
      if (task !== 'Refueling' && task !== 'AWACS') continue;
      const name = group.name || `group ${group.groupId}`;

      const taskIds = collectTaskIds(group);
      const hasImmortal     = taskIds.has('SetImmortal');
      const hasInvisible    = taskIds.has('SetInvisible');
      const hasUnlimitedFuel = taskIds.has('SetUnlimitedFuel');

      if (!hasImmortal && !hasInvisible)
        issues.push({ severity: 'WARNING',
          message: `${task === 'AWACS' ? 'AWACS' : 'Tanker'} group "${name}" is not set to immortal or invisible.` });
      if (!hasUnlimitedFuel)
        issues.push({ severity: 'WARNING',
          message: `${task === 'AWACS' ? 'AWACS' : 'Tanker'} group "${name}" does not have unlimited fuel.` });
    }
    categories.push({ label: 'Tanker / AWACS immortal, invisible, unlimited fuel', issues });
  }

  // ── 9. Ship coastline collision (populated externally by app.js) ──────────
  // This category is added by app.js after async coastline load.
  // We add a placeholder here so the order is consistent.
  categories.push({ label: 'Ship waypoint coastline collision', issues: [], _coastlinePlaceholder: true });

  return categories;
}