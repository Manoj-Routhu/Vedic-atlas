"""SpeakerPlayback — plays PCM chunks through the default output device.

Donor: veda/voice/audio_io.py's SpeakerPlayer, read in full (Batch 3
grounding). Chunks are queued and played in order so sentence-by-sentence
TTS output queues cleanly instead of overlapping.

`wait_done()` was added after a real feedback-loop bug: VoiceSession was
*estimating* playback duration from PCM length and re-opening the mic when
that estimate expired. Playback actually starts late (queue hand-off plus
stream startup latency), so the mic re-opened while the speaker was
still talking — Veda transcribed its own voice and answered itself in a
loop. Callers now wait for real completion instead of guessing.

One output stream stays open and is fed silence between replies. The donor
called `sd.play()` per chunk, which starts a new stream every sentence; on
the Pi (PulseAudio) every start, and every restart after the stream ran dry,
waited ~2 s before any sound (measured 2026-10-27), and an idle PulseAudio
sink is suspended after 5 s, which a Bluetooth speaker then has to wake from.
A stream that never runs dry starts new audio within its own latency (~35 ms).
"""

from __future__ import annotations

import collections
import threading
import time

from core.logging_config import logger


class SpeakerPlayback:
    """Queued PCM playback via one long-lived sounddevice output stream."""

    def __init__(self, device_index: int | None = None):
        self.device_index = device_index
        self._chunks: collections.deque = collections.deque()   # int16 sample arrays, played in order
        self._current = None   # samples being played now
        self._pos = 0
        self._stream = None
        self._rate: int | None = None
        # Set while nothing is queued AND nothing is mid-playback.
        self._idle = threading.Event()
        self._idle.set()
        self._lock = threading.Lock()
        self._drained_at = 0.0   # perf_counter when the callback handed over the last queued sample

    def start(self) -> None:
        """Nothing to start: the stream opens on the first chunk (or on `keep_open`)."""

    def stop(self) -> None:
        self.interrupt()
        with self._lock:
            stream, self._stream, self._rate = self._stream, None, None
        if stream is not None:
            try:
                stream.close()
            except Exception as e:
                logger.warning(f"[speaker] close: {e}")

    def keep_open(self, sample_rate: int) -> None:
        """Open the stream now so the first reply does not pay the stream start."""
        try:
            self._ensure_stream(sample_rate)
        except Exception as e:
            logger.error(f"[speaker] could not open the output stream: {e}")

    def _ensure_stream(self, sample_rate: int) -> None:
        if self._stream is not None and self._rate == sample_rate:
            return
        import sounddevice as sd

        if self._stream is not None:   # another voice, another rate: finish what is queued, then reopen
            self.wait_done(timeout=60.0)
            self.stop()
        stream = sd.OutputStream(
            samplerate=sample_rate, channels=1, dtype="int16", device=self.device_index, callback=self._callback,
        )
        stream.start()
        with self._lock:
            self._stream, self._rate = stream, sample_rate
        logger.info(
            f"[speaker] output stream open rate={sample_rate} latency_ms={stream.latency * 1000:.0f} "
            f"device={self.device_index if self.device_index is not None else 'default'}"
        )

    def _callback(self, outdata, frames, _time, _status) -> None:
        # Audio thread: no logging, no blocking. Silence fills whatever the queue cannot.
        out = outdata[:, 0]
        filled = 0
        with self._lock:
            while filled < frames:
                if self._current is None:
                    if not self._chunks:
                        break
                    self._current = self._chunks.popleft()
                    self._pos = 0
                take = min(frames - filled, len(self._current) - self._pos)
                out[filled:filled + take] = self._current[self._pos:self._pos + take]
                filled += take
                self._pos += take
                if self._pos >= len(self._current):
                    self._current = None
                    if not self._chunks:
                        self._drained_at = time.perf_counter()
            out[filled:] = 0
            if filled and self._current is None and not self._chunks:
                self._idle.set()

    def play_pcm(self, pcm_bytes: bytes, sample_rate: int) -> None:
        """Queue a PCM chunk for playback. Non-blocking once the stream is open."""
        import numpy as np

        self._ensure_stream(sample_rate)
        samples = np.frombuffer(pcm_bytes, dtype=np.int16)
        if not len(samples):
            return
        with self._lock:
            self._idle.clear()
            self._chunks.append(samples)
        logger.info(f"[speaker][timing] stage=queued audio_sec={len(samples) / max(sample_rate, 1):.2f}")

    def interrupt(self) -> None:
        """Stop what is playing NOW and drop everything queued (used when the user mutes mid-reply)."""
        with self._lock:
            dropped = len(self._chunks) + (self._current is not None)
            self._chunks.clear()
            self._current = None
            self._idle.set()
        if dropped:
            logger.info(f"[speaker] interrupted, dropped {dropped} chunk(s)")

    @property
    def is_playing(self) -> bool:
        return not self._idle.is_set()

    def wait_done(self, timeout: float = 60.0) -> bool:
        """Block until everything queued has finished playing.

        Returns False on timeout so a stuck audio device can't wedge the
        voice loop permanently.
        """
        started = time.perf_counter()
        if not self._idle.wait(timeout=timeout):
            return False
        # The callback hands samples over one buffer ahead of the speaker: wait out the stream's latency too.
        stream = self._stream
        latency = stream.latency if stream is not None else 0.0
        remaining = self._drained_at + latency - time.perf_counter()
        if remaining > 0:
            time.sleep(remaining)
        logger.info(f"[speaker][timing] stage=playback_complete waited_ms={(time.perf_counter() - started) * 1000:.0f}")
        return True
