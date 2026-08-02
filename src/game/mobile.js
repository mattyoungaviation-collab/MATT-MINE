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
  const ratioCap = touchInput ? 1.5 : 2;
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
