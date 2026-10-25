import type { ReactNode } from 'react';

import { useConnection } from '../state/connection';
import { OfflineView } from './OfflineView';

/** The main screens while the Pi answers; the "Can't reach your Pi" page while it does not. Demo mode is never offline. */
export function OfflineGate({ children }: { children: ReactNode }) {
  const offline = useConnection((s) => s.phase === 'paired' && s.link === 'unreachable');
  return offline ? <OfflineView /> : <>{children}</>;
}
