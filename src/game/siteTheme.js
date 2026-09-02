export const SITE_THEME_SCHEMA_VERSION = 1;
export const SITE_THEME_DRAFT_STORAGE_KEY = 'matt-mine-theme-studio-draft-v1';

export const SITE_THEME_GROUPS = Object.freeze([
  { id: 'brand', label: 'Brand & color', description: 'Core palette, status colors, borders, and focus.' },
  { id: 'typography', label: 'Typography', description: 'Font families, scale, spacing, case, and readability.' },
  { id: 'layout', label: 'Layout & spacing', description: 'Page width, navigation, gutters, cards, and control sizing.' },
  { id: 'shape', label: 'Shape & borders', description: 'Corners, outlines, pills, clipping, and button geometry.' },
  { id: 'effects', label: 'Lighting & effects', description: 'Glow, shadows, glass, imagery, grid, noise, and vignette.' },
  { id: 'motion', label: 'Motion', description: 'Transition timing, hover response, pulse, and parallax.' },
  { id: 'components', label: 'Component styles', description: 'Buttons, navigation, cards, density, and hero alignment.' },
  { id: 'accessibility', label: 'Accessibility', description: 'Contrast, targets, focus, grayscale, and link treatment.' }
]);

const FONT_OPTIONS = Object.freeze({
  display: [
    { value: 'industrial', label: 'Industrial Impact', cssValue: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
    { value: 'black', label: 'Heavy Black', cssValue: '"Arial Black", "Segoe UI Black", sans-serif' },
    { value: 'condensed', label: 'Condensed Command', cssValue: '"Arial Narrow", "Roboto Condensed", sans-serif' },
    { value: 'system', label: 'Modern System', cssValue: 'Inter, ui-sans-serif, system-ui, sans-serif' },
    { value: 'cinematic', label: 'Cinematic Serif', cssValue: 'Georgia, "Times New Roman", serif' }
  ],
  body: [
    { value: 'modern', label: 'Modern Sans', cssValue: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    { value: 'humanist', label: 'Humanist Sans', cssValue: '"Segoe UI", Candara, Calibri, sans-serif' },
    { value: 'technical', label: 'Technical Sans', cssValue: 'Arial, Helvetica, sans-serif' },
    { value: 'editorial', label: 'Editorial Serif', cssValue: 'Georgia, Cambria, "Times New Roman", serif' }
  ],
  mono: [
    { value: 'technical', label: 'Technical Mono', cssValue: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace' },
    { value: 'compact', label: 'Compact Mono', cssValue: '"Roboto Mono", "Courier New", monospace' },
    { value: 'system', label: 'System Mono', cssValue: 'ui-monospace, "Cascadia Code", Consolas, monospace' }
  ]
});

const controls = [
  color('pageBackground', 'Page background', 'Deepest site background.', 'brand', '#05070b', '--mm-bg'),
  color('pageBackgroundAlt', 'Background accent', 'Secondary background used in gradients.', 'brand', '#111523', '--mm-bg-alt'),
  color('surface', 'Surface', 'Primary cards and panels.', 'brand', '#0d1118', '--mm-surface'),
  color('surfaceRaised', 'Raised surface', 'Elevated cards, menus, and dialogs.', 'brand', '#141b25', '--mm-surface-raised'),
  color('surfaceSoft', 'Soft surface', 'Quiet fields and nested panels.', 'brand', '#090d13', '--mm-surface-soft'),
  color('overlay', 'Overlay surface', 'Menus and full-screen overlays.', 'brand', '#080b11', '--mm-overlay'),
  color('textPrimary', 'Primary text', 'Headlines and important copy.', 'brand', '#f7f7f2', '--mm-text'),
  color('textMuted', 'Muted text', 'Descriptions and secondary labels.', 'brand', '#a5adba', '--mm-muted'),
  color('textDim', 'Dim text', 'Tertiary notes and inactive labels.', 'brand', '#707987', '--mm-dim'),
  color('brandGold', 'MATT gold', 'Primary brand and purchase action.', 'brand', '#f6ca3b', '--mm-gold'),
  color('brandGoldBright', 'Bright gold', 'Highlights, glints, and active gold.', 'brand', '#ffe773', '--mm-gold-bright'),
  color('brandCyan', 'Ronin cyan', 'Secondary brand and technical UI.', 'brand', '#27d9f3', '--mm-cyan'),
  color('brandCyanBright', 'Bright cyan', 'Cyan highlights and active states.', 'brand', '#81efff', '--mm-cyan-bright'),
  color('positive', 'Success', 'Ready, complete, and healthy states.', 'brand', '#53e5a0', '--mm-positive'),
  color('warning', 'Warning', 'Attention and volatile states.', 'brand', '#ffb84d', '--mm-warning'),
  color('danger', 'Danger', 'Failures, destructive actions, and damage.', 'brand', '#ff657a', '--mm-danger'),
  color('info', 'Information', 'Informational banners and neutral status.', 'brand', '#72bdff', '--mm-info'),
  color('border', 'Border', 'Normal card and control outlines.', 'brand', '#27313d', '--mm-border'),
  color('borderStrong', 'Strong border', 'Selected and emphasized outlines.', 'brand', '#536171', '--mm-border-strong'),
  color('focus', 'Keyboard focus', 'Visible keyboard navigation ring.', 'brand', '#ffffff', '--mm-focus'),
  color('selection', 'Text selection', 'Browser text selection background.', 'brand', '#27d9f3', '--mm-selection'),
  color('scrim', 'Scrim', 'Color behind dialogs and overlays.', 'brand', '#020307', '--mm-scrim'),

  select('displayFont', 'Display font', 'Hero and oversized display lettering.', 'typography', 'industrial', '--mm-font-display', FONT_OPTIONS.display),
  select('headingFont', 'Heading font', 'Panel and section headings.', 'typography', 'black', '--mm-font-heading', FONT_OPTIONS.display),
  select('bodyFont', 'Body font', 'Navigation, controls, and paragraphs.', 'typography', 'modern', '--mm-font-body', FONT_OPTIONS.body),
  select('monoFont', 'Technical font', 'Wallets, counters, and code-like labels.', 'typography', 'technical', '--mm-font-mono', FONT_OPTIONS.mono),
  range('baseFontSize', 'Base font size', 'Global reading size.', 'typography', 16, 12, 22, 1, 'px', '--mm-font-size'),
  range('displayScale', 'Display scale', 'Hero headline size multiplier.', 'typography', 1, 0.7, 1.6, 0.05, '', '--mm-display-scale'),
  range('headingScale', 'Heading scale', 'Section heading size multiplier.', 'typography', 1, 0.75, 1.5, 0.05, '', '--mm-heading-scale'),
  range('bodyLineHeight', 'Body line height', 'Vertical breathing room in paragraphs.', 'typography', 1.55, 1.1, 2, 0.05, '', '--mm-line-height'),
  range('displayTracking', 'Display tracking', 'Hero letter spacing.', 'typography', -0.04, -0.1, 0.15, 0.005, 'em', '--mm-display-tracking'),
  range('headingTracking', 'Heading tracking', 'Section heading letter spacing.', 'typography', -0.025, -0.08, 0.15, 0.005, 'em', '--mm-heading-tracking'),
  range('labelTracking', 'Label tracking', 'Eyebrows and small labels.', 'typography', 0.12, 0, 0.3, 0.01, 'em', '--mm-label-tracking'),
  range('buttonTracking', 'Button tracking', 'Text spacing inside buttons.', 'typography', 0.06, 0, 0.24, 0.01, 'em', '--mm-button-tracking'),
  toggle('uppercaseHeadings', 'Uppercase headings', 'Force major headings into uppercase.', 'typography', true, 'mmUppercaseHeadings'),
  toggle('uppercaseLabels', 'Uppercase labels', 'Force navigation, labels, and buttons into uppercase.', 'typography', true, 'mmUppercaseLabels'),

  range('spacingScale', 'Spacing scale', 'Scales gaps and vertical rhythm.', 'layout', 1, 0.65, 1.6, 0.05, '', '--mm-space-scale'),
  range('contentWidth', 'Content width', 'Maximum width for page content.', 'layout', 1440, 960, 1920, 20, 'px', '--mm-content-width'),
  range('navigationHeight', 'Navigation height', 'Desktop navigation bar height.', 'layout', 84, 58, 124, 2, 'px', '--mm-nav-height'),
  range('pageGutter', 'Page gutter', 'Space at the left and right edges.', 'layout', 28, 10, 72, 2, 'px', '--mm-page-gutter'),
  range('panelPadding', 'Panel padding', 'Interior space inside cards.', 'layout', 24, 10, 52, 2, 'px', '--mm-panel-padding'),
  range('sectionGap', 'Section gap', 'Space between major page sections.', 'layout', 32, 12, 80, 2, 'px', '--mm-section-gap'),
  range('cardGap', 'Card gap', 'Space between cards in a grid.', 'layout', 16, 4, 40, 1, 'px', '--mm-card-gap'),
  range('controlHeight', 'Control height', 'Base button and input height.', 'layout', 48, 34, 72, 2, 'px', '--mm-control-height'),
  range('iconScale', 'Icon scale', 'Global icon and badge multiplier.', 'layout', 1, 0.7, 1.6, 0.05, '', '--mm-icon-scale'),
  range('heroHeight', 'Hero height', 'Home-page hero viewport height.', 'layout', 720, 480, 980, 20, 'px', '--mm-hero-height'),

  range('radiusSmall', 'Small radius', 'Inputs, badges, and compact controls.', 'shape', 6, 0, 24, 1, 'px', '--mm-radius-sm'),
  range('radiusMedium', 'Medium radius', 'Buttons and standard cards.', 'shape', 12, 0, 36, 1, 'px', '--mm-radius-md'),
  range('radiusLarge', 'Large radius', 'Feature cards, panels, and dialogs.', 'shape', 22, 0, 56, 1, 'px', '--mm-radius-lg'),
  range('pillRadius', 'Pill radius', 'Status pills and round controls.', 'shape', 999, 12, 999, 1, 'px', '--mm-radius-pill'),
  range('borderWidth', 'Border width', 'Global outline weight.', 'shape', 1, 0, 4, 1, 'px', '--mm-border-width'),
  range('buttonSkew', 'Button angle', 'Angular cut applied to primary controls.', 'shape', 0, -8, 8, 1, 'deg', '--mm-button-skew'),
  select('cardClip', 'Card silhouette', 'Outer geometry for major cards.', 'shape', 'soft-cut', '--mm-card-clip', [
    { value: 'rectangle', label: 'Rectangle', cssValue: 'none' },
    { value: 'soft-cut', label: 'Soft corner cut', cssValue: 'polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))' },
    { value: 'hard-cut', label: 'Hard corner cut', cssValue: 'polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px))' }
  ], 'mmCardClip'),

  range('glowIntensity', 'Glow intensity', 'Strength of gold and cyan light.', 'effects', 0.75, 0, 2, 0.05, '', '--mm-glow-intensity'),
  range('shadowIntensity', 'Shadow intensity', 'Depth of panels and menus.', 'effects', 0.75, 0, 1.5, 0.05, '', '--mm-shadow-intensity'),
  range('surfaceOpacity', 'Surface opacity', 'Transparency of cards and panels.', 'effects', 0.94, 0.45, 1, 0.01, '', '--mm-surface-opacity'),
  range('navigationOpacity', 'Navigation opacity', 'Transparency of the top navigation.', 'effects', 0.96, 0.35, 1, 0.01, '', '--mm-nav-opacity'),
  range('backdropBlur', 'Glass blur', 'Background blur behind translucent UI.', 'effects', 14, 0, 32, 1, 'px', '--mm-blur'),
  range('imageSaturation', 'Image saturation', 'Color strength of site artwork.', 'effects', 1, 0, 1.8, 0.05, '', '--mm-image-saturation'),
  range('imageContrast', 'Image contrast', 'Dark-to-light range of site artwork.', 'effects', 1.05, 0.65, 1.65, 0.05, '', '--mm-image-contrast'),
  range('imageBrightness', 'Image brightness', 'Overall brightness of site artwork.', 'effects', 0.92, 0.55, 1.45, 0.05, '', '--mm-image-brightness'),
  range('gridOpacity', 'Grid opacity', 'Strength of the technical background grid.', 'effects', 0.035, 0, 0.2, 0.005, '', '--mm-grid-opacity'),
  range('noiseOpacity', 'Texture opacity', 'Strength of subtle surface texture.', 'effects', 0.035, 0, 0.18, 0.005, '', '--mm-noise-opacity'),
  range('vignetteIntensity', 'Vignette', 'Darkening around the viewport edges.', 'effects', 0.42, 0, 0.9, 0.02, '', '--mm-vignette'),
  range('scanlineOpacity', 'Scanlines', 'Technical scanline overlay strength.', 'effects', 0, 0, 0.14, 0.005, '', '--mm-scanline-opacity'),
  toggle('showGrid', 'Show background grid', 'Display the technical page grid.', 'effects', true, 'mmShowGrid'),
  toggle('showTexture', 'Show surface texture', 'Display the subtle texture layer.', 'effects', true, 'mmShowTexture'),
  toggle('showVignette', 'Show vignette', 'Display edge shading across the site.', 'effects', true, 'mmShowVignette'),

  range('motionScale', 'Motion scale', 'Multiplier for non-essential animation.', 'motion', 1, 0, 2, 0.05, '', '--mm-motion-scale'),
  range('transitionSpeed', 'Transition speed', 'Base UI transition duration.', 'motion', 180, 0, 800, 10, 'ms', '--mm-transition-speed'),
  range('hoverLift', 'Hover lift', 'Vertical rise when hovering a card or button.', 'motion', 3, 0, 14, 1, 'px', '--mm-hover-lift'),
  range('hoverScale', 'Hover scale', 'Growth applied on interactive hover.', 'motion', 1.015, 1, 1.08, 0.005, '', '--mm-hover-scale'),
  range('pulseIntensity', 'Pulse intensity', 'Strength of live and connected pulses.', 'motion', 0.7, 0, 1.5, 0.05, '', '--mm-pulse-intensity'),
  range('parallaxIntensity', 'Parallax intensity', 'Depth response on hero artwork.', 'motion', 0.45, 0, 1.5, 0.05, '', '--mm-parallax-intensity'),
  toggle('reducedMotion', 'Reduce motion', 'Disable decorative animation and transitions.', 'motion', false, 'mmReducedMotion'),

  select('primaryButtonStyle', 'Primary button', 'Visual treatment for main actions.', 'components', 'gold', null, [
    { value: 'gold', label: 'MATT gold' },
    { value: 'cyan', label: 'Ronin cyan' },
    { value: 'outline', label: 'Technical outline' }
  ], 'mmPrimaryButton'),
  select('secondaryButtonStyle', 'Secondary button', 'Visual treatment for secondary actions.', 'components', 'surface', null, [
    { value: 'surface', label: 'Raised surface' },
    { value: 'outline', label: 'Clean outline' },
    { value: 'ghost', label: 'Minimal ghost' }
  ], 'mmSecondaryButton'),
  select('navigationStyle', 'Navigation style', 'Treatment for the persistent navigation.', 'components', 'glass', null, [
    { value: 'glass', label: 'Glass command bar' },
    { value: 'solid', label: 'Solid command bar' },
    { value: 'minimal', label: 'Minimal divider' }
  ], 'mmNavigation'),
  select('cardAccent', 'Card accent', 'Accent line used on cards and panels.', 'components', 'mixed', null, [
    { value: 'mixed', label: 'Gold + cyan' },
    { value: 'gold', label: 'Gold only' },
    { value: 'cyan', label: 'Cyan only' },
    { value: 'none', label: 'No accent' }
  ], 'mmCardAccent'),
  select('menuDensity', 'Menu density', 'Global breathing room for menus and lists.', 'components', 'comfortable', null, [
    { value: 'compact', label: 'Compact' },
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'spacious', label: 'Spacious' }
  ], 'mmDensity'),
  select('heroAlignment', 'Hero alignment', 'Home-page hero copy alignment.', 'components', 'left', null, [
    { value: 'left', label: 'Left aligned' },
    { value: 'center', label: 'Centered' }
  ], 'mmHeroAlignment'),
  toggle('stickyNavigation', 'Sticky navigation', 'Keep the main navigation visible while scrolling.', 'components', true, 'mmStickyNavigation'),
  toggle('accentHeadings', 'Accent headings', 'Apply a brand gradient to major display headings.', 'components', false, 'mmAccentHeadings'),

  toggle('highContrast', 'High contrast', 'Strengthen text and borders for maximum separation.', 'accessibility', false, 'mmHighContrast'),
  toggle('largeTargets', 'Large targets', 'Guarantee larger clickable controls.', 'accessibility', false, 'mmLargeTargets'),
  toggle('grayscale', 'Grayscale mode', 'Remove color from the public experience.', 'accessibility', false, 'mmGrayscale'),
  range('focusRingWidth', 'Focus ring width', 'Keyboard focus outline thickness.', 'accessibility', 3, 1, 8, 1, 'px', '--mm-focus-width'),
  toggle('underlineLinks', 'Underline text links', 'Keep text links visibly identifiable.', 'accessibility', false, 'mmUnderlineLinks')
];

export const SITE_THEME_CONTROLS = Object.freeze(controls.map((control) => Object.freeze({
  ...control,
  ...(control.options ? { options: Object.freeze(control.options.map((option) => Object.freeze({ ...option }))) } : {})
})));

const CONTROL_BY_ID = new Map(SITE_THEME_CONTROLS.map((control) => [control.id, control]));
export const SITE_THEME_DEFAULT_TOKENS = Object.freeze(Object.fromEntries(SITE_THEME_CONTROLS.map((control) => [control.id, control.default])));

export function defaultSiteTheme() {
  return {
    schemaVersion: SITE_THEME_SCHEMA_VERSION,
    name: 'MATT Mine Original',
    tokens: { ...SITE_THEME_DEFAULT_TOKENS }
  };
}

export const SITE_THEME_PRESETS = Object.freeze([
  themePreset('original', 'MATT Mine Original', 'Production gold, tactical black, and Ronin cyan.', {}),
  themePreset('ronin', 'Ronin Reactor', 'Electric cyan, deep navy surfaces, and sharper technical contrast.', {
    pageBackground: '#02070d', pageBackgroundAlt: '#071d2b', surface: '#07131c', surfaceRaised: '#0b2230',
    brandGold: '#7cecff', brandGoldBright: '#c5f8ff', brandCyan: '#00c8ff', brandCyanBright: '#7cecff',
    border: '#174358', borderStrong: '#2387a9', primaryButtonStyle: 'cyan', cardAccent: 'cyan', glowIntensity: 1.15,
    cardClip: 'hard-cut', navigationStyle: 'glass'
  }),
  themePreset('crystal', 'Crystal Vault', 'Purple crystal atmosphere with a premium gold signal.', {
    pageBackground: '#080511', pageBackgroundAlt: '#24133c', surface: '#110c1d', surfaceRaised: '#1b1230',
    surfaceSoft: '#0d0817', brandGold: '#f3bf43', brandGoldBright: '#ffeaa0', brandCyan: '#9a6cff',
    brandCyanBright: '#c3a9ff', border: '#392955', borderStrong: '#7555a8', selection: '#9a6cff',
    glowIntensity: 1.25, vignetteIntensity: 0.58, imageSaturation: 1.2, cardAccent: 'mixed'
  }),
  themePreset('molten', 'Molten Core', 'Hot amber metal, red danger lights, and rugged geometry.', {
    pageBackground: '#0b0503', pageBackgroundAlt: '#2b0e06', surface: '#160b07', surfaceRaised: '#26120a',
    brandGold: '#ff9d24', brandGoldBright: '#ffd071', brandCyan: '#ff5e3d', brandCyanBright: '#ff9b83',
    danger: '#ff3d4f', warning: '#ffc14d', border: '#522511', borderStrong: '#a54920', primaryButtonStyle: 'gold',
    cardAccent: 'gold', cardClip: 'hard-cut', imageContrast: 1.2, glowIntensity: 1.1
  }),
  themePreset('terminal', 'Deep Terminal', 'Compact green command interface for a pure operations feel.', {
    pageBackground: '#020806', pageBackgroundAlt: '#071810', surface: '#06100c', surfaceRaised: '#0b1c14',
    textPrimary: '#eaffef', textMuted: '#87b798', textDim: '#52705d', brandGold: '#78f29b',
    brandGoldBright: '#c5ffd5', brandCyan: '#4bdea6', brandCyanBright: '#9affd4', positive: '#78f29b',
    border: '#153b26', borderStrong: '#2f7950', displayFont: 'condensed', headingFont: 'condensed', bodyFont: 'technical',
    monoFont: 'technical', menuDensity: 'compact', radiusMedium: 4, radiusLarge: 8, cardClip: 'rectangle',
    primaryButtonStyle: 'outline', secondaryButtonStyle: 'ghost', cardAccent: 'cyan', scanlineOpacity: 0.035
  }),
  themePreset('high-contrast', 'High Contrast', 'Maximum legibility, large targets, and restrained motion.', {
    pageBackground: '#000000', pageBackgroundAlt: '#080808', surface: '#080808', surfaceRaised: '#141414',
    surfaceSoft: '#050505', textPrimary: '#ffffff', textMuted: '#e2e2e2', textDim: '#bdbdbd',
    brandGold: '#ffe047', brandGoldBright: '#fff3a8', brandCyan: '#51e8ff', brandCyanBright: '#b8f7ff',
    border: '#767676', borderStrong: '#ffffff', focus: '#ffffff', baseFontSize: 18, bodyLineHeight: 1.7,
    controlHeight: 58, borderWidth: 2, glowIntensity: 0.25, shadowIntensity: 0.35, highContrast: true,
    largeTargets: true, reducedMotion: true, focusRingWidth: 5, underlineLinks: true
  })
]);

export function siteThemePreset(id) {
  const preset = SITE_THEME_PRESETS.find((candidate) => candidate.id === id) || SITE_THEME_PRESETS[0];
  return structuredClone(preset.theme);
}

export function normalizeSiteTheme(input = {}, fallback = defaultSiteTheme()) {
  const safeFallback = fallback && typeof fallback === 'object' ? fallback : defaultSiteTheme();
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sourceTokens = source.tokens && typeof source.tokens === 'object' && !Array.isArray(source.tokens) ? source.tokens : {};
  const fallbackTokens = safeFallback.tokens && typeof safeFallback.tokens === 'object' ? safeFallback.tokens : SITE_THEME_DEFAULT_TOKENS;
  const tokens = Object.fromEntries(SITE_THEME_CONTROLS.map((control) => [
    control.id,
    normalizeControlValue(control, sourceTokens[control.id], fallbackTokens[control.id] ?? control.default)
  ]));
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 64)
    : String(safeFallback.name || 'MATT Mine Theme').slice(0, 64);
  return { schemaVersion: SITE_THEME_SCHEMA_VERSION, name, tokens };
}

export function validateSiteTheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Theme must be a JSON object.');
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 64) {
    throw new TypeError('Theme name must be 1 to 64 characters.');
  }
  if (!input.tokens || typeof input.tokens !== 'object' || Array.isArray(input.tokens)) throw new TypeError('Theme tokens must be an object.');
  const unknown = Object.keys(input.tokens).filter((id) => !CONTROL_BY_ID.has(id));
  if (unknown.length) throw new TypeError(`Unknown theme controls: ${unknown.join(', ')}.`);
  for (const [id, value] of Object.entries(input.tokens)) validateControlValue(CONTROL_BY_ID.get(id), value);
  return normalizeSiteTheme(input);
}

