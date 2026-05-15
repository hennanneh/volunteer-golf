// Test harness for the bulk-merge authorization layer.
// Re-implements the helpers verbatim from server.js so we can exercise the
// merge function in isolation without spinning up the HTTP server.
//
// Run: node test-merge-enforcement.js

const VOLUNTEER_SECRET_FIELDS = ['adminPassword', 'volunteerPassword', 'adminPasswordSetAt', 'customPin'];
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function pruneTombstones(t, now) { return (t || []).filter(x => x && x.deletedAt > now - TOMBSTONE_TTL_MS); }

function diffVolunteerForLog(existV, incV) {
  const SKIP = new Set(['id', 'lastModified', ...VOLUNTEER_SECRET_FIELDS,
    'hasAdminPassword', 'hasVolunteerPassword', 'hasCustomPin', 'adminPasswordSetAt']);
  const changes = [];
  const allFields = new Set([...Object.keys(existV || {}), ...Object.keys(incV || {})]);
  for (const f of allFields) {
    if (SKIP.has(f)) continue;
    if (f === 'scheduled') {
      const oldS = (existV && existV.scheduled) || {};
      const newS = (incV   && incV.scheduled)   || {};
      const keys = new Set([...Object.keys(oldS), ...Object.keys(newS)]);
      const added = [], removed = [];
      for (const k of keys) {
        const was = !!oldS[k], now = !!newS[k];
        if (now && !was) added.push(k);
        if (!now && was) removed.push(k);
      }
      if (added.length || removed.length) changes.push({ field: 'scheduled', added, removed });
    } else {
      const a = existV ? existV[f] : undefined;
      const b = incV   ? incV[f]   : undefined;
      const same = a === b || JSON.stringify(a) === JSON.stringify(b);
      if (!same) changes.push({ field: f });
    }
  }
  return changes;
}

function captainAuthorized(userInfo, actorHole, existV, incV) {
  if (!userInfo || userInfo.userType !== 'Captain') return true;
  if (actorHole === null || actorHole === undefined || actorHole === '') return true;
  if (existV && userInfo.name && existV.name === userInfo.name) return true;
  if (incV   && userInfo.name && incV.name   === userInfo.name) return true;
  if (!existV) return !!(incV && String(incV.hole) === String(actorHole));
  return String(existV.hole) === String(actorHole)
      && !!incV && String(incV.hole) === String(actorHole);
}

function buildRejectedBulkEntry(targetVol, userInfo, actorHole, reason) {
  const e = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,8),
    timestamp: new Date().toISOString(),
    user: userInfo.name, userType: userInfo.userType,
    action: 'rejected-bulk-edit',
    target: (targetVol && targetVol.name) || '',
    details: reason + ' (auto-rejected via bulk save — no data changed)',
  };
  if (targetVol && (typeof targetVol.hole === 'number' || typeof targetVol.hole === 'string')) e.targetHole = targetVol.hole;
  if (actorHole !== undefined && actorHole !== null && actorHole !== '') e.actorHole = actorHole;
  return e;
}

function buildBulkActivityEntry(changes, targetVol, userInfo, isNew, actorHole) {
  if (!isNew && !changes.length) return null;
  let action, details;
  if (isNew) { action = 'add-volunteer'; details = 'Added volunteer (via bulk save)'; }
  else if (changes.length === 1 && changes[0].field === 'scheduled') {
    action = 'edit-schedule';
    const c = changes[0]; const parts = [];
    if (c.added.length)   parts.push('added '   + c.added.join(', '));
    if (c.removed.length) parts.push('removed ' + c.removed.join(', '));
    details = parts.join('; ') + ' (via bulk save)';
  } else {
    action = 'edit-volunteer';
    details = 'Updated fields: ' + changes.map(c => c.field).join(', ') + ' (via bulk save)';
  }
  const e = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,8),
    timestamp: new Date().toISOString(),
    user: userInfo.name, userType: userInfo.userType,
    action, target: (targetVol && targetVol.name) || '', details,
  };
  if (targetVol && (typeof targetVol.hole === 'number' || typeof targetVol.hole === 'string')) e.targetHole = targetVol.hole;
  if (actorHole !== undefined && actorHole !== null && actorHole !== '') e.actorHole = actorHole;
  return e;
}

