import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { HOLD_MS, LookView } from '../src/features/look/LookView';
import { createLookStore, MIC_MESSAGES } from '../src/features/look/lookStore';
import type { MicProblem, Photo, Recognizer, RecognizerListener, SpeechPackResult } from '../src/features/look/ports';

/** A recognizer the test drives by hand. */
class FakeRecognizer implements Recognizer {
  listener: RecognizerListener | null = null;
  starts = 0;
  stops = 0;
  cancels = 0;
  async start(l: RecognizerListener) {
    this.starts++;
    this.listener = l;
  }
  stop() {
    this.stops++;
  }
  cancel() {
    this.cancels++;
  }
  downloads = 0;
  downloadResult: SpeechPackResult | Error = 'ready';
  async downloadSpeechPack() {
    this.downloads++;
    if (this.downloadResult instanceof Error) throw this.downloadResult;
    return this.downloadResult;
  }
}

function setup() {
  const asked: { question: string | null; style: string }[] = [];
  const api = {
    putImage: async () => ({ imageId: 'i1', width: 1, height: 1 }),
    async *askVision(req: { question?: string | null; style?: string }) {
      asked.push({ question: req.question ?? null, style: req.style ?? 'brief' });
      yield { type: 'token', text: 'The label says best before 2027.' };
      yield { type: 'done' };
    },
  };
  const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
  const recognizer = new FakeRecognizer();
  const photo: Photo = { uri: 'file:///p.jpg', width: 8, height: 6, bytes: new Uint8Array(1), discard: jest.fn() };
  const store = createLookStore({
    getApi: () => api as never,
    takePhoto: async () => photo,
    makeSpeech: () => speech,
    recognizer,
    feedback: { capture: jest.fn(), success: jest.fn(), failure: jest.fn() },
  });
  return { store, speech, recognizer, asked };
}

const withPhoto = async () => {
  const ctx = setup();
  await ctx.store.getState().capture();
  return ctx;
};

