const MOBILE_PORTRAIT_MAX_WIDTH = 760;

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

export function mobileLandscapeRequired(
  runtime = globalThis,
  touchInput = touchInputDetected(runtime)
) {
  const { width, height } = viewportDimensions(runtime);
  return touchInput && width > 0 && height > 0 && width < height && width <= MOBILE_PORTRAIT_MAX_WIDTH;
}

export function enterMobileGameplayFullscreen(element, runtime = globalThis) {
  const documentObject = runtime.document;
  documentObject?.documentElement?.classList?.add('mobile-gameplay-fullscreen');
  runtime.scrollTo?.(0, 1);

  const requestFullscreen = element?.requestFullscreen || element?.webkitRequestFullscreen;
  if (typeof requestFullscreen !== 'function') return Promise.resolve(false);

  try {
    const requested = requestFullscreen.call(element, { navigationUI: 'hide' });
    const orientationLock = () => runtime.screen?.orientation?.lock?.('landscape')?.catch?.(() => undefined);
    return Promise.resolve(requested)
      .then(() => {
        orientationLock();
        return true;
      })
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
  const pixelWidth = Math.max(
    1,
    Math.min(Math.round(renderedWidth * pixelRatio), Math.round(safeLogicalWidth * 2))
  );
  const pixelHeight = Math.max(
    1,
    Math.min(Math.round(renderedHeight * pixelRatio), Math.round(safeLogicalHeight * 2))
  );
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
