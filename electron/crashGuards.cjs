'use strict';

// Garde-fous du process principal, isolés de main.cjs pour être TESTÉS PAR
// COMPORTEMENT (BUG-008). Une exception non capturée ne doit jamais fermer
// l'application, et l'échec du journal lui-même ne doit rien propager.

function installProcessGuards({ processRef = process, journal } = {}) {
  const write = typeof journal === 'function' ? journal : () => {};

  const onException = (error) => {
    try { write('fatal', 'uncaughtException:', error); } catch {}
  };
  const onRejection = (reason) => {
    try { write('error', 'unhandledRejection:', reason); } catch {}
  };

  processRef.on('uncaughtException', onException);
  processRef.on('unhandledRejection', onRejection);

  return () => {
    processRef.removeListener('uncaughtException', onException);
    processRef.removeListener('unhandledRejection', onRejection);
  };
}

module.exports = { installProcessGuards };