function mergeVolunteerSave(existing, incoming, deletedIds, dataReadAt, userInfo) {
  const now = Date.now();
  const tombList = pruneTombstones(existing.deletedVolunteerIds, now);
  const tombMap = new Map(tombList.map(t => [String(t.id), t.deletedAt]));
  for (const r of (deletedIds || [])) tombMap.set(String(r), now);

  const existingById = new Map((existing.volunteers || []).map(v => [String(v.id), v]));
  const incomingById = new Map((incoming.volunteers || []).map(v => [String(v.id), v]));

  const merged = []; const handled = new Set(); const bulkActivityEntries = [];

  let actorHole = null;
  if (userInfo && userInfo.name) {
    const a = (existing.volunteers || []).find(v => v && v.name === userInfo.name);
    if (a && (typeof a.hole === 'number' || typeof a.hole === 'string')) actorHole = a.hole;
  }

  for (const [id, existV] of existingById) {
    if (tombMap.has(id)) continue;
    handled.add(id);
    const incV = incomingById.get(id);
    if (!incV) { merged.push(existV); continue; }
    const changes = diffVolunteerForLog(existV, incV);
    if (changes.length === 0) { merged.push(existV); continue; }
    const exMod = Number(existV.lastModified) || 0;
    if (exMod > dataReadAt) {
      merged.push(existV);
    } else if (!captainAuthorized(userInfo, actorHole, existV, incV)) {
      const reason = String(existV.hole) !== String(incV.hole)
        ? `Hole reassignment attempt ${existV.hole}→${incV.hole} (admin-only)`
        : `Captain hole ${actorHole} attempted to modify hole ${existV.hole} volunteer`;
      const r = buildRejectedBulkEntry(existV, userInfo, actorHole, reason);
      if (r) bulkActivityEntries.push(r);
      merged.push(existV);
    } else {
      if (userInfo) {
        const t = Object.assign({}, existV, incV);
        const e = buildBulkActivityEntry(changes, t, userInfo, false, actorHole);
        if (e) bulkActivityEntries.push(e);
      }
      merged.push(Object.assign({}, incV, { lastModified: now }));
    }
  }

  for (const [id, incV] of incomingById) {
    if (handled.has(id)) continue;
    if (tombMap.has(id)) {
      const tombAt = tombMap.get(id);
      if (tombAt > dataReadAt) continue;
      tombMap.delete(id);
    }
    if (!captainAuthorized(userInfo, actorHole, null, incV)) {
      const r = buildRejectedBulkEntry(incV, userInfo, actorHole,
        `Captain hole ${actorHole} attempted to add volunteer in hole ${incV.hole}`);
      if (r) bulkActivityEntries.push(r);
      continue;
    }
    if (userInfo) {
      const e = buildBulkActivityEntry([], incV, userInfo, true, actorHole);
      if (e) bulkActivityEntries.push(e);
    }
    merged.push(Object.assign({}, incV, { lastModified: now }));
  }

  return { merged, bulkActivityEntries };
}

// ---- Test scenarios ----
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); pass++; }
  else      { console.log('  ❌ ' + msg); fail++; }
}

const captain8 = { name: 'Wilson, Todd', userType: 'Captain' };
const admin    = { name: 'Howrey, Anne', userType: 'Admin' };

// Existing dataset: captain Wilson in hole 8, two vols (one hole 8, one hole 18)
const baseline = {
  volunteers: [
    { id: 'cap-wilson', name: 'Wilson, Todd', hole: 8, type: 'Captain', scheduled: {} },
    { id: 'vol-bob',    name: 'Bob (h8)',     hole: 8, type: 'Volunteer', scheduled: { 'Mon AM': true } },
    { id: 'vol-jane',   name: 'Jane (h18)',   hole: 18, type: 'Volunteer', scheduled: { 'Tue PM': true } },
  ],
  activityLog: [],
};

