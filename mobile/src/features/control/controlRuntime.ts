import { connectionStore } from '../../state/connection';
import { createControlStore } from './controlStore';

const ALL_SCOPES = ['chat', 'control', 'vision', 'approve'];

/** The app's one Control session. Demo mode shows every card, with example data. */
export const controlStore = createControlStore({
  getApi: () => connectionStore.getState().api(),
  scopes: () => {
    const { phase, saved } = connectionStore.getState();
    return phase === 'demo' ? ALL_SCOPES : (saved?.scopes ?? []);
  },
  onApiError: (e) => connectionStore.getState().handleError(e),
});
