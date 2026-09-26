/**
 * Возможности настольной программы Claude UI (Mac/Windows), которые она даёт
 * странице «Этого компьютера» (electron/preload.cjs). На сайте их нет —
 * isDesktopApp() = false, и интерфейс ведёт себя как раньше.
 */
type DesktopBridge = {
  platform: string;
  pickFolder: (options?: { defaultPath?: string }) => Promise<string | null>;
};

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { claudeUiDesktop?: DesktopBridge }).claudeUiDesktop;
  return bridge && typeof bridge.pickFolder === 'function' ? bridge : null;
}

export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null;
}
