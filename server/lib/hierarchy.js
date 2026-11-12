// Group › District › Zone › Sub Zone display labels for server-side outputs
// (CSV). Mirror of client/src/lib/hierarchy.js (keep both in step).
//
// Group:    "Group 2 (Baarsiigo)" — code, then the name in brackets when the
//           group has a distinct name (the format the owner uses on the
//           Today's-list header and the degmo spec).
// District: the district name; a name stored code-style ("FARAH-OMAR") is
//           shown as words ("Farah Omar").
// Zone / Sub Zone: name, else code.

function groupLabel(code, name) {
  const c = (code || '').trim();
  const n = (name || '').trim();
  if (c && n && n.toLowerCase() !== c.toLowerCase()) return `${c} (${n})`;
  return c || n || '';
}

function districtLabel(name) {
  const s = (name || '').trim();
  if (!s) return '';
  // Code-style (all caps, words joined by - or _): FARAH-OMAR -> Farah Omar.
  if (/[A-Z]/.test(s) && s === s.toUpperCase() && /^[A-Z0-9]+(?:[-_ ][A-Z0-9]+)*$/.test(s)) {
    return s.split(/[-_ ]+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }
  return s;
}

function nameOrCode(name, code) {
  return (name || '').trim() || (code || '').trim() || '';
}

// Row with group_code/group_name/zone_name/group_zone_name/group_zone_code/route_name/route_code.
function hierarchyParts(row) {
  return {
    group: groupLabel(row.group_code, row.group_name),
    district: districtLabel(row.zone_name),
    zone: nameOrCode(row.group_zone_name, row.group_zone_code),
    subZone: nameOrCode(row.route_name, row.route_code),
  };
}

function hierarchyLabel(row) {
  const p = hierarchyParts(row);
  return [p.group, p.district, p.zone, p.subZone].filter(Boolean).join(' › ');
}

module.exports = { groupLabel, districtLabel, hierarchyParts, hierarchyLabel };
