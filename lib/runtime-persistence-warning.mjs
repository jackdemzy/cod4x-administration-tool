import { createElement } from 'react';

// A storage failure is independent of whether the actual server is running.
export function RuntimePersistenceWarning({ runtime, de = true, style }) {
  if (!runtime?.persistenceError) return null;
  return createElement('div', { role: 'alert', style },
    createElement('strong', null, de ? 'Runtime-Zustand nicht gespeichert. ' : 'Runtime state not saved. '),
    de ? 'Der angezeigte Prozessstatus bleibt maßgeblich. Vor dem Schließen den Speicherfehler beheben. ' : 'The displayed process status still applies. Resolve the storage error before closing. ',
    String(runtime.persistenceError.message || runtime.persistenceError.code || 'RUNTIME_PERSISTENCE_FAILED'));
}
