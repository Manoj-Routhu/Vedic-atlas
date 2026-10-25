import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { chatStore } from '@/features/chat/chatRuntime';
import { ChatView } from '@/features/chat/ChatView';
import { useConnection } from '@/state/connection';
import { Screen } from '@/ui/Screen';
import type { ChipStatus } from '@/ui/StatusChip';

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

  // Forgetting the Pi or being removed clears the conversation from the screen.
  useEffect(() => {
    if (phase !== 'paired' && phase !== 'demo') chatStore.getState().reset();
  }, [phase]);

  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';

  return (
    <Screen>
      <ChatView
        store={chatStore}
        link={chip}
        canApprove={phase === 'demo' || scopes?.includes('approve') === true}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        onSettings={() => router.push('/settings')}
      />
    </Screen>
  );
}
