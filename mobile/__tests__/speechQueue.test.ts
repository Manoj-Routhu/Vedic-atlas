import { SpeechQueue, type SpeakCallbacks, type Speaker } from '../src/speech/speechQueue';

/** A speaker that records what it was asked and lets the test decide when each utterance starts, ends or fails. */
class FakeSpeaker implements Speaker {
  spoken: { text: string; cb: SpeakCallbacks }[] = [];
  stops = 0;
  speak(text: string, cb: SpeakCallbacks) {
    this.spoken.push({ text, cb });
  }
  stop() {
    this.stops++;
  }
}

function setup() {
  const speaker = new FakeSpeaker();
  const events: string[] = [];
  const queue = new SpeechQueue(speaker, {
    onActive: (t) => events.push(`active:${t}`),
    onIdle: () => events.push('idle'),
    onError: () => events.push('error'),
  });
  return { speaker, queue, events };
}

describe('SpeechQueue', () => {
  it('hands each sentence to the speaker straight away (the speaker queues them, gaplessly)', () => {
    const { speaker, queue } = setup();
    queue.enqueue('First.', 0);
    queue.enqueue('Second.', 1);
    expect(speaker.spoken.map((s) => s.text)).toEqual(['First.', 'Second.']);
    expect(queue.isSpeaking).toBe(true);
  });

  it('reports which sentence is being spoken, then idle when all are done', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('First.', 0);
    queue.enqueue('Second.', 1);
    speaker.spoken[0]?.cb.onStart();
    speaker.spoken[0]?.cb.onDone();
    speaker.spoken[1]?.cb.onStart();
    speaker.spoken[1]?.cb.onDone();
    expect(events).toEqual(['active:0', 'active:null', 'active:1', 'active:null', 'idle']);
    expect(queue.isSpeaking).toBe(false);
  });

  it('ignores empty or blank text', () => {
    const { speaker, queue } = setup();
    queue.enqueue('', 0);
    queue.enqueue('   ', 1);
    expect(speaker.spoken).toHaveLength(0);
    expect(queue.isSpeaking).toBe(false);
  });

  it('trims what it speaks', () => {
    const { speaker, queue } = setup();
    queue.enqueue('  Hello there.  ', 0);
    expect(speaker.spoken[0]?.text).toBe('Hello there.');
  });

  it('stop silences the speaker, clears everything, and tells the screen nothing is active', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('First.', 0);
    queue.enqueue('Second.', 1);
    speaker.spoken[0]?.cb.onStart();
    queue.stop();
    expect(speaker.stops).toBe(1);
    expect(queue.isSpeaking).toBe(false);
    expect(events).toEqual(['active:0', 'active:null']);
  });

  it('ignores late callbacks from an utterance that was stopped', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('Old sentence.', 0);
    queue.stop();
    queue.enqueue('New sentence.', 0);
    speaker.spoken[0]?.cb.onStart(); // the stopped one reports in late
    speaker.spoken[0]?.cb.onDone();
    expect(queue.isSpeaking).toBe(true); // the new one is still pending
    expect(events).not.toContain('idle');
    speaker.spoken[1]?.cb.onStart();
    speaker.spoken[1]?.cb.onDone();
    expect(events).toEqual(['active:0', 'active:null', 'idle']);
  });

  it('stop when nothing is happening does nothing', () => {
    const { speaker, queue } = setup();
    queue.stop();
    expect(speaker.stops).toBe(0);
  });

  it('a failed utterance is reported, does not block the rest, and does not leave it "speaking"', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('First.', 0);
    queue.enqueue('Second.', 1);
    speaker.spoken[0]?.cb.onError(new Error('no engine'));
    speaker.spoken[1]?.cb.onStart();
    speaker.spoken[1]?.cb.onDone();
    expect(events).toEqual(['error', 'active:1', 'active:null', 'idle']);
    expect(queue.isSpeaking).toBe(false);
  });

  it('counts an utterance only once even if both done and error arrive', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('Only.', 0);
    speaker.spoken[0]?.cb.onDone();
    speaker.spoken[0]?.cb.onError(new Error('late'));
    expect(events.filter((e) => e === 'idle')).toHaveLength(1);
  });

  it('can speak again after finishing', () => {
    const { speaker, queue, events } = setup();
    queue.enqueue('One.', 0);
    speaker.spoken[0]?.cb.onDone();
    queue.enqueue('Two.', 0);
    speaker.spoken[1]?.cb.onDone();
    expect(events.filter((e) => e === 'idle')).toHaveLength(2);
  });
});