export function defaultSiteThemeState(timestamp = 0) {
  return {
    version: 1,
    published: defaultSiteTheme(),
    updatedAt: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0,
    updatedBy: 'SYSTEM_DEFAULT'
  };
}

export function normalizeSiteThemeState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    version: Number.isSafeInteger(source.version) && source.version >= 1 ? source.version : 1,
    published: normalizeSiteTheme(source.published),
    updatedAt: Number.isSafeInteger(source.updatedAt) && source.updatedAt >= 0 ? source.updatedAt : 0,
    updatedBy: typeof source.updatedBy === 'string' && source.updatedBy.trim()
      ? source.updatedBy.trim().slice(0, 80)
      : 'SYSTEM_DEFAULT'
  };
}

export function changedSiteThemeControls(left, right) {
  const a = normalizeSiteTheme(left);
  const b = normalizeSiteTheme(right);
  return SITE_THEME_CONTROLS.filter((control) => a.tokens[control.id] !== b.tokens[control.id]);
}

export function applySiteTheme(input, root = globalThis.document?.documentElement) {
  const theme = normalizeSiteTheme(input);
  if (!root?.style) return theme;
  for (const control of SITE_THEME_CONTROLS) {
    const value = theme.tokens[control.id];
    if (control.cssVar) root.style.setProperty(control.cssVar, controlCssValue(control, value));
    if (control.dataAttr && root.dataset) root.dataset[control.dataAttr] = String(value);
  }
  const tokens = theme.tokens;
  root.style.setProperty('--mm-grid-visible-opacity', tokens.showGrid ? String(tokens.gridOpacity) : '0');
  root.style.setProperty('--mm-noise-visible-opacity', tokens.showTexture ? String(tokens.noiseOpacity) : '0');
  root.style.setProperty('--mm-vignette-visible-opacity', tokens.showVignette ? String(tokens.vignetteIntensity) : '0');
  root.style.setProperty('--mm-motion-effective', tokens.reducedMotion ? '0' : String(tokens.motionScale));
  root.style.setProperty('--mm-transition-effective', tokens.reducedMotion ? '0ms' : `${tokens.transitionSpeed}ms`);
  const motion = tokens.reducedMotion ? 0 : tokens.motionScale;
  root.style.setProperty('--mm-hover-effective', `${Number((tokens.hoverLift * motion).toFixed(2))}px`);
  root.style.setProperty('--mm-hover-scale-effective', String(Number((1 + ((tokens.hoverScale - 1) * motion)).toFixed(4))));
  root.style.setProperty('--mm-pulse-effective', String(Number((tokens.pulseIntensity * motion).toFixed(3))));
  root.style.setProperty('--mm-parallax-effective', String(Number((tokens.parallaxIntensity * motion).toFixed(3))));
  root.style.setProperty('--mm-grayscale-filter', tokens.grayscale ? 'grayscale(1)' : 'grayscale(0)');
  root.style.setProperty('--mm-shadow-alpha', `${Math.round(Math.min(1, tokens.shadowIntensity / 1.5) * 62)}%`);
  root.style.setProperty('--mm-glow-alpha', `${Math.round(Math.min(1, tokens.glowIntensity / 2) * 52)}%`);
  root.style.setProperty('--mm-surface-opacity-percent', `${Math.round(tokens.surfaceOpacity * 100)}%`);
  root.style.setProperty('--mm-surface-soft-opacity-percent', `${Math.round(tokens.surfaceOpacity * 88)}%`);
  root.style.setProperty('--mm-nav-opacity-percent', `${Math.round(tokens.navigationOpacity * 100)}%`);
  root.style.setProperty('--mm-blur-half', `${Number((tokens.backdropBlur * 0.5).toFixed(2))}px`);
  const density = { compact: 0.78, comfortable: 1, spacious: 1.24 }[tokens.menuDensity] || 1;
  const spacing = tokens.spacingScale * density;
  root.style.setProperty('--mm-space-effective', String(Number(spacing.toFixed(3))));
  root.style.setProperty('--mm-panel-padding-effective', `${Number((tokens.panelPadding * spacing).toFixed(2))}px`);
  root.style.setProperty('--mm-card-gap-effective', `${Number((tokens.cardGap * spacing).toFixed(2))}px`);
  root.style.setProperty('--mm-hover-translate', `${Number((-tokens.hoverLift * motion).toFixed(2))}px`);
  root.style.setProperty('--mm-pulse-radius', `${Number((4 + (12 * tokens.pulseIntensity * motion)).toFixed(2))}px`);
  root.style.setProperty('--mm-parallax-scale', String(Number((1 + (0.012 * tokens.parallaxIntensity * motion)).toFixed(4))));
  root.style.setProperty('--mm-preview-icon-size', `${Number((25 * tokens.iconScale).toFixed(2))}px`);
  root.style.setProperty('--mm-preview-hero-padding', `${Number((34 * spacing).toFixed(2))}px`);
  root.style.setProperty('--mm-preview-display-size', `${Number((3 * tokens.displayScale).toFixed(3))}rem`);
  root.style.setProperty('--mm-preview-mobile-display-size', `${Number((2.3 * tokens.displayScale).toFixed(3))}rem`);
  root.style.setProperty('--mm-preview-heading-size', `${Number((1.25 * tokens.headingScale).toFixed(3))}rem`);
  root.style.setProperty('--mm-preview-section-heading-size', `${Number((1.15 * tokens.headingScale).toFixed(3))}rem`);
  root.style.setProperty('--mm-preview-button-gap', `${Number((8 * spacing).toFixed(2))}px`);
  root.style.setProperty('--mm-preview-button-height', `${Number((tokens.controlHeight * 0.8).toFixed(2))}px`);
  root.style.setProperty('--mm-preview-card-padding', `${Number((tokens.panelPadding * 0.58 * spacing).toFixed(2))}px`);
  root.dataset.mmTheme = theme.name;
  root.dataset.mmThemeSchema = String(SITE_THEME_SCHEMA_VERSION);
  return theme;
}

