const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 48 * 1024;

export async function prepareProfileImage(file, runtime = globalThis) {
  const fileType = file?.type || inferImageType(file?.name);
  if (!file || !ALLOWED_IMAGE_TYPES.has(fileType)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image smaller than 5 MB.');

  const objectUrl = runtime.URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl, runtime.Image);
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    const outputs = [
      [160, 'image/png', 1],
      [160, 'image/webp', 0.86],
      [144, 'image/webp', 0.74],
      [128, 'image/jpeg', 0.76]
    ];

    for (const [size, outputType, quality] of outputs) {
      const output = runtime.document.createElement('canvas');
      output.width = size;
      output.height = size;
      const context = output.getContext('2d');
      if (!context) continue;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        size,
        size
      );
      const dataUrl = output.toDataURL(outputType, quality);
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) continue;
      const encoded = dataUrl.split(',')[1] || '';
      const decodedBytes = Math.floor(encoded.length * 3 / 4);
      if (decodedBytes <= MAX_AVATAR_BYTES) return dataUrl;
    }
    throw new Error('That picture is too detailed. Try a simpler or smaller image.');
  } finally {
    runtime.URL.revokeObjectURL(objectUrl);
  }
}

function inferImageType(name = '') {
  const normalized = String(name).toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (/\.(jpe?g)$/.test(normalized)) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  return '';
}

function loadImage(source, ImageConstructor) {
  return new Promise((resolve, reject) => {
    const image = new ImageConstructor();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected image could not be opened.'));
    image.src = source;
  });
}
