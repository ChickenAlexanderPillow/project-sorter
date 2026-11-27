type CloseEvent = { preventDefault: () => void };

/** Tauri destroys the window after this resolves unless the event is prevented. */
export function createCloseRequestHandler({ shouldWarn, confirmClose, onError }: {
  shouldWarn: () => boolean; confirmClose: () => Promise<boolean>; onError: (error: unknown) => void;
}) {
  let confirming = false;
  return async (event: CloseEvent) => {
    if (confirming) { event.preventDefault(); return; }
    if (!shouldWarn()) return;
    confirming = true;
    try {
      if (!await confirmClose()) event.preventDefault();
    } catch (error) {
      event.preventDefault();
      onError(error);
    } finally { confirming = false; }
  };
}