export function themeCssText(input, selector = ':root') {
  const theme = normalizeSiteTheme(input);
  const declarations = [];
  for (const control of SITE_THEME_CONTROLS) {
    if (!control.cssVar) continue;
    declarations.push(`  ${control.cssVar}: ${controlCssValue(control, theme.tokens[control.id])};`);
  }
  return `${selector} {\n${declarations.join('\n')}\n}`;
}

export function writeSiteThemeDraft(input, storage = globalThis.localStorage) {
  const theme = validateSiteTheme(input);
  storage?.setItem?.(SITE_THEME_DRAFT_STORAGE_KEY, JSON.stringify({ theme, savedAt: Date.now() }));
  return theme;
}

export function readSiteThemeDraft(storage = globalThis.localStorage) {
  try {
    const stored = JSON.parse(storage?.getItem?.(SITE_THEME_DRAFT_STORAGE_KEY) || 'null');
    if (!stored?.theme) return null;
    return { theme: validateSiteTheme(stored.theme), savedAt: Number(stored.savedAt || 0) };
  } catch {
    return null;
  }
}

export function clearSiteThemeDraft(storage = globalThis.localStorage) {
  storage?.removeItem?.(SITE_THEME_DRAFT_STORAGE_KEY);
}

export function isSiteThemePreview(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('theme-preview') === '1';
}