console.log('\n=== Test 1: Captain edits OWN-hole volunteer (should ACCEPT) ===');
{
  const incoming = { volunteers: [
    baseline.volunteers[0],
    { id: 'vol-bob', name: 'Bob (h8)', hole: 8, type: 'Volunteer', scheduled: { 'Mon AM': true, 'Mon PM': true } },
    baseline.volunteers[2],
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  const bob = r.merged.find(v => v.id === 'vol-bob');
  assert(bob.scheduled['Mon PM'] === true, 'Bob (hole 8) was updated');
  const entries = r.bulkActivityEntries.filter(e => e.target === 'Bob (h8)');
  assert(entries.length === 1 && entries[0].action === 'edit-schedule', 'One edit-schedule entry generated');
  assert(entries[0].actorHole === 8 && entries[0].targetHole === 8, 'Hole context correct (8 → 8)');
}

console.log('\n=== Test 2: Captain edits OTHER-hole volunteer (should REJECT) ===');
{
  const incoming = { volunteers: [
    baseline.volunteers[0],
    baseline.volunteers[1],
    { id: 'vol-jane', name: 'Jane (h18)', hole: 18, type: 'Volunteer', scheduled: { 'Tue PM': true, 'Wed AM': true } },
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  const jane = r.merged.find(v => v.id === 'vol-jane');
  assert(!jane.scheduled['Wed AM'], 'Jane (hole 18) was NOT updated by captain 8');
  assert(jane.scheduled['Tue PM'] === true, 'Jane original schedule preserved');
  const rejected = r.bulkActivityEntries.find(e => e.action === 'rejected-bulk-edit' && e.target === 'Jane (h18)');
  assert(!!rejected, 'rejected-bulk-edit entry was logged');
  assert(rejected.actorHole === 8 && rejected.targetHole === 18, 'Audit entry has correct hole context (8 → 18)');
  assert(rejected.details.includes('auto-rejected'), 'Details mention auto-rejection');
}

console.log('\n=== Test 3: Captain attempts HOLE REASSIGNMENT (should REJECT) ===');
{
  const incoming = { volunteers: [
    baseline.volunteers[0],
    { id: 'vol-bob', name: 'Bob (h8)', hole: 18, type: 'Volunteer', scheduled: { 'Mon AM': true } },
    baseline.volunteers[2],
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  const bob = r.merged.find(v => v.id === 'vol-bob');
  assert(bob.hole === 8, 'Bob remained in hole 8 (reassignment blocked)');
  const rejected = r.bulkActivityEntries.find(e => e.action === 'rejected-bulk-edit');
  assert(!!rejected && rejected.details.includes('reassignment'), 'rejection logged with "reassignment" reason');
}

console.log('\n=== Test 4: ADMIN edits any-hole volunteer (should ACCEPT) ===');
{
  const incoming = { volunteers: [
    baseline.volunteers[0],
    baseline.volunteers[1],
    { id: 'vol-jane', name: 'Jane (h18)', hole: 18, type: 'Volunteer', scheduled: { 'Tue PM': true, 'Wed AM': true } },
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), admin);
  const jane = r.merged.find(v => v.id === 'vol-jane');
  assert(jane.scheduled['Wed AM'] === true, 'Admin successfully updated hole-18 vol');
  const rejected = r.bulkActivityEntries.find(e => e.action === 'rejected-bulk-edit');
  assert(!rejected, 'No rejected-bulk-edit entries for admin');
}

console.log('\n=== Test 5: Captain edits OWN profile (should ACCEPT) ===');
{
  const incoming = { volunteers: [
    { id: 'cap-wilson', name: 'Wilson, Todd', hole: 8, type: 'Captain', scheduled: {}, phone: '555-1234' },
    baseline.volunteers[1], baseline.volunteers[2],
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  const me = r.merged.find(v => v.id === 'cap-wilson');
  assert(me.phone === '555-1234', 'Captain self-edit accepted');
}

console.log('\n=== Test 6: Captain ADDS volunteer in own hole (should ACCEPT) ===');
{
  const incoming = { volunteers: [
    ...baseline.volunteers,
    { id: 'new-vol-1', name: 'NewBob', hole: 8, type: 'Volunteer', scheduled: {} },
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  assert(!!r.merged.find(v => v.id === 'new-vol-1'), 'New hole-8 vol was added');
  const added = r.bulkActivityEntries.find(e => e.action === 'add-volunteer');
  assert(!!added, 'add-volunteer entry generated');
}

console.log('\n=== Test 7: Captain ADDS volunteer in OTHER hole (should REJECT) ===');
{
  const incoming = { volunteers: [
    ...baseline.volunteers,
    { id: 'new-vol-2', name: 'BadAdd', hole: 18, type: 'Volunteer', scheduled: {} },
  ]};
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  assert(!r.merged.find(v => v.id === 'new-vol-2'), 'Cross-hole add was rejected');
  const rejected = r.bulkActivityEntries.find(e => e.action === 'rejected-bulk-edit' && e.target === 'BadAdd');
  assert(!!rejected, 'Audit entry logged for cross-hole add attempt');
}

console.log('\n=== Test 8: STALE LASTMODIFIED still wins over enforcement (concurrent-edit protection) ===');
{
  // Bob got edited by someone else AFTER captain 8 loaded. Even though captain
  // is authorized (own hole), the stale check should still keep existing.
  const baselineWithFreshBob = {
    ...baseline,
    volunteers: baseline.volunteers.map(v =>
      v.id === 'vol-bob' ? { ...v, scheduled: { 'Mon AM': true, 'Fri PM': true }, lastModified: Date.now() } : v
    ),
  };
  const incoming = { volunteers: [
    baseline.volunteers[0],
    { id: 'vol-bob', name: 'Bob (h8)', hole: 8, type: 'Volunteer', scheduled: { 'Mon AM': true, 'Mon PM': true } },
    baseline.volunteers[2],
  ]};
  // dataReadAt = 0 (very old) → existing.lastModified > dataReadAt → stale rejected
  const r = mergeVolunteerSave(baselineWithFreshBob, incoming, [], 0, captain8);
  const bob = r.merged.find(v => v.id === 'vol-bob');
  assert(bob.scheduled['Fri PM'] === true, "Other captain's recent Fri PM edit preserved");
  assert(!bob.scheduled['Mon PM'], "Stale captain's Mon PM addition NOT applied");
}

console.log('\n=== Test 9: Captain echoes back UNCHANGED out-of-hole vols (should be SILENT) ===');
{
  // The SPA POSTs the full volunteer array on every save. Out-of-hole records
  // are byte-identical to existing — must not produce rejected-bulk-edit spam.
  const incoming = { volunteers: [...baseline.volunteers] };  // identical copy
  const r = mergeVolunteerSave(baseline, incoming, [], Date.now(), captain8);
  assert(r.bulkActivityEntries.length === 0, 'No activity entries for byte-identical save');
  const jane = r.merged.find(v => v.id === 'vol-jane');
  assert(jane.lastModified === undefined, "Untouched Jane's lastModified NOT bumped");
  const bob = r.merged.find(v => v.id === 'vol-bob');
  assert(bob.lastModified === undefined, "Untouched Bob's lastModified NOT bumped");
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
