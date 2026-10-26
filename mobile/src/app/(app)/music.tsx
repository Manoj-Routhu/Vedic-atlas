import { useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { musicStore } from '@/features/music/musicRuntime';
import { MusicView } from '@/features/music/MusicView';
import { useConnection } from '@/state/connection';
import { OfflineGate } from '@/ui/OfflineGate';
import { Screen } from '@/ui/Screen';
import { TabBar } from '@/ui/TabBar';

/** How long the app may be out of view before the microphone closes. */
const LEAVE_GRACE_MS = 1500;

export default function Music() {
  const router = useRouter();
  const phase = useConnection((s) => s.phase);

  // Ask the Pi what the music is doing only while this screen is in front and the app is open.
  useFocusEffect(
    useCallback(() => {
      const store = musicStore.getState();
      if (AppState.currentState === 'active') store.startPolling();
      const sub = AppState.addEventListener('change', (state) => (state === 'active' ? store.startPolling() : store.stopPolling()));
      return () => {
        sub.remove();
        store.stopPolling(); // the song itself keeps playing on the Pi
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
        if (AppState.currentState !== 'active') musicStore.getState().interrupt('the app went to the background');
      }, LEAVE_GRACE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) musicStore.getState().interrupt('you left Music');
  }, [focused]);

  // Forgetting the Pi or being removed clears what was shown.
  useEffect(() => {
    if (phase !== 'paired' && phase !== 'demo') musicStore.getState().reset();
  }, [phase]);

  return (
    <OfflineGate>
      <Screen edges={['top']}>
        <MusicView store={musicStore} onSettings={() => router.push('/settings')} micAvailable />
        <TabBar current="music" />
      </Screen>
    </OfflineGate>
  );
}
