import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../src/api/errors';
import type { PendingApproval } from '../src/api/types';
import { ChatView } from '../src/features/chat/ChatView';
import { createChatStore } from '../src/features/chat/chatStore';

const approval = (id: string, summary = 'Send an email to Priya: "Running late"'): PendingApproval => ({ requestId: id, actionName: 'send_email', ageSeconds: 2, summary });

function setup(opts: { reply?: () => AsyncGenerator<{ type: 'text'; text: string } | { type: 'done' }>; pending?: PendingApproval[] } = {}) {
  const decisions: string[] = [];
  let pending = opts.pending ?? [];
  const api = {
    chatStream: opts.reply ?? async function* () {
      yield { type: 'text', text: 'Hello! How can I help?' } as const;
      yield { type: 'done' } as const;
    },
    pendingApprovals: async () => pending,
    approve: async (id: string) => {
      decisions.push(`approve:${id}`);
      pending = pending.filter((p) => p.requestId !== id);
    },
    deny: async (id: string) => {
      decisions.push(`deny:${id}`);
      pending = pending.filter((p) => p.requestId !== id);
    },
  };
  const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
  const store = createChatStore({ getApi: () => api as never, makeSpeech: () => speech });
  return { store, decisions, speech };
}

const open = (ctx: ReturnType<typeof setup>, canApprove = true) =>
  render(<ChatView store={ctx.store} link="connected" canApprove={canApprove} onSettings={jest.fn()} />);

describe('ChatView', () => {
  it('starts with a prompt and a disabled Send button', async () => {
    await open(setup());
    expect(screen.getByText('Ask Veda anything, or tell it what to do.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).props.accessibilityState.disabled).toBe(true);
  });

  it('typing and sending shows both sides of the conversation and clears the box', async () => {
    const ctx = setup();
    await open(ctx);
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'hello there');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('Hello! How can I help?')).toBeTruthy();
    expect(screen.getByTestId('chat-input').props.value).toBe('');
    expect(screen.getAllByTestId('message-user')).toHaveLength(1);
    expect(screen.getAllByTestId('message-veda')).toHaveLength(1);
  });

  it('while a reply is being written the button is Stop, and Stop ends it', async () => {
    const ctx = setup({
      reply: async function* () {
        yield { type: 'text', text: 'Thinking' } as const;
        await new Promise(() => {});
      },
    });
    await open(ctx);
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'hi');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  it('the speaker switch turns reading aloud on and off', async () => {
    const ctx = setup();
    await open(ctx);
    const speaker = () => screen.getByRole('switch', { name: 'Read replies aloud' });
    expect(speaker().props.accessibilityState.checked).toBe(false);
    await fireEvent.press(speaker());
    expect(speaker().props.accessibilityState.checked).toBe(true);
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'say hi');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});
    expect(ctx.speech.enqueue.mock.calls.map((c) => c[0])).toEqual(['Hello!', 'How can I help?']); // one sentence at a time
  });

  it('shows a pending approval with its summary, and Approve sends it and removes the card', async () => {
    const ctx = setup({ pending: [approval('a1')] });
    await open(ctx);
    await act(async () => ctx.store.getState().refreshApprovals());
    expect(screen.getByText('Veda wants your OK')).toBeTruthy();
    expect(screen.getByText('Send an email to Priya: "Running late"')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await act(async () => {});
    expect(ctx.decisions).toEqual(['approve:a1']);
    expect(screen.queryByTestId('approval-a1')).toBeNull();
  });

  it('Deny sends the denial', async () => {
    const ctx = setup({ pending: [approval('a1')] });
    await open(ctx);
    await act(async () => ctx.store.getState().refreshApprovals());
    await fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
    await act(async () => {});
    expect(ctx.decisions).toEqual(['deny:a1']);
  });

  it('a phone that may not approve sees the request but no buttons that would only fail', async () => {
    const ctx = setup({ pending: [approval('a1')] });
    await open(ctx, false);
    await act(async () => ctx.store.getState().refreshApprovals());
    expect(screen.getByText('Approve it on the Pi.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('auto-approve on at the Pi greys out the composer and explains why', async () => {
    const ctx = setup({
      reply: async function* () {
        throw new ApiError('autoApproveOn');
      },
    });
    await open(ctx);
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'send an email');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});
    expect(screen.getByTestId('paused')).toBeTruthy();
    expect(screen.getByTestId('chat-input').props.editable).toBe(false);
    expect(screen.getByRole('button', { name: 'Send' }).props.accessibilityState.disabled).toBe(true);
  });

  it('a failure is shown in plain words under the conversation', async () => {
    const ctx = setup({
      reply: async function* () {
        throw new ApiError('unreachable');
      },
    });
    await open(ctx);
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'hi');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});
    expect(screen.getByTestId('chat-error')).toBeTruthy();
  });
});
