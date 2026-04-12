// geo.js
// Coordinate conversion and geometry utilities for DCS mission QC.

// ── Map reference points ───────────────────────────────────────────────────────
// Each map uses equirectangular projection centered on a reference lat/lon.
// Reference points back-calculated from known landmark positions.

const MAP_REFS = {
  PersianGulf:    { lat: 26.275, lon: 56.311 },
  Caucasus:       { lat: 42.355, lon: 41.754 },
  MarianaIslands: { lat: 15.000, lon: 145.673 },
  Kola:           { lat: 69.165, lon: 33.549 },
};

// Maps that have coastline data files available
const COASTLINE_FILES = {
  PersianGulf:    'data/pg_coastline.json',
  Caucasus:       'data/caucasus_coastline.json',
  MarianaIslands: 'data/marianas_coastline.json',
  Kola:           'data/kola_coastline.json',
};

function dcsToLatLon(x, y, theatre) {
  const ref = MAP_REFS[theatre];
  if (!ref) return null;

  // 1. Calculate Latitude first (this is linear)
  const lat = ref.lat + x / 111320.0;

  // 2. Use the NEWLY CALCULATED lat for the longitude scaling
  // This handles the "pinching" of the globe as the ship moves north
  const radLat = lat * Math.PI / 180;
  const lon = ref.lon + y / (111320.0 * Math.cos(radLat));

  return { lat, lon };
}

// ── Segment intersection ───────────────────────────────────────────────────────
// Returns true if line segment (p1→p2) intersects (p3→p4).
// Points are { lat, lon }.

function segmentsIntersect(p1, p2, p3, p4) {
  const x1 = p1.lon, y1 = p1.lat;
  const x2 = p2.lon, y2 = p2.lat;
  const x3 = p3.lon, y3 = p3.lat;
  const x4 = p4.lon, y4 = p4.lat;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return false; // parallel

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  return t > 0 && t < 1 && u > 0 && u < 1;
}

// ── Coastline loader and checker ──────────────────────────────────────────────

async function loadCoastline(theatre) {
  const file = COASTLINE_FILES[theatre];
  if (!file) return null;
  try {
    const res = await fetch(file);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Extract all coastline segments from a GeoJSON FeatureCollection of LineStrings
function coastlineSegments(geojson) {
  const segments = [];
  for (const feature of geojson.features || []) {
    const coords = feature.geometry?.coordinates || [];
    for (let i = 0; i < coords.length - 1; i++) {
      segments.push({
        p1: { lon: coords[i][0],     lat: coords[i][1]     },
        p2: { lon: coords[i + 1][0], lat: coords[i + 1][1] },
      });
    }
  }
  return segments;
}

// Check all ship group waypoint segments against coastline
// Returns array of { groupName, wp1idx, wp2idx, lat1, lon1, lat2, lon2 }
function checkShipRoutes(mission, theatre, coastline) {
  const segments = coastlineSegments(coastline);
  const collisions = [];

  const coalitions = mission?.coalition || {};
  for (const [side, coalition] of Object.entries(coalitions)) {
    for (const country of Object.values(coalition?.country || {})) {
      for (const group of Object.values(country?.ship?.group || {})) {
        const groupName = group.name || `group ${group.groupId}`;
        const points = Object.values(group?.route?.points || {});
        console.log(groupName);

        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i];
          const b = points[i + 1];

          if (!a?.x || !b?.x) continue;

          const latLonA = dcsToLatLon(a.x, a.y, theatre);
          const latLonB = dcsToLatLon(b.x, b.y, theatre);

          if (!latLonA || !latLonB) continue;

          // Check against every coastline segment
          for (const seg of segments) {
            if (segmentsIntersect(latLonA, latLonB, seg.p1, seg.p2)) {
              collisions.push({
                groupName,
                wpA: i + 1,
                wpB: i + 2,
                latA: latLonA.lat.toFixed(4),
                lonA: latLonA.lon.toFixed(4),
                latB: latLonB.lat.toFixed(4),
                lonB: latLonB.lon.toFixed(4),
              });
              break; // one collision per segment pair is enough
            }
          }
        }
      }
    }
  }

  return collisions;
}