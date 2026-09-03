import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Star } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';

type SidebarProjectPickerTriggerProps = {
  projects: Project[];
  selectedProjectId: string | null;
  isProjectStarred: (projectId: string) => boolean;
  onProjectSelect: (project: Project) => void;
  /** Controls sizing/spacing to match the desktop vs. mobile icon row it sits in. */
  variant: 'desktop' | 'mobile';
  t: TFunction;
};

const PANEL_WIDTH = 300;
const VIEWPORT_MARGIN = 8;

/**
 * Compact "all projects" entry point for the flat/starred-project sidebar mode.
 * A click opens a small overlay panel with the full project list so the user can
 * switch context without the main session list ever showing the clutter of all
 * projects at once. Uses the same portal + getBoundingClientRect technique as
 * SidebarPulseTrigger.
 */
export default function SidebarProjectPickerTrigger({
  projects,
  selectedProjectId,
  isProjectStarred,
  onProjectSelect,
  variant,
  t,
}: SidebarProjectPickerTriggerProps) {
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

  const isDesktop = variant === 'desktop';
  const label = t('projects.allProjects', { defaultValue: 'All projects' });

  const panel = isOpen && panelPosition && typeof document !== 'undefined' && createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className="animate-in fade-in-0 zoom-in-95 fixed z-[70] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      style={{ top: panelPosition.top, left: panelPosition.left, width: PANEL_WIDTH }}
    >
      <div className="border-b border-border/60 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
      <div className="max-h-[60vh] overflow-y-auto py-1">
        {projects.map((project) => {
          const starred = isProjectStarred(project.projectId);
          const isSelected = project.projectId === selectedProjectId;
          const total = Number(project.sessionMeta?.total ?? 0);

          return (
            <button
              key={project.projectId}
              type="button"
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/60',
                isSelected && 'bg-accent/40',
              )}
              onClick={() => {
                onProjectSelect(project);
                setIsOpen(false);
              }}
            >
              {starred ? (
                <Star className="h-3 w-3 flex-shrink-0 text-yellow-500 fill-current" />
              ) : (
                <span className="h-3 w-3 flex-shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">
                  {project.displayName}
                </span>
                {total > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {total}
                    {' '}
                    {total === 1
                      ? t('sessions.sessionCount_one', { defaultValue: 'session' })
                      : t('sessions.sessionCount_other', { defaultValue: 'sessions', count: total })}
                  </span>
                )}
              </span>
            </button>
          );
        })}
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
        title={label}
        className={cn(
          'relative flex flex-shrink-0 items-center justify-center rounded-lg transition-all',
          isDesktop
            ? 'h-7 w-7 text-muted-foreground hover:bg-accent/80 hover:text-foreground'
            : 'h-8 w-8 bg-muted/50 active:scale-95',
          isOpen && (isDesktop ? 'bg-accent/80 text-foreground' : 'bg-accent'),
        )}
      >
        <Layers
          className={cn(isDesktop ? 'h-3.5 w-3.5' : 'h-4 w-4 text-muted-foreground')}
        />
      </button>

      {panel}
    </>
  );
}
