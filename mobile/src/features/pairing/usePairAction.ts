import { useCallback, useEffect, useRef, useState } from 'react';

import { apiErrorFromThrown, type ApiError } from '../../api/errors';
import { connectionStore } from '../../state/connection';
import type { PairInput } from './validate';

/**
 * Pair with the Pi and report progress. On success the connection store flips to "paired" and the router's guard moves
 * the user into the app by itself, so this hook only has to show "pairing..." and any error.
 */
export function usePairAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = useCallback(async (input: PairInput): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await connectionStore.getState().pair(input);
      return true;
    } catch (e) {
      if (alive.current) setError(apiErrorFromThrown(e));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
