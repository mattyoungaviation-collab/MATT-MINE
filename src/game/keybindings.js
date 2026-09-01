export const KEYBIND_ACTIONS = Object.freeze([
  { id: 'moveUp', label: 'Move up', default: 'KeyW' },
  { id: 'moveDown', label: 'Move down', default: 'KeyS' },
  { id: 'moveLeft', label: 'Move left', default: 'KeyA' },
  { id: 'moveRight', label: 'Move right', default: 'KeyD' },
  { id: 'attack', label: 'Attack', default: 'Space' },
  { id: 'dash', label: 'Dash', default: 'ShiftLeft' },
  { id: 'pickaxe', label: 'Pickaxe', default: 'Digit1' },
  { id: 'dynamite', label: 'Dynamite', default: 'Digit2' },
  { id: 'blaster', label: 'Blaster', default: 'Digit3' },
  { id: 'medicPack', label: 'Medic Pack', default: 'Digit4' },
  { id: 'forceField', label: "MATT's Mythical Force Field", default: 'Digit5' }
]);

export function defaultKeybindings() {
  return Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action.id, action.default]));
}

export function normalizeKeybindings(input = {}) {
  const result = defaultKeybindings();
  const used = new Set();
  for (const action of KEYBIND_ACTIONS) {
    const code = typeof input[action.id] === 'string' ? input[action.id].trim() : result[action.id];
    if (!/^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Enter|Tab|Escape|Backspace)$/.test(code)) {
      throw new Error(`Unsupported key for ${action.label}.`);
    }
    if (used.has(code)) throw new Error(`${code} is assigned more than once.`);
    used.add(code);
    result[action.id] = code;
  }
  return result;
}
