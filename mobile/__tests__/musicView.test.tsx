import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import type { MusicInfo } from '../src/api/types';
import type { Recognizer, RecognizerListener } from '../src/features/look/ports';
import { clock, MusicView } from '../src/features/music/MusicView';
import { createMusicStore } from '../src/features/music/musicStore';

const info = (patch: Partial<MusicInfo> = {}): MusicInfo => ({
  available: true, reason: null, state: 'idle', title: null, elapsedS: null, limitS: 300, durationS: null, ...patch,
});
const playing = (patch: Partial<MusicInfo> = {}) => info({ state: 'playing', title: 'Tum Hi Ho - Arijit Singh', elapsedS: 170, limitS: 300, durationS: 400, ...patch });

class FakeRecognizer implements Recognizer {
  listener: RecognizerListener | null = null;
  starts = 0;
  stops = 0;
  async start(l: RecognizerListener) {
    this.starts++;
    this.listener = l;
  }
  stop() {
    this.stops++;
  }
  cancel() {}
}

function setup(state: MusicInfo | null = info()) {
  const calls: string[] = [];
  const api = {
    musicStatus: async () => state ?? info(),
    playSong: async (q: string) => {
      calls.push(`play:${q}`);
      return info({ state: 'starting', title: 'Tum Hi Ho - Arijit Singh' });
    },
    stopMusic: async () => {
      calls.push('stop');
      return info();
    },
    pauseMusic: async () => {
      calls.push('pause');
      return playing({ state: 'paused' });
    },
    resumeMusic: async () => {
      calls.push('resume');
      return playing();
    },
  };
  const recognizer = new FakeRecognizer();
  const store = createMusicStore({ getApi: () => api as unknown as PiApi, recognizer });
  if (state) store.setState({ info: state, loading: false, syncedAt: Date.now() });
  return { store, calls, recognizer };
}

const open = (ctx: ReturnType<typeof setup>, micAvailable = true) => render(<MusicView store={ctx.store} onSettings={jest.fn()} micAvailable={micAvailable} />);

describe('the time on screen', () => {
  it.each([[0, '0:00'], [9, '0:09'], [170, '2:50'], [300, '5:00'], [262.9, '4:22'], [-3, '0:00']])('%s seconds reads %s', (s, text) => expect(clock(s)).toBe(text));
});

