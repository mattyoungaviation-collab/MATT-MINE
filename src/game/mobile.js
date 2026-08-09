const MOBILE_PORTRAIT_MAX_WIDTH = 760;
const MAX_CANVAS_PIXELS = 1_920 * 1_080;
const MIN_PORTRAIT_LOGICAL_WIDTH = 420;

export function touchInputDetected(runtime = globalThis) {
  const touchPoints = Number(runtime.navigator?.maxTouchPoints || 0);
  const coarsePointer = runtime.matchMedia?.('(pointer: coarse)')?.matches === true;
  return touchPoints > 0 || coarsePointer;
}

export function viewportDimensions(runtime = globalThis) {
  const viewport = runtime.visualViewport;
  return {
    width: positive(viewport?.width) || positive(runtime.innerWidth),
    height: positive(viewport?.height) || positive(runtime.innerHeight)
  };
}

export function mobilePortraitGameplay(
  runtime = globalThis,
  touchInput = touchInputDetected(runtime)
) {
  const { width, height } = viewportDimensions(runtime);
  return touchInput && width > 0 && height > 0 && width < height && width <= MOBILE_PORTRAIT_MAX_WIDTH;
}

export function gameplayViewportSize({
  cssWidth,
  cssHeight,
  defaultWidth,
  defaultHeight,
  touchInput = false
}) {
  const safeDefaultWidth = Math.max(1, positive(defaultWidth) || 1);
  const safeDefaultHeight = Math.max(1, positive(defaultHeight) || 1);
  const renderedWidth = positive(cssWidth) || safeDefaultWidth;
  const renderedHeight = positive(cssHeight) || safeDefaultHeight;
  const portrait = touchInput && renderedHeight > renderedWidth && renderedWidth <= MOBILE_PORTRAIT_MAX_WIDTH;
  if (!portrait) {
    return {
      logicalWidth: safeDefaultWidth,
      logicalHeight: safeDefaultHeight,
      portrait: false
    };
  }

  let logicalHeight = safeDefaultHeight;
  let logicalWidth = logicalHeight * renderedWidth / renderedHeight;
  if (logicalWidth < MIN_PORTRAIT_LOGICAL_WIDTH) {
    const scale = MIN_PORTRAIT_LOGICAL_WIDTH / logicalWidth;
    logicalWidth *= scale;
    logicalHeight *= scale;
  }
  return {
    logicalWidth: Math.round(logicalWidth),
    logicalHeight: Math.round(logicalHeight),
    portrait: true
  };
}

export function portraitGameplayCanvas(canvas) {
  return canvas?.dataset?.orientation === 'portrait';
}

export function enterMobileGameplayFullscreen(element, runtime = globalThis) {
  const documentObject = runtime.document;
  documentObject?.documentElement?.classList?.add('mobile-gameplay-fullscreen');
  runtime.scrollTo?.(0, 1);

  // Embedded wallets commonly reject orientation changes, while browsers that
  // do accept fullscreen may resize a portrait page into a landscape surface.
  // The portrait layout already fills the available dynamic viewport, so it
  // deliberately avoids the native fullscreen API.
  const portraitLayoutActive =
    mobilePortraitGameplay(runtime) ||
    documentObject?.documentElement?.classList?.contains?.('portrait-mobile') === true;
  if (portraitLayoutActive) return Promise.resolve(false);

  const requestFullscreen = element?.requestFullscreen || element?.webkitRequestFullscreen;
  if (typeof requestFullscreen !== 'function') return Promise.resolve(false);

  try {
    const requested = requestFullscreen.call(element, { navigationUI: 'hide' });
    return Promise.resolve(requested)
      .then(() => true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function exitMobileGameplayFullscreen(runtime = globalThis) {
  runtime.document?.documentElement?.classList?.remove('mobile-gameplay-fullscreen');
  const documentObject = runtime.document;
  if (!documentObject?.fullscreenElement && !documentObject?.webkitFullscreenElement) {
    return Promise.resolve(false);
  }
  const exitFullscreen = documentObject.exitFullscreen || documentObject.webkitExitFullscreen;
  if (typeof exitFullscreen !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(exitFullscreen.call(documentObject)).then(() => true).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function canvasRenderSize({
  cssWidth,
  cssHeight,
  logicalWidth,
  logicalHeight,
  devicePixelRatio = 1,
  touchInput = false
}) {
  const safeLogicalWidth = Math.max(1, positive(logicalWidth) || 1);
  const safeLogicalHeight = Math.max(1, positive(logicalHeight) || 1);
  const renderedWidth = positive(cssWidth) || safeLogicalWidth;
  const renderedHeight = positive(cssHeight) || safeLogicalHeight;
  // The game renders a full-screen canvas every animation frame. Retina-scale
  // 2D buffers multiply the cost of gradients, shadows, sprites, and clears
  // without improving gameplay. Keep desktop at full-HD class sharpness and
  // use a slightly leaner buffer on touch devices where mobile GPUs are the
  // common frame-time bottleneck.
  const ratioCap = touchInput ? 1.25 : 1.5;
  const pixelRatio = Math.min(Math.max(1, positive(devicePixelRatio) || 1), ratioCap);
  let pixelWidth = Math.max(
    1,
    Math.min(Math.round(renderedWidth * pixelRatio), Math.round(safeLogicalWidth * 2))
  );
  let pixelHeight = Math.max(
    1,
    Math.min(Math.round(renderedHeight * pixelRatio), Math.round(safeLogicalHeight * 2))
  );
  const pixelCount = pixelWidth * pixelHeight;
  if (pixelCount > MAX_CANVAS_PIXELS) {
    const budgetScale = Math.sqrt(MAX_CANVAS_PIXELS / pixelCount);
    pixelWidth = Math.max(1, Math.round(pixelWidth * budgetScale));
    pixelHeight = Math.max(1, Math.round(pixelHeight * budgetScale));
  }
  return {
    pixelWidth,
    pixelHeight,
    scaleX: pixelWidth / safeLogicalWidth,
    scaleY: pixelHeight / safeLogicalHeight
  };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
