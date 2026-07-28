import {
  COMPETITION_DEPTH_COUNT,
  COMPETITION_SLOTS,
  createStarterMap,
  normalizeCompetitionDraft,
  validateCompetitionDraft,
  validateCompetitionMap
} from './game/competitionStudio.js';
import {
  drawCompetitionMap,
  mapBounds
} from './game/mineMapRenderer.js';

const studio = {
  payload: null,
  slotId: 'practice',
  depth: 1,
  draft: null,
  selected: null,
  tool: 'select',
  connectFrom: '',
  dragging: null,
  loaded: false
};

const $ = (selector) => document.querySelector(selector);

window.mattMineCompetitionStudio = {
  load: loadStudio
};

async function loadStudio(force = false) {
  if (studio.loaded && !force) {
    renderAll();
    return;
  }
  setSaveState('LOADING', 'working');
  const payload = await adminApi('/api/admin/competition-studio');
  studio.payload = payload;
  studio.loaded = true;
  selectSlot(studio.slotId);
  bindOnce();
  setSaveState('DRAFT READY', 'ready');
}

function bindOnce() {
  if ($('#studio-map-canvas').dataset.bound) return;
  $('#studio-map-canvas').dataset.bound = 'true';
  $('#studio-slot-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-studio-slot]');
    if (button) selectSlot(button.dataset.studioSlot);
  });
  $('#studio-depth-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-studio-depth]');
    if (button) selectDepth(Number(button.dataset.studioDepth));
  });
  $('#studio-copy-depth').addEventListener('click', copyPreviousDepth);
  $('#studio-reset-depth').addEventListener('click', resetCurrentDepth);
  document.querySelector('.studio-tool-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-studio-tool]');
    if (!button) return;
    if (button.dataset.studioTool === 'delete') {
      deleteSelection();
      return;
    }
    studio.tool = button.dataset.studioTool;
    studio.connectFrom = '';
    renderTools();
  });
  $('#studio-place-object').addEventListener('click', () => {
    studio.tool = 'object';
    renderTools();
    setSaveState('CLICK A ROOM', 'working');
  });
  const canvas = $('#studio-map-canvas');
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  $('#studio-inspector-fields').addEventListener('input', updateInspector);
  $('#studio-competition-fields').addEventListener('input', updateCompetition);
  $('#studio-save').addEventListener('click', () => void runAction(saveDraft));
  $('#studio-publish').addEventListener('click', () => void runAction(publishSnapshot));
  $('#studio-test').addEventListener('click', () => void runAction(testDraft));
  if (!$('#studio-effective-at').value) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    $('#studio-effective-at').value = localDateTimeValue(tomorrow);
  }
}

function selectSlot(slotId) {
  const definition = COMPETITION_SLOTS.find((slot) => slot.id === slotId && !slot.comingSoon);
  if (!definition || !studio.payload?.studio?.slots?.[slotId]) return;
  studio.slotId = slotId;
  studio.draft = structuredClone(studio.payload.studio.slots[slotId].draft);
  studio.depth = 1;
  syncActiveMap();
  studio.selected = null;
  studio.tool = 'select';
  studio.connectFrom = '';
  renderAll();
}

function renderAll() {
  renderSlotTabs();
  renderDepthTabs();
  renderTools();
  renderCanvas();
  renderInspector();
  renderCompetition();
  renderVersions();
  renderValidation();
}

function selectDepth(depth) {
  studio.depth = Math.max(1, Math.min(COMPETITION_DEPTH_COUNT, Math.floor(depth || 1)));
  studio.selected = null;
  studio.tool = 'select';
  studio.connectFrom = '';
  syncActiveMap();
  renderAll();
}

function renderDepthTabs() {
  if (!studio.draft) return;
  $('#studio-depth-tabs').innerHTML = studio.draft.depths.map((entry) => {
    const validation = validateCompetitionMap(entry.map);
    return `<button type="button" data-studio-depth="${entry.depth}" class="${entry.depth === studio.depth ? 'active' : ''}">
      <span>DEPTH</span><b>${entry.depth}</b><small>${validation.valid ? `${validation.counts.rooms} ROOMS` : `${validation.errors.length} BLOCKERS`}</small>
    </button>`;
  }).join('');
  $('#studio-copy-depth').disabled = studio.depth === 1;
}

