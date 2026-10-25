import type { ControlApi } from './control';
import type { ChatEvent, ImageInfo, PendingApproval, VisionEvent, VisionStatus, VisionStyle } from './types';

/**
 * What the screens need from "the Pi". The real `VedaApi` implements it, and so does `DemoApi` (canned answers, no network),
 * so no screen has to know whether it is talking to a real Pi.
 */
export interface PiApi extends ControlApi {
  health(signal?: AbortSignal): Promise<void>;
  visionStatus(signal?: AbortSignal): Promise<VisionStatus>;
  putImage(bytes: Uint8Array, mime?: string, signal?: AbortSignal): Promise<ImageInfo>;
  askVision(
    req: { imageId: string; question?: string | null; style?: VisionStyle },
    signal?: AbortSignal,
  ): AsyncGenerator<VisionEvent>;
  chatStream(message: string, signal?: AbortSignal, sessionId?: string): AsyncGenerator<ChatEvent>;
  pendingApprovals(signal?: AbortSignal): Promise<PendingApproval[]>;
  approve(requestId: string, signal?: AbortSignal): Promise<void>;
  deny(requestId: string, signal?: AbortSignal): Promise<void>;
}
