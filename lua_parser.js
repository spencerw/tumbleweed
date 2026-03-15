// lua_parser.js
// Parses DCS's serialized Lua table format into JS objects.

function parseLua(src) {
  src = src.replace(/^\s*\w+\s*=\s*/, '').trim();
  return parseValue(src, 0)[0];
}

function skipWS(s, i) {
  while (i < s.length) {
    if (' \t\n\r'.includes(s[i])) { i++; continue; }
    if (s[i] === '-' && s[i+1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

function parseValue(s, i) {
  i = skipWS(s, i);
  if (i >= s.length) return [null, i];

  if (s[i] === '{') return parseTable(s, i);

  if (s[i] === '"') {
    let j = i + 1, str = '';
    while (j < s.length) {
      if (s[j] === '\\') { str += s[j+1]; j += 2; continue; }
      if (s[j] === '"')  return [str, j + 1];
      str += s[j++];
    }
    return [str, j];
  }

  for (const [lit, val] of [['true', true], ['false', false], ['nil', null]]) {
    if (s.startsWith(lit, i) && !/\w/.test(s[i + lit.length] || ''))
      return [val, i + lit.length];
  }

  const nm = s.slice(i).match(/^-?[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?/);
  if (nm) {
    const r = nm[0];
    return [r.includes('.') || r.toLowerCase().includes('e') ? parseFloat(r) : parseInt(r), i + r.length];
  }

  const id = s.slice(i).match(/^[a-zA-Z_]\w*/);
  if (id) return [id[0], i + id[0].length];

  return [null, i + 1];
}

function parseTable(s, i) {
  i++;
  const obj = {};
  let arrIdx = 1;

  while (true) {
    i = skipWS(s, i);
    if (i >= s.length || s[i] === '}') { i++; break; }
    if (s[i] === ',') { i++; continue; }

    let key;
    if (s[i] === '[') {
      i++;
      [key, i] = parseValue(s, i);
      i = skipWS(s, i); if (s[i] === ']') i++;
      i = skipWS(s, i); if (s[i] === '=') i++;
    } else if (/[a-zA-Z_]/.test(s[i])) {
      const m = s.slice(i).match(/^([a-zA-Z_]\w*)\s*=/);
      if (m) { key = m[1]; i += m[0].length; }
      else   { [key, i] = parseValue(s, i); }
    } else {
      key = arrIdx++;
    }

    let val;
    [val, i] = parseValue(s, i);
    i = skipWS(s, i);
    if (s[i] === ',') i++;

    obj[key] = val;
  }

  return [obj, i];
}
