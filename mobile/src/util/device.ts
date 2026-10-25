import { Platform } from 'react-native';

/** A name for this phone to show on the Pi ("Pixel 8"), used when the person does not type one. */
export function defaultDeviceName(): string {
  const constants = Platform.constants as { Model?: string; Brand?: string } | undefined;
  const model = constants?.Model?.trim();
  return model ? model.slice(0, 40) : 'My phone';
}
