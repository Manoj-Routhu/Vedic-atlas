import { Redirect } from 'expo-router';

import { useConnection } from '@/state/connection';

/**
 * `/` is where the app opens (and what `veda://` means). It has no screen of its own: it sends the phone to the pairing
 * screens or into the app depending on whether it is paired, and does it again whenever that changes. Inside the app it
 * opens the first of Look, Veda and Control that this phone was allowed.
 */
export default function Index() {
  const phase = useConnection((s) => s.phase);
  const scopes = useConnection((s) => s.saved?.scopes);
  if (phase === 'demo') return <Redirect href="/look" />;
  if (phase !== 'paired') return <Redirect href="/welcome" />;
  const first = scopes?.includes('vision') ? '/look' : scopes?.includes('chat') ? '/chat' : scopes?.includes('control') ? '/control' : '/settings';
  return <Redirect href={first} />;
}