function renderSlotTabs() {
  $('#studio-slot-tabs').innerHTML = COMPETITION_SLOTS.map((slot) => `
    <button type="button" data-studio-slot="${slot.id}" class="${slot.id === studio.slotId ? 'active' : ''}" ${slot.comingSoon ? 'disabled' : ''}>
      <span>0${slot.number}</span><b>${escapeHtml(slot.name)}</b><small>${slot.comingSoon ? 'COMING SOON' : slot.id === studio.slotId ? 'EDITING' : 'OPEN'}</small>
    </button>`).join('');
}

function renderTools() {
  document.querySelectorAll('[data-studio-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.studioTool === studio.tool);
  });
  $('#studio-place-object').classList.toggle('active', studio.tool === 'object');
}

function renderCanvas() {
  if (!studio.draft) return;
  const map = activeMap();
  const canvas = $('#studio-map-canvas');
  drawCompetitionMap(canvas, map);
  const context = canvas.getContext('2d');
  const transform = canvasTransform(canvas, map);
  if (studio.selected?.kind === 'room') {
    const room = map.rooms.find((entry) => entry.id === studio.selected.id);
    if (room) {
      const center = transform.point(room.x, room.y);
      context.strokeStyle = '#fff';
      context.lineWidth = 4;
      context.setLineDash([9, 6]);
      context.strokeRect(
        center.x - room.width * transform.scale / 2 - 6,
        center.y - room.height * transform.scale / 2 - 6,
        room.width * transform.scale + 12,
        room.height * transform.scale + 12
      );
      context.setLineDash([]);
    }
  }
  $('#studio-map-name').textContent = map.name;
  const validation = validateCompetitionMap(map);
  $('#studio-map-counts').textContent = `${validation.counts.rooms} rooms · ${validation.counts.objects} objects · ${validation.counts.enemies} threats`;
}

