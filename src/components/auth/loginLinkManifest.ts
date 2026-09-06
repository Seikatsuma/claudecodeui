const MANIFEST_LINK_ID = 'login-link-manifest';

/**
 * Points this page's PWA manifest at the visitor's own login link, so an
 * "Add to Home Screen" icon opens the app already signed in.
 *
 * The build strips the static manifest link on the shared instance because its
 * `start_url` is a fixed "/", and iOS launches an installed icon at
 * `start_url` from then on - dropping the token the icon was created from and
 * landing on a logged-out "/". A standalone web app also gets its own storage,
 * separate from the browser's, so the session saved in Safari is not there to
 * fall back on: the icon showed the invitation screen on every single launch.
 *
 * Injecting the manifest here instead - once the token is known, and naming
 * that token in `start_url` (see the /manifest.json route on the server) -
 * gives the icon the right address and the app its standalone chrome back.
 * Only ever reached with a real login token in hand, which is a shared-instance
 * concept: the single-account deployments have no such token and keep the
 * static manifest they ship with.
 */
export function installLoginLinkManifest(loginToken: string): void {
  if (typeof document === 'undefined' || !loginToken) {
    return;
  }

  const href = `/manifest.json?enter=${encodeURIComponent(loginToken)}`;
  const existing = document.getElementById(MANIFEST_LINK_ID) as HTMLLinkElement | null;
  if (existing) {
    if (existing.getAttribute('href') !== href) {
      existing.setAttribute('href', href);
    }
    return;
  }

  const link = document.createElement('link');
  link.id = MANIFEST_LINK_ID;
  link.rel = 'manifest';
  // The manifest is per-user, so it is fetched with the session's credentials
  // exactly like the static one used to be.
  link.crossOrigin = 'use-credentials';
  link.href = href;
  document.head.appendChild(link);
}
