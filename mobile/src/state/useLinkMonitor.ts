import { useEffect } from 'react';

import { connectionStore, useConnection } from './connection';
import { startLinkMonitor } from './linkMonitor';

/** Keeps `connection.link` current while a real Pi is paired and the app is in front. Demo mode has nothing to check. */
export function useLinkMonitor() {
  const phase = useConnection((s) => s.phase);
  useEffect(() => {
    if (phase !== 'paired') return;
    return startLinkMonitor({
      getApi: () => connectionStore.getState().api(),
      onResult: ({ result, error }) => {
        const s = connectionStore.getState();
        if (result === 'connected') s.setLink('connected');
        else if (result === 'unreachable') s.setLink('unreachable');
        else s.handleError(error); // removed: the store forgets the pairing and the router returns to the pairing screens
      },
    });
  }, [phase]);
}