describe('nothing playing', () => {
  it('says the sound comes from the Pi, offers a way to name a song, and explains the rules', async () => {
    await open(setup());
    expect(screen.getByLabelText(/Plays on your Pi's speaker. This phone is the remote/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/microphone is closed while a song plays/)).toBeTruthy();
    expect(screen.getByText('A song stops by itself after 5 minutes.')).toBeTruthy();
    expect(screen.getByText(/Your voice never does/)).toBeTruthy();
  });

  it('typing a name and pressing Play sends those words and clears the box', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.changeText(screen.getByTestId('song-input'), 'tum hi ho');
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {});
    expect(ctx.calls).toEqual(['play:tum hi ho']);
    expect(ctx.store.getState().info?.state).toBe('starting');
  });

  it('a song that cannot be found shows the reason and can be dismissed', async () => {
    const ctx = setup();
    ctx.store.setState({ error: new ApiError('songNotFound') });
    await open(ctx);
    expect(screen.getByTestId('music-error')).toBeTruthy();
    expect(screen.getByText(/couldn't find that song/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('music-error')).toBeNull();
  });

  it('the microphone: tap to say the name, and it is not offered where the phone cannot listen', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await act(async () => {});
    expect(ctx.recognizer.starts).toBe(1);
    expect(screen.getByRole('button', { name: 'Stop listening' })).toBeTruthy();
    await act(async () => ctx.recognizer.listener?.onPartial('tum hi'));
    expect(screen.getByTestId('song-input').props.value).toBe('tum hi');
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    expect(ctx.recognizer.stops).toBe(1);
  });

  it('no microphone button without a recognizer', async () => {
    await open(setup(), false);
    expect(screen.queryByTestId('mic')).toBeNull();
  });

  it('before the first answer it says it is checking', async () => {
    await open(setup(null));
    expect(screen.getByText('Checking your Pi…')).toBeTruthy();
  });
});

describe('finding and starting', () => {
  it('while the Pi searches, the words are shown with a Cancel', async () => {
    const ctx = setup();
    ctx.store.setState({ asking: 'tum hi ho' });
    await open(ctx);
    expect(screen.getByText('Finding the song…')).toBeTruthy();
    expect(screen.getByText('tum hi ho')).toBeTruthy();
    expect(screen.getByText(/as soon as Veda has finished talking/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(ctx.store.getState().asking).toBeNull();
  });

  it('once picked but not yet started, it names the song', async () => {
    const ctx = setup(info({ state: 'starting', title: 'Tum Hi Ho - Arijit Singh' }));
    await open(ctx);
    expect(screen.getByText('Starting the song…')).toBeTruthy();
    expect(screen.getByText('Tum Hi Ho - Arijit Singh')).toBeTruthy();
  });
});

describe('playing', () => {
  it('names the song, says it plays on the Pi, and shows how long until it stops', async () => {
    await open(setup(playing({ durationS: null })));
    expect(screen.getByText('Tum Hi Ho - Arijit Singh')).toBeTruthy();
    expect(screen.getByLabelText('Playing on your Pi')).toBeTruthy();
    expect(screen.getByText('Stops by itself at 5:00')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.props.accessibilityValue).toMatchObject({ min: 0, max: 300 });
    expect(screen.getByText(/microphone is closed while the song plays/)).toBeTruthy();
  });

  it('a song shorter than the limit says when it ends instead', async () => {
    await open(setup(playing({ durationS: 262 })));
    expect(screen.getByText('Ends at 4:22')).toBeTruthy();
  });

  it('Pause pauses, and then the same button resumes', async () => {
    const ctx = setup(playing());
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {});
    expect(ctx.calls).toEqual(['pause']);
    expect(screen.getByLabelText('Paused')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume' }));
    await act(async () => {});
    expect(ctx.calls).toEqual(['pause', 'resume']);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('Stop stops, and the screen goes back to choosing a song', async () => {
    const ctx = setup(playing());
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Stop the music' }));
    await act(async () => {});
    expect(ctx.calls).toEqual(['stop']);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('"New song" opens the song box right there, and a new name replaces the song', async () => {
    const ctx = setup(playing());
    await open(ctx);
    expect(screen.queryByTestId('song-input')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Play a different song' }));
    await fireEvent.changeText(screen.getByTestId('song-input'), 'kun faya kun');
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {});
    expect(ctx.calls).toEqual(['play:kun faya kun']);
  });
});

describe('music that is not available on the Pi', () => {
  it.each([
    ['tools_missing', "Music isn't set up on this Pi", 'sudo apt install mpv'],
    ['off', 'Music is switched off on this Pi', 'config/music.yaml'],
    ['offline', 'This Pi is in offline mode', 'config/privacy.yaml'],
  ] as const)('%s: says what is wrong and what to do', async (reason, title, step) => {
    const ctx = setup(info({ available: false, reason }));
    await open(ctx);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(new RegExp(step.replace(/\./g, '\\.')))).toBeTruthy();
    expect(screen.queryByTestId('song-input')).toBeNull();          // nothing to play with
    expect(screen.queryByLabelText(/Plays on your Pi's speaker/)).toBeNull();
  });

  it('Check again asks the Pi again', async () => {
    const ctx = setup(info({ available: false, reason: 'tools_missing' }));
    ctx.store.setState({ refresh: jest.fn(async () => undefined) });
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(ctx.store.getState().refresh).toHaveBeenCalled();
  });
});
