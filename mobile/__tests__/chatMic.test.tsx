import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ChatView, HOLD_MS } from '../src/features/chat/ChatView';
import { createChatStore } from '../src/features/chat/chatStore';
import { MIC_MESSAGES } from '../src/features/look/lookStore';
import type { Recognizer, RecognizerListener, SpeechPackResult } from '../src/features/look/ports';

/** A recognizer the test drives by hand. */
class FakeRecognizer implements Recognizer {
  listener: RecognizerListener | null = null;
  starts = 0;
  stops = 0;
  cancels = 0;
  downloads = 0;
  downloadResult: SpeechPackResult | Error = 'ready';
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
  async downloadSpeechPack() {
    this.downloads++;
    if (this.downloadResult instanceof Error) throw this.downloadResult;
    return this.downloadResult;
  }
}

function setup() {
  const sent: string[] = [];
  const api = {
    chatStream: async function* (message: string) {
      sent.push(message);
      yield { type: 'text', text: 'Sure.' } as const;
      yield { type: 'done' } as const;
    },
    pendingApprovals: async () => [],
  };
  const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
  const recognizer = new FakeRecognizer();
  const store = createChatStore({ getApi: () => api as never, makeSpeech: () => speech, recognizer });
  return { store, speech, recognizer, sent };
}

describe('speaking to Veda in chat', () => {
  it('opens the microphone, shows the words as they come, and silences the voice first', async () => {
    const { store, speech, recognizer } = setup();
    store.getState().setSpeak(true);
    await store.getState().send('hi'); // the voice exists once it has been used
    speech.stop.mockClear();
    await store.getState().startListening();
    expect(speech.stop).toHaveBeenCalled();
    expect(store.getState().listening).toBe(true);
    recognizer.listener?.onPartial('what is on');
    expect(store.getState().heard).toBe('what is on');
  });

  it('what was heard is sent as the message when the microphone closes', async () => {
    const { store, recognizer, sent } = setup();
    await store.getState().startListening();
    recognizer.listener?.onFinal('what is on my list');
    await act(async () => {});
    expect(store.getState().listening).toBe(false);
    expect(sent).toEqual(['what is on my list']);
    expect(store.getState().messages.map((m) => m.text)).toEqual(['what is on my list', 'Sure.']);
  });

  it('hearing nothing sends nothing and says so', async () => {
    const { store, recognizer, sent } = setup();
    await store.getState().startListening();
    recognizer.listener?.onFinal('  ');
    await act(async () => {});
    expect(sent).toEqual([]);
    expect(store.getState().micMessage).toBe(MIC_MESSAGES.nothing);
  });

  it('a missing offline speech pack offers the download, and the download is explained', async () => {
    const { store, recognizer } = setup();
    await store.getState().startListening();
    recognizer.listener?.onError('speechPackMissing', 'language not supported');
    expect(store.getState().micMessage).toBe(MIC_MESSAGES.speechPackMissing);
    expect(store.getState().micOffer).toBe(true);
    await store.getState().downloadSpeechPack();
    expect(recognizer.downloads).toBe(1);
    expect(store.getState().micOffer).toBe(false);
    expect(store.getState().micMessage).toMatch(/^Downloaded/);
  });

  it('a failed download offers it again with the manual way', async () => {
    const { store, recognizer } = setup();
    recognizer.downloadResult = new Error('no');
    await store.getState().downloadSpeechPack();
    expect(store.getState().micOffer).toBe(true);
    expect(store.getState().micMessage).toMatch(/Google app/);
  });

  it('leaving while listening closes the microphone and says why; words that arrive late are ignored', async () => {
    const { store, recognizer, sent } = setup();
    await store.getState().startListening();
    const late = recognizer.listener;
    store.getState().interrupt('you left the chat');
    expect(recognizer.cancels).toBe(1);
    expect(store.getState().listening).toBe(false);
    expect(store.getState().micMessage).toBe('The microphone was closed: you left the chat.');
    late?.onFinal('too late');
    await act(async () => {});
    expect(sent).toEqual([]);
  });

  it('leaving without the microphone open says nothing', () => {
    const { store } = setup();
    store.getState().interrupt('you left the chat');
    expect(store.getState().micMessage).toBeNull();
  });

  it('does not open while a reply is being written, and without a recognizer there is nothing to open', async () => {
    const { store, recognizer } = setup();
    store.setState({ busy: true });
    await store.getState().startListening();
    expect(recognizer.starts).toBe(0);
    const bare = createChatStore({ getApi: () => null, makeSpeech: () => ({ enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false }) });
    await bare.getState().startListening();
    expect(bare.getState().listening).toBe(false);
  });
});

describe('ChatView microphone', () => {
  const open = (ctx: ReturnType<typeof setup>, micAvailable = true) =>
    render(<ChatView store={ctx.store} link="connected" canApprove onSettings={jest.fn()} micAvailable={micAvailable} />);

  it('is not shown where the phone cannot recognise speech', async () => {
    await open(setup(), false);
    expect(screen.queryByTestId('mic')).toBeNull();
  });

  it('a tap opens it, shows the words in the box, and a second tap sends', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    await fireEvent(screen.getByTestId('mic'), 'pressOut');
    await act(async () => {});
    expect(ctx.store.getState().listening).toBe(true);
    expect(screen.getByRole('button', { name: 'Stop listening' })).toBeTruthy();
    await act(async () => ctx.recognizer.listener?.onPartial('hello veda'));
    expect(screen.getByTestId('chat-input').props.value).toBe('hello veda');
    await fireEvent(screen.getByTestId('mic'), 'pressIn');
    expect(ctx.recognizer.stops).toBe(1);
  });

  it('holding and letting go sends', async () => {
    const ctx = setup();
    await open(ctx);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      await fireEvent(screen.getByTestId('mic'), 'pressIn');
      await act(async () => {});
      now.mockReturnValue(1_000 + HOLD_MS + 50);
      await fireEvent(screen.getByTestId('mic'), 'pressOut');
      expect(ctx.recognizer.stops).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('shows the reason when the microphone cannot be used, and the download button when it can be fixed', async () => {
    const ctx = setup();
    await open(ctx);
    await act(async () => ctx.store.getState().startListening());
    await act(async () => ctx.recognizer.listener?.onError('speechPackMissing'));
    expect(screen.getByTestId('mic-message')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Download offline speech' }));
    await act(async () => {});
    expect(ctx.recognizer.downloads).toBe(1);
  });
});
