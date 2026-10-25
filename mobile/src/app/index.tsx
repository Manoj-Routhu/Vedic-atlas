import { Redirect } from 'expo-router';

import { useConnection } from '@/state/connection';

/**
 * `/` is where the app opens (and what `veda://` means). It has no screen of its own: it sends the phone to the pairing
 * screens or into the app depending on whether it is paired, and does it again whenever that changes.
 */
export default function Index() {
  const phase = useConnection((s) => s.phase);
  return <Redirect href={phase === 'paired' || phase === 'demo' ? '/home' : '/welcome'} />;
}
