import type { MusicInfo } from './types';

/**
 * The Music tab's calls. The sound comes from the Pi's own speaker, never from this phone: these only ask the Pi to start,
 * pause or stop it. A phone may use them only if it was paired with the control permission.
 */
export interface MusicApi {
  /** What the music is doing. Answers even when music is off on the Pi (`available: false`, with the reason). */
  musicStatus(signal?: AbortSignal): Promise<MusicInfo>;
  /** Find the song and queue it. The Pi names the one it picked; it starts once Veda has finished talking. */
  playSong(query: string, signal?: AbortSignal): Promise<MusicInfo>;
  stopMusic(signal?: AbortSignal): Promise<MusicInfo>;
  pauseMusic(signal?: AbortSignal): Promise<MusicInfo>;
  resumeMusic(signal?: AbortSignal): Promise<MusicInfo>;
}
