import { useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { chatStore } from '@/features/chat/chatRuntime';
import { ChatView } from '@/features/chat/ChatView';
import { useConnection } from '@/state/connection';
import { OfflineGate } from '@/ui/OfflineGate';
import { Screen } from '@/ui/Screen';
import type { ChipStatus } from '@/ui/StatusChip';
import { TabBar } from '@/ui/TabBar';

/** How long the app may be out of view before the microphone closes. */
const LEAVE_GRACE_MS = 1500;

export default function Chat() {
  const router = useRouter();
  const phase = useConnection((s) => s.phase);
  const link = useConnection((s) => s.link);
  const scopes = useConnection((s) => s.saved?.scopes);

  // Approvals are looked for only while this screen is in front and the app is open.
  useFocusEffect(
    useCallback(() => {
      const store = chatStore.getState();
      if (AppState.currentState === 'active') store.startPolling();
      const sub = AppState.addEventListener('change', (state) => (state === 'active' ? store.startPolling() : store.stopPolling()));
      return () => {
        sub.remove();
        store.stopPolling();
        store.stop(); // leaving stops the voice and any reply still being written
      };
    }, []),
  );

  // The microphone must not stay open when the app goes to the background for a while or this screen is left.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      if (state === 'active') return;
      timer = setTimeout(() => {
        if (AppState.currentState !== 'active') chatStore.getState().interrupt('the app went to the background');
      }, LEAVE_GRACE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) chatStore.getState().interrupt('you left the chat');
  }, [focused]);

  // Forgetting the Pi or being removed clears the conversation from the screen.
  useEffect(() => {
    if (phase !== 'paired' && phase !== 'demo') chatStore.getState().reset();
  }, [phase]);

  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';

  return (
    <OfflineGate>
      <Screen edges={['top']}>
        <ChatView
          store={chatStore}
          link={chip}
          canApprove={phase === 'demo' || scopes?.includes('approve') === true}
          onSettings={() => router.push('/settings')}
          micAvailable
        />
        <TabBar current="chat" />
      </Screen>
    </OfflineGate>
  );
}
