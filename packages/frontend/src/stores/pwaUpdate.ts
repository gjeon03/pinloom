// Auto-apply new builds without the user having to clear the service worker.
//
// vite-plugin-pwa (registerType 'autoUpdate' + skipWaiting + clientsClaim)
// already registers the SW and makes a freshly-built one activate immediately.
// The missing piece was the OPEN tab: it stays on the cached old shell until a
// manual reload/unregister. So when a new SW takes control, we reload once.
//
// The first-ever visit starts uncontrolled and the SW's initial claim also
// fires `controllerchange` — we skip exactly that one so a brand-new visit
// doesn't reload pointlessly. Every later control change is a real update.
//
// The periodic update() makes a tab left open across a rebuild notice the new
// build within a minute instead of only on the next navigation. It only
// re-checks the tiny static shell — `/api` + `/ws` stay on the network.

if ('serviceWorker' in navigator) {
  let reloading = false;
  // Uncontrolled at startup → the next controllerchange is the initial install
  // claim, not an update; skip just that one.
  let skipInitialClaim = !navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (skipInitialClaim) {
      skipInitialClaim = false;
      return;
    }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.ready
    .then((registration) => {
      setInterval(() => {
        void registration.update();
      }, 60_000);
    })
    .catch(() => {
      // No active service worker (e.g. dev server) — nothing to poll.
    });
}
