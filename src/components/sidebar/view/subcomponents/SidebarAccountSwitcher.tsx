import { Check, ChevronsUpDown, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useOwnerAccountSettings } from '../../../settings/hooks/useOwnerAccountSettings';

type SidebarAccountSwitcherProps = {
  /** Operator-chosen instance label (ACCOUNT_LABEL), e.g. "Shared". */
  accountLabel: string;
  /** Email of the account this instance is currently running as, if known. */
  accountEmail: string | null;
  /** Compact styling for the mobile footer row. */
  variant: 'desktop' | 'mobile';
};

/**
 * The account badge at the bottom of the sidebar, upgraded into a switcher.
 *
 * The same switching is available in Settings -> API & Tokens, but on a phone
 * that tab sits in a horizontally scrolling strip whose later entries are cut
 * off past the right edge with nothing indicating they can be scrolled to - so
 * in practice the owner could not reach it there at all. This badge already
 * shows which account is active and is the place people look for it, so the
 * switch belongs here too. Falls back to a plain, non-interactive badge (the
 * previous behaviour) whenever there is nothing to switch between: a single
 * account, or a non-owner user, for whom the endpoint returns an empty list.
 */
export default function SidebarAccountSwitcher({
  accountLabel,
  accountEmail,
  variant,
}: SidebarAccountSwitcherProps) {
  const { activeSlot, accounts, pendingSlot, errorMessage, activateSlot } = useOwnerAccountSettings();
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const available = accounts.filter((account) => account.available);
  const canSwitch = available.length > 1;

  useEffect(() => {
    if (!isOpen) return;
    const close = () => setIsOpen(false);
    // Outside-click is handled by a document listener rather than a full-screen
    // catcher element on purpose. The catcher mounts during the very click that
    // opens the menu, and on touch that same gesture then reached it and closed
    // the menu again before anything could be seen - it looked like the badge
    // simply did not work on a phone. This effect is registered after that
    // click has finished, so it can only ever see the NEXT one.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target ?? null)) return;
      if (triggerRef.current?.contains(target ?? null)) return;
      setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [isOpen]);

  const activeEmail = available.find((account) => account.slot === activeSlot)?.email ?? accountEmail;

  const badgeInner = (
    <>
      <Users className="h-4 w-4 flex-shrink-0 text-violet-500 dark:text-violet-400" />
      <div className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs font-medium text-violet-700 dark:text-violet-300">
          {accountLabel}
        </span>
        {activeEmail && (
          <span
            className="block truncate text-[10px] text-violet-500/80 dark:text-violet-400/70"
            title={activeEmail}
          >
            {activeEmail}
          </span>
        )}
      </div>
      {canSwitch && (
        <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-violet-500/70 dark:text-violet-400/70" />
      )}
    </>
  );

  const shell =
    variant === 'mobile'
      ? 'flex w-full items-center gap-3 rounded-xl border border-violet-300/60 bg-violet-50/80 px-3.5 py-2 dark:border-violet-700/40 dark:bg-violet-900/15'
      : 'flex w-full items-center gap-2.5 rounded-lg border border-violet-300/60 bg-violet-50/80 px-2.5 py-2 dark:border-violet-700/40 dark:bg-violet-900/15';

  if (!canSwitch) {
    return <div className={shell}>{badgeInner}</div>;
  }

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8, width: rect.width });
    }
    setIsOpen((previous) => !previous);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={`${shell} transition-colors hover:bg-violet-100/80 active:scale-[0.99] dark:hover:bg-violet-900/25`}
      >
        {badgeInner}
      </button>

      {isOpen && anchor
        ? createPortal(
            <>
              <div
                ref={menuRef}
                role="menu"
                className="fixed z-[9999] overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
                style={{ left: anchor.left, bottom: anchor.bottom, width: Math.max(anchor.width, 240) }}
              >
                <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Your Claude accounts
                </div>
                {available.map((account) => {
                  const isActive = account.slot === activeSlot;
                  const isBusy = pendingSlot === account.slot;
                  return (
                    <button
                      key={account.slot}
                      type="button"
                      role="menuitem"
                      disabled={isActive || pendingSlot !== null}
                      onClick={() => void activateSlot(account.slot)}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/60 disabled:cursor-default"
                    >
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                        {isActive && <Check className="h-4 w-4 text-green-600 dark:text-green-400" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {account.email ?? `Account ${account.slot}`}
                      </span>
                      {isBusy && <span className="text-xs text-muted-foreground">…</span>}
                    </button>
                  );
                })}
                {errorMessage && (
                  <p className="border-t border-border/60 px-3 py-2 text-xs text-destructive">{errorMessage}</p>
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
