import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { controlStore } from '@/features/control/controlRuntime';
import { ControlView } from '@/features/control/ControlView';
import { useConnection } from '@/state/connection';
import { Screen } from '@/ui/Screen';
import type { ChipStatus } from '@/ui/StatusChip';

const ALL_SCOPES = ['chat', 'control', 'vision', 'approve'];

export default function Control() {
  const router = useRouter();
  const phase = useConnection((s) => s.phase);
  const link = useConnection((s) => s.link);
  const saved = useConnection((s) => s.saved);

  // Refresh only while this screen is in front and the app is open.
  useFocusEffect(
    useCallback(() => {
      const store = controlStore.getState();
      if (AppState.currentState === 'active') store.startPolling();
      const sub = AppState.addEventListener('change', (state) => (state === 'active' ? store.startPolling() : store.stopPolling()));
      return () => {
        sub.remove();
        store.stopPolling();
      };
    }, []),
  );

  // Forgetting the Pi or being removed clears what was shown.
  useEffect(() => {
    if (phase !== 'paired' && phase !== 'demo') controlStore.getState().reset();
  }, [phase]);

  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';

  return (
    <Screen>
      <ControlView
        store={controlStore}
        scopes={phase === 'demo' ? ALL_SCOPES : (saved?.scopes ?? [])}
        link={chip}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        onSettings={() => router.push('/settings')}
      />
    </Screen>
  );
}