describe('asking by voice', () => {
  it('holding the button opens the microphone, shows the words as they come, and silences the voice first', async () => {
    const { store, speech, recognizer } = await withPhoto();
    await store.getState().startListening();
    expect(speech.stop).toHaveBeenCalled();
    expect(store.getState().listening).toBe(true);
    recognizer.listener?.onPartial('what does the');
    expect(store.getState().heard).toBe('what does the');
  });

  it('when the app closes the open microphone it says why, so it is never a silent flicker', async () => {
    const { store } = await withPhoto();
    await store.getState().startListening();
    store.getState().interrupt('the app went to the background');
    expect(store.getState().listening).toBe(false);
    expect(store.getState().micMessage).toBe('The microphone was closed: the app went to the background.');
  });

  it('interrupting when the microphone is not open adds no message', async () => {
    const { store } = await withPhoto();
    store.getState().interrupt('you left the Look screen');
    expect(store.getState().micMessage).toBeNull();
  });

  it('letting go asks about the same photo with the words heard', async () => {
    const { store, recognizer, asked } = await withPhoto();
    await store.getState().startListening();
    store.getState().finishListening();
    expect(recognizer.stops).toBe(1);
    recognizer.listener?.onFinal('What does the label say?');
    await act(async () => {});
    expect(asked[1]).toEqual({ question: 'What does the label say?', style: 'brief' });
    expect(store.getState().question).toBe('What does the label say?');
    expect(store.getState().listening).toBe(false);
    expect(store.getState().phase).toBe('answered');
  });

  it('hearing nothing says so and asks nothing', async () => {
    const { store, recognizer, asked } = await withPhoto();
    await store.getState().startListening();
    recognizer.listener?.onFinal('   ');
    expect(store.getState().micMessage).toBe(MIC_MESSAGES.nothing);
    expect(asked).toHaveLength(1);
    expect(store.getState().listening).toBe(false);
  });

  it.each<MicProblem>(['denied', 'unavailable', 'nothing'])('a %s problem is shown in plain words and closes the microphone', async (problem) => {
    const { store, recognizer, asked } = await withPhoto();
    await store.getState().startListening();
    recognizer.listener?.onError(problem);
    expect(store.getState().micMessage).toBe(MIC_MESSAGES[problem]);
    expect(store.getState().listening).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("an unavailable recogniser includes the speech service's own reason, so a failure can be diagnosed", async () => {
    const { store, recognizer } = await withPhoto();
    await store.getState().startListening();
    recognizer.listener?.onError('unavailable', 'language-not-supported: no English model');
    expect(store.getState().micMessage).toBe(`${MIC_MESSAGES.unavailable} (language-not-supported: no English model)`);
  });

  it('a new press clears the old message', async () => {
    const { store, recognizer } = await withPhoto();
    await store.getState().startListening();
    recognizer.listener?.onError('nothing');
    await store.getState().startListening();
    expect(store.getState().micMessage).toBeNull();
  });

  it('cannot listen without a photo, or while an answer is being made, or twice at once', async () => {
    const empty = setup();
    await empty.store.getState().startListening();
    expect(empty.recognizer.starts).toBe(0);

    const { store, recognizer } = await withPhoto();
    await store.getState().startListening();
    await store.getState().startListening();
    expect(recognizer.starts).toBe(1);
  });

  it('words that arrive after the microphone was closed are ignored', async () => {
    const { store, recognizer, asked } = await withPhoto();
    await store.getState().startListening();
    const old = recognizer.listener;
    store.getState().cancelListening();
    expect(recognizer.cancels).toBe(1);
    old?.onFinal('Late words');
    await act(async () => {});
    expect(asked).toHaveLength(1);
    expect(store.getState().listening).toBe(false);
  });

  it('retaking, taking a new photo, or leaving the app closes the microphone', async () => {
    for (const action of ['retake', 'interrupt'] as const) {
      const { store, recognizer } = await withPhoto();
      await store.getState().startListening();
      store.getState()[action]();
      expect(recognizer.cancels).toBe(1);
      expect(store.getState().listening).toBe(false);
    }
  });

  it('a phone with no recognizer simply never listens', async () => {
    const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
    const store = createLookStore({
      getApi: () => null,
      takePhoto: async () => ({ uri: 'x', width: 1, height: 1, bytes: new Uint8Array(1), discard: () => undefined }),
      makeSpeech: () => speech,
      feedback: { capture: jest.fn(), success: jest.fn(), failure: jest.fn() },
    });
    await store.getState().startListening();
    expect(store.getState().listening).toBe(false);
  });
});

describe('hearing one sentence again', () => {
  it('speaks just that sentence, with its position', async () => {
    const { store, speech } = await withPhoto();
    speech.enqueue.mockClear();
    store.getState().hearSentence(0);
    expect(speech.enqueue).toHaveBeenCalledWith('The label says best before 2027.', 0);
    store.getState().hearSentence(5); // no such sentence
    expect(speech.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('the Look screen with the microphone', () => {
  const open = (ctx: ReturnType<typeof setup>, micAvailable = true) =>
    render(
      <LookView store={ctx.store} preview={<Text>live camera</Text>} canShoot link="connected" micAvailable={micAvailable} onBack={jest.fn()} onSettings={jest.fn()} onCopy={jest.fn()} />,
    );

  it('offers the microphone only once there is a photo', async () => {
    const ctx = setup();
    await open(ctx);
    expect(screen.queryByTestId('mic')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Ask about this' })).toBeTruthy();
  });

  it('does not offer it when the phone cannot recognise speech', async () => {
    const ctx = setup();
    await open(ctx, false);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    expect(screen.queryByTestId('mic')).toBeNull();
  });

  it('a quick tap starts listening and keeps listening; the words appear; a second tap stops and asks', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await fireEvent(screen.getByTestId('mic'), 'pressOut'); // a tap: let go at once
    await act(async () => {});
    expect(ctx.recognizer.stops).toBe(0); // still listening
    expect(screen.getByTestId('question')).toHaveTextContent('Listening…');
    await act(async () => ctx.recognizer.listener?.onPartial('is it ripe'));
    expect(screen.getByTestId('question')).toHaveTextContent('is it ripe');
    await fireEvent(screen.getByTestId('mic'), 'pressIn'); // second tap
    expect(ctx.recognizer.stops).toBe(1);
    await act(async () => ctx.recognizer.listener?.onFinal('Is it ripe?'));
    await act(async () => {});
    expect(screen.getByTestId('question')).toHaveTextContent('Is it ripe?');
    expect(ctx.asked[1]?.question).toBe('Is it ripe?');
  });

  it('holding still works: letting go after a hold stops listening and asks', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await act(async () => {});
    now.mockReturnValue(1_000 + HOLD_MS + 50);
    await fireEvent(screen.getByTestId('mic'), 'pressOut');
    expect(ctx.recognizer.stops).toBe(1);
    now.mockRestore();
  });

  it('shows why the microphone did not work', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await act(async () => ctx.recognizer.listener?.onError('denied'));
    expect(screen.getByTestId('mic-message')).toHaveTextContent(new RegExp(MIC_MESSAGES.denied));
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('mic-message')).toBeNull();
  });

  it('a missing offline speech pack offers a download button that asks the phone once', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await act(async () => ctx.recognizer.listener?.onError('speechPackMissing', 'error language-not-supported 80ms'));
    expect(screen.getByTestId('mic-message')).toHaveTextContent(/hasn't downloaded its offline English speech/);
    await fireEvent.press(screen.getByRole('button', { name: 'Download offline speech' }));
    await act(async () => {});
    expect(ctx.recognizer.downloads).toBe(1);
    expect(screen.getByTestId('mic-message')).toHaveTextContent(/Downloaded/);
    expect(screen.queryByRole('button', { name: 'Download offline speech' })).toBeNull();
  });

  it.each<[SpeechPackResult, RegExp]>([
    ['scheduled', /finish on Wi-Fi/],
    ['dialog', /download prompt/],
  ])('a %s download tells what to do next', async (result, words) => {
    const { store, recognizer } = await withPhoto();
    recognizer.downloadResult = result;
    await store.getState().downloadSpeechPack();
    expect(store.getState().micMessage).toMatch(words);
  });

  it('a download the phone refuses explains the manual way and keeps the button', async () => {
    const { store, recognizer } = await withPhoto();
    recognizer.downloadResult = new Error('not supported');
    await store.getState().downloadSpeechPack();
    expect(store.getState().micMessage).toMatch(/Offline speech recognition/);
    expect(store.getState().micOffer).toBe(true);
  });

  it('a question can be typed instead', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    await fireEvent.press(screen.getByRole('button', { name: 'Type a question' }));
    expect(screen.getByRole('button', { name: 'Ask' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('typed-question'), '  What colour is it?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    await act(async () => {});
    expect(ctx.asked[1]?.question).toBe('What colour is it?');
    expect(screen.queryByTestId('typed-question')).toBeNull();
  });

  it('tapping a sentence speaks it again', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    ctx.speech.enqueue.mockClear();
    await fireEvent.press(screen.getByText(/The label says best before 2027\./));
    expect(ctx.speech.enqueue).toHaveBeenCalledWith('The label says best before 2027.', 0);
  });
});