function pointerDown(event) {
  const logical = eventPoint(event);
  const hit = hitTest(logical);
  if (studio.tool === 'room') {
    addRoom(logical);
    return;
  }
  if (studio.tool === 'object') {
    const room = hit?.kind === 'room' ? roomById(hit.id) : roomAtPoint(logical);
    if (room) addObject(room, logical);
    return;
  }
  if (studio.tool === 'connect') {
    if (hit?.kind === 'room') connectRoom(hit.id);
    return;
  }
  studio.selected = hit;
  if (hit) {
    studio.dragging = { ...hit, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  renderAll();
}

function pointerMove(event) {
  if (!studio.dragging || studio.dragging.pointerId !== event.pointerId) return;
  const logical = eventPoint(event);
  if (studio.dragging.kind === 'room') {
    const room = roomById(studio.dragging.id);
    room.x = snap(logical.x, .25, 0, 11);
    room.y = snap(logical.y, .25, 0, 7);
  } else {
    const object = objectById(studio.dragging.id);
    const room = roomAtPoint(logical) || roomById(object.roomId);
    object.roomId = room.id;
    object.x = clamp((logical.x - room.x) / room.width, -.46, .46);
    object.y = clamp((logical.y - room.y) / room.height, -.46, .46);
  }
  renderCanvas();
  renderValidation();
}

function pointerUp(event) {
  if (studio.dragging?.pointerId === event.pointerId) {
    studio.dragging = null;
    markDirty();
    renderAll();
  }
}

function addRoom(point) {
  const id = uniqueId('room');
  activeMap().rooms.push({
    id,
    x: snap(point.x, .5, 0, 11),
    y: snap(point.y, .5, 0, 7),
    width: 2,
    height: 2,
    type: 'mixed',
    name: 'New Chamber'
  });
  studio.selected = { kind: 'room', id };
  studio.tool = 'select';
  markDirty();
  renderAll();
}

function addObject(room, point) {
  const type = $('#studio-object-type').value;
  const id = uniqueId(type);
  if (['player', 'extraction'].includes(type)) {
    activeMap().objects = activeMap().objects.filter((object) => object.type !== type);
  }
  activeMap().objects.push({
    id,
    type,
    roomId: room.id,
    x: clamp((point.x - room.x) / room.width, -.46, .46),
    y: clamp((point.y - room.y) / room.height, -.46, .46),
    quantity: 1
  });
  studio.selected = { kind: 'object', id };
  studio.tool = 'select';
  markDirty();
  renderAll();
}

function connectRoom(roomId) {
  if (!studio.connectFrom) {
    studio.connectFrom = roomId;
    studio.selected = { kind: 'room', id: roomId };
    setSaveState('SELECT SECOND ROOM', 'working');
    renderCanvas();
    return;
  }
  if (studio.connectFrom !== roomId) {
    const exists = activeMap().corridors.some((corridor) =>
      [corridor.from, corridor.to].includes(studio.connectFrom) &&
      [corridor.from, corridor.to].includes(roomId)
    );
    if (!exists) {
      activeMap().corridors.push({
        id: uniqueId('path'),
        from: studio.connectFrom,
        to: roomId,
        width: .75
      });
    }
  }
  studio.connectFrom = '';
  studio.tool = 'select';
  markDirty();
  renderAll();
}

function deleteSelection() {
  if (!studio.selected) return;
  if (studio.selected.kind === 'room') {
    const id = studio.selected.id;
    activeMap().rooms = activeMap().rooms.filter((room) => room.id !== id);
    activeMap().corridors = activeMap().corridors.filter((corridor) => corridor.from !== id && corridor.to !== id);
    activeMap().objects = activeMap().objects.filter((object) => object.roomId !== id);
  } else {
    activeMap().objects = activeMap().objects.filter((object) => object.id !== studio.selected.id);
  }
  studio.selected = null;
  studio.tool = 'select';
  markDirty();
  renderAll();
}

function renderInspector() {
  const title = $('#studio-inspector-title');
  const fields = $('#studio-inspector-fields');
  if (studio.selected?.kind === 'room') {
    const room = roomById(studio.selected.id);
    title.textContent = room.name;
    fields.innerHTML = `
      ${field('Room name', 'name', room.name, 'text')}
      <label>Room type<select data-inspector="type">${['start','mining','combat','mixed','treasure','guardian'].map((type) => `<option value="${type}" ${room.type === type ? 'selected' : ''}>${titleCase(type)}</option>`).join('')}</select></label>
      ${field('Width', 'width', room.width, 'number', '1', '3.5', '.25')}
      ${field('Height', 'height', room.height, 'number', '1', '3', '.25')}
      ${field('Grid X', 'x', room.x, 'number', '0', '11', '.25')}
      ${field('Grid Y', 'y', room.y, 'number', '0', '7', '.25')}`;
    return;
  }
  if (studio.selected?.kind === 'object') {
    const object = objectById(studio.selected.id);
    title.textContent = titleCase(object.type);
    fields.innerHTML = `
      <label>Object type<select data-inspector="type">${allObjectTypes().map((type) => `<option value="${type}" ${object.type === type ? 'selected' : ''}>${titleCase(type)}</option>`).join('')}</select></label>
      <label>Room<select data-inspector="roomId">${activeMap().rooms.map((room) => `<option value="${room.id}" ${object.roomId === room.id ? 'selected' : ''}>${escapeHtml(room.name)}</option>`).join('')}</select></label>
      ${field('Quantity', 'quantity', object.quantity, 'number', '1', '50', '1')}
      ${field('Horizontal position', 'x', object.x, 'number', '-.46', '.46', '.01')}
      ${field('Vertical position', 'y', object.y, 'number', '-.46', '.46', '.01')}`;
    return;
  }
  title.textContent = 'Mine settings';
  fields.innerHTML = `
    ${field('Map name', 'map.name', activeMap().name, 'text')}
    <label>Cave theme<select data-inspector="map.background">${['deep','crystal','magma','ruins'].map((theme) => `<option value="${theme}" ${activeMap().background === theme ? 'selected' : ''}>${titleCase(theme)}</option>`).join('')}</select></label>
    <div class="studio-tip"><b>DEPTH ${studio.depth} MAP</b><span>This depth is independent. Publishing locks all five depth maps into one immutable competition version.</span></div>`;
}

function updateInspector(event) {
  const input = event.target.closest('[data-inspector]');
  if (!input) return;
  const key = input.dataset.inspector;
  const value = input.type === 'number' ? Number(input.value) : input.value;
  if (key.startsWith('map.')) activeMap()[key.slice(4)] = value;
  else if (studio.selected?.kind === 'room') roomById(studio.selected.id)[key] = value;
  else if (studio.selected?.kind === 'object') objectById(studio.selected.id)[key] = value;
  markDirty();
  renderCanvas();
  renderValidation();
}

function renderCompetition() {
  const draft = studio.draft;
  $('#studio-competition-fields').innerHTML = `
    ${field('Competition name', 'competition.name', draft.name, 'text')}
    ${field('Card description', 'competition.subtitle', draft.subtitle, 'text')}
    ${field('Locked character', 'loadout.characterId', draft.loadout.characterId, 'text')}
    <label class="tuning-field">Starting weapon<select data-competition="loadout.startingWeapon">${['pickaxe','dynamite','blaster'].map((weapon) => `<option value="${weapon}" ${draft.loadout.startingWeapon === weapon ? 'selected' : ''}>${titleCase(weapon)}</option>`).join('')}</select></label>
    ${['pickaxe','dynamite','blaster'].map((weapon) => `<label class="tuning-field studio-check">${titleCase(weapon)} available<input data-competition="loadout.availableWeapons" data-weapon="${weapon}" type="checkbox" ${(draft.loadout.availableWeapons || []).includes(weapon) ? 'checked' : ''} ${weapon === 'pickaxe' ? 'disabled' : ''}></label>`).join('')}
    ${field('Starting health', 'loadout.startingHealth', draft.loadout.startingHealth, 'number', '1', '1000', '1', true)}
    ${field('Starting dynamite', 'loadout.startingDynamite', draft.loadout.startingDynamite, 'number', '0', '99', '1', true)}
    ${field('Blaster energy', 'loadout.blasterEnergy', draft.loadout.blasterEnergy, 'number', '1', '1000', '1', true)}
    ${field('Maximum drones', 'loadout.maximumDrones', draft.loadout.maximumDrones, 'number', '0', '4', '1', true)}
    ${field('Attempt limit (0 = unlimited)', 'rules.attemptLimit', draft.rules.attemptLimit, 'number', '0', '1000', '1', true)}
    ${field('Safe start seconds', 'rules.safeStartSeconds', draft.rules.safeStartSeconds, 'number', '0', '30', '.5', true)}
    ${field('Leaderboard title', 'rules.leaderboardTitle', draft.rules.leaderboardTitle, 'text')}
    ${field('Reward label', 'rules.rewardLabel', draft.rules.rewardLabel, 'text')}
    ${field('Player instructions', 'rules.instructions', draft.rules.instructions, 'text')}
    ${check('Permanent upgrades enabled', 'loadout.permanentUpgrades', draft.loadout.permanentUpgrades)}
    ${check('Run upgrades enabled', 'loadout.runUpgrades', draft.loadout.runUpgrades)}
    ${check('Paid revive enabled', 'loadout.paidRevive', draft.loadout.paidRevive)}`;
}

function updateCompetition(event) {
  const input = event.target.closest('[data-competition]');
  if (!input) return;
  if (input.dataset.weapon) {
    const weapons = new Set(studio.draft.loadout.availableWeapons || ['pickaxe']);
    if (input.checked) weapons.add(input.dataset.weapon);
    else weapons.delete(input.dataset.weapon);
    weapons.add('pickaxe');
    studio.draft.loadout.availableWeapons = [...weapons];
    if (!weapons.has(studio.draft.loadout.startingWeapon)) studio.draft.loadout.startingWeapon = 'pickaxe';
    markDirty();
    renderCompetition();
    return;
  }
  const path = input.dataset.competition.split('.');
  let target = studio.draft;
  while (path.length > 1) target = target[path.shift()];
  target[path[0]] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  markDirty();
}

function renderValidation() {
  const validation = validateCompetitionDraft(studio.draft);
  const current = validation.depths.find((entry) => entry.depth === studio.depth);
  $('#studio-validation').innerHTML = `
    <div class="${current.valid ? 'valid' : 'invalid'}"><b>${current.valid ? `DEPTH ${studio.depth} READY` : `DEPTH ${studio.depth}: ${current.errors.length} BLOCKER${current.errors.length === 1 ? '' : 'S'}`}</b><span>${current.valid ? 'Required routes and objectives are playable.' : escapeHtml(current.errors[0])}</span></div>
    <small>${validation.valid ? 'ALL 5 DEPTHS READY TO PUBLISH' : `${validation.errors.length} TOTAL BLOCKERS ACROSS ALL DEPTHS`}</small>
    ${validation.warnings.map((warning) => `<small>⚠ ${escapeHtml(warning)}</small>`).join('')}`;
  $('#studio-publish').disabled = !validation.valid;
}

function renderVersions() {
  const ids = studio.payload.studio.slots[studio.slotId].scheduledSnapshotIds || [];
  $('#studio-version-list').innerHTML = ids.length
    ? [...ids].reverse().map((id) => {
        const snapshot = studio.payload.studio.snapshots[id];
        return `<article><span><b>${escapeHtml(snapshot.name)}</b><small>${new Date(snapshot.effectiveAt).toLocaleString()}${snapshot.expiresAt ? ` → ${new Date(snapshot.expiresAt).toLocaleString()}` : ''}</small></span><code>${snapshot.fingerprint.slice(0, 16)}</code><em>${snapshot.status}</em></article>`;
      }).join('')
    : '<p class="muted">No published versions yet. The safe default map remains active.</p>';
}

async function saveDraft() {
  const reason = requiredReason();
  setSaveState('SAVING', 'working');
  const result = await adminApi(`/api/admin/competition-studio/${studio.slotId}/draft`, {
    method: 'PUT',
    body: { draft: normalizeCompetitionDraft(studio.draft, studio.slotId), reason }
  });
  studio.draft = structuredClone(result.draft);
  syncActiveMap();
  studio.payload.studio.slots[studio.slotId].draft = structuredClone(result.draft);
  setSaveState('DRAFT SAVED', 'ready');
  renderAll();
}

async function publishSnapshot() {
  const reason = requiredReason();
  const validation = validateCompetitionDraft(studio.draft);
  if (!validation.valid) throw new Error(validation.errors[0]);
  await saveDraft();
  const effectiveAt = dateValue($('#studio-effective-at').value, Date.now());
  const expiresAt = $('#studio-expires-at').value ? dateValue($('#studio-expires-at').value, 0) : 0;
  if (expiresAt && expiresAt <= effectiveAt) throw new Error('The competition end must be after its start.');
  if (!confirm(`Publish all five immutable ${studio.slotId} depth maps?\n\nEvery player and server replay will use this exact version.`)) return;
  setSaveState('PUBLISHING', 'working');
  const result = await adminApi(`/api/admin/competition-studio/${studio.slotId}/publish`, {
    method: 'POST',
    body: { effectiveAt, expiresAt, reason }
  });
  studio.payload.studio.snapshots[result.snapshot.id] = result.snapshot;
  studio.payload.studio.slots[studio.slotId].scheduledSnapshotIds.push(result.snapshot.id);
  studio.payload.studio.slots[studio.slotId].activeSnapshotId = effectiveAt <= Date.now() ? result.snapshot.id : studio.payload.studio.slots[studio.slotId].activeSnapshotId;
  $('#studio-reason').value = '';
  setSaveState('VERSION PUBLISHED', 'ready');
  renderVersions();
}

function testDraft() {
  const validation = validateCompetitionDraft(studio.draft);
  if (!validation.valid) throw new Error(validation.errors[0]);
  localStorage.setItem('matt-mine-studio-test-v1', JSON.stringify({
    ...normalizeCompetitionDraft(studio.draft, studio.slotId),
    id: `admin-test-${Date.now()}`,
    fingerprint: 'ADMIN-TEST',
    status: 'test'
  }));
  window.open('/?studioTest=1', '_blank', 'noopener');
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setSaveState(error?.message || 'ACTION FAILED', 'error');
  }
}

function hitTest(point) {
  for (const object of [...activeMap().objects].reverse()) {
    const room = roomById(object.roomId);
    const x = room.x + object.x * room.width;
    const y = room.y + object.y * room.height;
    if (Math.hypot(point.x - x, point.y - y) < .18) return { kind: 'object', id: object.id };
  }
  const room = roomAtPoint(point);
  return room ? { kind: 'room', id: room.id } : null;
}

function roomAtPoint(point) {
  return [...activeMap().rooms].reverse().find((room) =>
    point.x >= room.x - room.width / 2 &&
    point.x <= room.x + room.width / 2 &&
    point.y >= room.y - room.height / 2 &&
    point.y <= room.y + room.height / 2
  ) || null;
}

function eventPoint(event) {
  const canvas = $('#studio-map-canvas');
  const rect = canvas.getBoundingClientRect();
  const transform = canvasTransform(canvas, activeMap());
  return transform.inverse(
    (event.clientX - rect.left) * canvas.width / rect.width,
    (event.clientY - rect.top) * canvas.height / rect.height
  );
}

function canvasTransform(canvas, map) {
  const bounds = mapBounds(map);
  const scale = Math.min(
    (canvas.width - 80) / Math.max(1, bounds.maxX - bounds.minX),
    (canvas.height - 80) / Math.max(1, bounds.maxY - bounds.minY)
  );
  const offsetX = (canvas.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale;
  const offsetY = (canvas.height - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale;
  return {
    scale,
    point: (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale }),
    inverse: (x, y) => ({ x: (x - offsetX) / scale, y: (y - offsetY) / scale })
  };
}

function roomById(id) {
  return activeMap().rooms.find((room) => room.id === id);
}

function objectById(id) {
  return activeMap().objects.find((object) => object.id === id);
}

function uniqueId(prefix) {
  const used = new Set([
    ...activeMap().rooms.map((room) => room.id),
    ...activeMap().corridors.map((corridor) => corridor.id),
    ...activeMap().objects.map((object) => object.id)
  ]);
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function allObjectTypes() {
  return ['player','extraction','guardian','slime','bat','crawler','beetle','exploder','spitter','stone','copper','gold','crystal','treasure','weapon_blaster','weapon_dynamite','health','upgrade','rockfall','crystal_field'];
}

function activeMap() {
  return studio.draft.depths.find((entry) => entry.depth === studio.depth)?.map || studio.draft.map;
}

function syncActiveMap() {
  const map = activeMap();
  if (map) studio.draft.map = map;
}

function copyPreviousDepth() {
  if (studio.depth <= 1) return;
  const previous = studio.draft.depths.find((entry) => entry.depth === studio.depth - 1)?.map;
  const current = studio.draft.depths.find((entry) => entry.depth === studio.depth);
  if (!previous || !current) return;
  current.map = structuredClone(previous);
  current.map.name = `${previous.name.replace(/\s*·\s*Depth\s+\d+$/i, '')} · Depth ${studio.depth}`;
  syncActiveMap();
  studio.selected = null;
  markDirty();
  renderAll();
}

function resetCurrentDepth() {
  if (!confirm(`Reset Depth ${studio.depth} to its starter layout?`)) return;
  const current = studio.draft.depths.find((entry) => entry.depth === studio.depth);
  if (!current) return;
  current.map = createStarterMap(studio.slotId, studio.depth);
  syncActiveMap();
  studio.selected = null;
  markDirty();
  renderAll();
}

function field(label, key, value, type, min = '', max = '', step = '', competition = false) {
  const attribute = competition ? 'data-competition' : 'data-inspector';
  return `<label class="tuning-field">${escapeHtml(label)}<input ${attribute}="${key}" type="${type}" value="${escapeHtml(value)}" ${min !== '' ? `min="${min}"` : ''} ${max !== '' ? `max="${max}"` : ''} ${step !== '' ? `step="${step}"` : ''}></label>`;
}

function check(label, key, checked) {
  return `<label class="tuning-field studio-check">${escapeHtml(label)}<input data-competition="${key}" type="checkbox" ${checked ? 'checked' : ''}></label>`;
}

function markDirty() {
  setSaveState('UNSAVED CHANGES', 'dirty');
}

function setSaveState(text, stateName) {
  const node = $('#studio-save-state');
  node.textContent = text;
  node.dataset.state = stateName;
}

function requiredReason() {
  const reason = $('#studio-reason').value.trim();
  if (reason.length < 5) throw new Error('Enter a short reason for this change.');
  return reason;
}

function dateValue(value, fallback) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function localDateTimeValue(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function adminApi(path, options = {}) {
  const key = sessionStorage.getItem('mattMineAdminKey') || $('#admin-key')?.value || '';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      'x-matt-admin-key': key,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Request failed (${response.status}).`);
  return payload;
}

function snap(value, step, min, max) {
  return clamp(Math.round(value / step) * step, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function titleCase(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

window.addEventListener('error', (event) => {
  if ($('#tab-studio')?.classList.contains('active') && event.error) {
    setSaveState(event.error.message || 'STUDIO ERROR', 'dirty');
  }
});
