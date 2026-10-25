import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { Photo } from '../features/look/ports';

/** The longest side sent to the Pi. The model sees about this much anyway, and it keeps the upload to a few hundred KB. */
export const LONG_EDGE = 768;
export const JPEG_QUALITY = 0.8;

export type RawPicture = { uri: string; width: number; height: number };

const remove = (uri: string) => {
  try {
    new File(uri).delete();
  } catch {
    // already gone
  }
};

/** Shrink a camera picture, read its bytes, and delete the full-size original. The returned photo deletes its own file. */
export async function preparePhoto(raw: RawPicture): Promise<Photo> {
  try {
    const longEdge = Math.max(raw.width, raw.height);
    const context = ImageManipulator.manipulate(raw.uri);
    if (longEdge > LONG_EDGE) {
      context.resize(raw.width >= raw.height ? { width: LONG_EDGE } : { height: LONG_EDGE });
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
    const bytes = await new File(saved.uri).bytes();
    return { uri: saved.uri, width: saved.width, height: saved.height, bytes, discard: () => remove(saved.uri) };
  } finally {
    remove(raw.uri);
  }
}
