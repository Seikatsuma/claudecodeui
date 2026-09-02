import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarPulseList from './SidebarPulseList';

type SidebarPulseTriggerProps = {
  pulseSessionsCount: number;
  projects: Project[];
  getProjectSessions: (project: Project) => SessionWithProvider[];
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  /** Controls sizing/spacing to match the desktop vs. mobile icon row it sits in. */
  variant: 'desktop' | 'mobile';
  t: TFunction;
};

const PANEL_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

/**
 * Always-visible "Pulse" entry point, independent from the Projects/
 * Conversations/Archive tab strip. A click opens a small overlay panel with
 * the same flat cross-project active-sessions list (SidebarPulseList,
 * unmodified) anchored right below the button, so glancing at what's running
 * never replaces the list the user was already looking at. Closes on an
 * outside click, Escape, or picking a session from the list.
 *
 * The panel is rendered through a portal and positioned from the trigger's
 * own getBoundingClientRect (clamped to the viewport), the same technique
 * ActionMenu uses — the trigger sits inside a narrow (desktop: ~288px,
 * mobile: full-width but the button itself lives near an edge) sidebar
 * header, so a CSS-only `left-0`/`right-0` anchor clips off-screen depending
 * on exactly where in that header the button ends up.
 */
export default function SidebarPulseTrigger({
  pulseSessionsCount,
  projects,
  getProjectSessions,
  activeSessions,
  attentionSessionIds,
  selectedSession,
  currentTime,
  onProjectSelect,
  onSessionSelect,
  variant,
  t,
}: SidebarPulseTriggerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const computePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
    );
    setPanelPosition({ top: rect.bottom + 8, left });
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    computePosition();

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current
        && !triggerRef.current.contains(target)
        && !panelRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    const closeOnViewportChange = () => setIsOpen(false);

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [isOpen]);

  const badgeText = pulseSessionsCount > 99 ? '99+' : String(pulseSessionsCount);
  const isDesktop = variant === 'desktop';
  const label = t('search.modePulse', { defaultValue: 'Pulse' });
  const tooltip = t('search.pulseTooltip', { defaultValue: 'Sessions currently running or waiting on you' });

  const panel = isOpen && panelPosition && typeof document !== 'undefined' && createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('pulse.title', { defaultValue: 'Active now' })}
      className="animate-in fade-in-0 zoom-in-95 fixed z-[70] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      style={{ top: panelPosition.top, left: panelPosition.left, width: PANEL_WIDTH }}
    >
      <div className="max-h-[60vh] overflow-y-auto py-2">
        <SidebarPulseList
          projects={projects}
          getProjectSessions={getProjectSessions}
          activeSessions={activeSessions}
          attentionSessionIds={attentionSessionIds}
          selectedSession={selectedSession}
          currentTime={currentTime}
          searchFilter=""
          onProjectSelect={onProjectSelect}
          onSessionSelect={(session, projectId) => {
            onSessionSelect(session, projectId);
            setIsOpen(false);
          }}
          t={t}
        />
      </div>
    </div>,
    document.body,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={label}
        title={tooltip}
        className={cn(
          'relative flex flex-shrink-0 items-center justify-center rounded-lg transition-all',
          isDesktop
            ? 'h-7 w-7 text-muted-foreground hover:bg-accent/80 hover:text-foreground'
            : 'h-8 w-8 bg-muted/50 active:scale-95',
          isOpen && (isDesktop ? 'bg-accent/80 text-foreground' : 'bg-accent'),
        )}
      >
        <Activity
          className={cn(
            isDesktop ? 'h-3.5 w-3.5' : 'h-4 w-4 text-muted-foreground',
            pulseSessionsCount > 0 && 'text-emerald-500',
          )}
        />
        {pulseSessionsCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white"
            aria-hidden
          >
            {badgeText}
          </span>
        )}
      </button>

      {panel}
    </>
  );
}
