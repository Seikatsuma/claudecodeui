import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

type ChatRequestBarProps = {
  /** The scrolling message pane whose position decides which request is shown. */
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** Changes whenever the message list changes, so the bar re-measures. */
  messagesRevision: number;
};

/**
 * One clipped line under the header naming the request you are currently
 * reading the answer to - the same orientation aid the Claude Code terminal
 * gives, where the prompt stays visible above its output.
 *
 * The active request is "the last user message whose top has scrolled above the
 * top of the pane": once a request's bubble leaves the top of the screen, what
 * fills the screen is its answer. Sitting at the bottom of the chat therefore
 * shows the newest request, which is what it shows by default. Scrolled above
 * the very first request, that rule selects nothing, so the first request is
 * used instead - the bar should never be blank while there is a chat to label.
 *
 * Height is fixed and the text never wraps: this is a label, not content, and a
 * bar that grew with a long prompt would push the conversation around on every
 * scroll. Overflow is clipped with an ellipsis.
 */
export default function ChatRequestBar({ scrollContainerRef, messagesRevision }: ChatRequestBarProps) {
  const [text, setText] = useState<string | null>(null);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nodes = container.querySelectorAll<HTMLElement>('[data-user-request]');
    if (nodes.length === 0) {
      setText(null);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    let active: HTMLElement | null = null;
    for (const node of nodes) {
      // A few pixels of slack so a request resting exactly at the top edge
      // counts as "being read" rather than flickering between two entries.
      if (node.getBoundingClientRect().top - containerTop <= 4) {
        active = node;
      } else {
        break;
      }
    }

    const chosen = active ?? nodes[0];
    setText(chosen?.dataset.userRequest?.trim() || null);
  }, [scrollContainerRef]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    scheduleMeasure();
    container.addEventListener('scroll', scheduleMeasure, { passive: true });
    // Messages stream in and grow after they are first laid out (code blocks,
    // images, tool output), which moves every bubble below them; a plain scroll
    // listener would keep showing a stale request until the next scroll.
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      container.removeEventListener('scroll', scheduleMeasure);
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scrollContainerRef, scheduleMeasure]);

  useEffect(() => {
    scheduleMeasure();
  }, [messagesRevision, scheduleMeasure]);

  if (!text) {
    return null;
  }

  return (
    <div className="flex h-7 flex-shrink-0 items-center border-b border-border/60 bg-muted/40 px-4">
      <span className="w-full truncate text-[12px] leading-none text-muted-foreground" title={text}>
        {text}
      </span>
    </div>
  );
}