function color(id, label, description, group, defaultValue, cssVar) {
  return { id, label, description, group, type: 'color', default: defaultValue, cssVar };
}

function range(id, label, description, group, defaultValue, min, max, step, unit, cssVar) {
  return { id, label, description, group, type: 'range', default: defaultValue, min, max, step, unit, cssVar };
}

function select(id, label, description, group, defaultValue, cssVar, options, dataAttr = '') {
  return { id, label, description, group, type: 'select', default: defaultValue, cssVar, options, dataAttr };
}

function toggle(id, label, description, group, defaultValue, dataAttr) {
  return { id, label, description, group, type: 'boolean', default: defaultValue, dataAttr };
}

function themePreset(id, name, description, patch) {
  return Object.freeze({
    id,
    name,
    description,
    theme: Object.freeze({
      schemaVersion: SITE_THEME_SCHEMA_VERSION,
      name,
      tokens: Object.freeze({ ...SITE_THEME_DEFAULT_TOKENS, ...patch })
    })
  });
}

function normalizeControlValue(control, value, fallback) {
  if (control.type === 'color') return /^#[a-fA-F0-9]{6}$/.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  if (control.type === 'boolean') return typeof value === 'boolean' ? value : Boolean(fallback);
  if (control.type === 'select') return control.options.some((option) => option.value === value) ? value : fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(control.max, Math.max(control.min, numeric));
  const precision = String(control.step).includes('.') ? String(control.step).split('.')[1].length : 0;
  return Number(clamped.toFixed(precision));
}

function validateControlValue(control, value) {
  if (control.type === 'color' && !/^#[a-fA-F0-9]{6}$/.test(String(value || ''))) {
    throw new TypeError(`${control.label} must be a six-digit hex color.`);
  }
  if (control.type === 'boolean' && typeof value !== 'boolean') throw new TypeError(`${control.label} must be on or off.`);
  if (control.type === 'select' && !control.options.some((option) => option.value === value)) {
    throw new TypeError(`${control.label} has an unsupported option.`);
  }
  if (control.type === 'range' && (typeof value !== 'number' || !Number.isFinite(value) || value < control.min || value > control.max)) {
    throw new TypeError(`${control.label} must be between ${control.min} and ${control.max}.`);
  }
}

function controlCssValue(control, value) {
  if (control.type === 'select') return control.options.find((option) => option.value === value)?.cssValue || String(value);
  if (control.type === 'boolean') return value ? '1' : '0';
  if (control.type === 'range') return `${value}${control.unit || ''}`;
  return String(value);
}
