"use client";

import * as React from 'react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './Collapsible';
import { Shimmer } from './Shimmer';

/* ─── Context ────────────────────────────────────────────────────── */

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = React.createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = React.useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

/* ─── Reasoning (root) ───────────────────────────────────────────── */

const MS_IN_S = 1000;

export interface ReasoningProps extends React.HTMLAttributes<HTMLDivElement> {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
}

export const Reasoning = React.memo<ReasoningProps>(
  ({
    className,
    isStreaming = false,
    open: controlledOpen,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }) => {
    // Размышления по умолчанию свёрнуты — даже во время потока.
    //
    // Раньше блок раскрывался сам на время ответа и закрывался через секунду
    // после. Из-за этого экран занимал текст, который читать не нужно, а
    // настоящий ответ уезжал вниз. В панели Клода для VS Code это одна строка
    // «Thinking», раскрывается по желанию, — так же и здесь. Строка со
    // счётчиком времени остаётся видна всегда, поэтому «когда Клод думает»
    // по-прежнему понятно с первого взгляда.
    const resolvedDefaultOpen = defaultOpen ?? false;

    // Controllable open state
    const [internalOpen, setInternalOpen] = React.useState(resolvedDefaultOpen);
    const isControlled = controlledOpen !== undefined;
    const isOpen = isControlled ? controlledOpen : internalOpen;
    const setIsOpen = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        onOpenChange?.(next);
      },
      [isControlled, onOpenChange]
    );

    // Duration tracking
    const [duration, setDuration] = React.useState<number | undefined>(durationProp);
    const hasEverStreamedRef = React.useRef(isStreaming);
    const startTimeRef = React.useRef<number | null>(null);

    // Sync external duration prop
    React.useEffect(() => {
      if (durationProp !== undefined) setDuration(durationProp);
    }, [durationProp]);

    // Track streaming start/end for duration
    React.useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming]);

    // Ни авто-раскрытия, ни авто-закрытия: блок открывает и закрывает человек.
    // Раскрытое состояние, которое схлопывается само через секунду, читать
    // невозможно, а закрыть раньше времени нельзя — оно откроется снова.

    const contextValue = React.useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          open={isOpen}
          onOpenChange={setIsOpen}
          className={cn('not-prose', className)}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);
Reasoning.displayName = 'Reasoning';

/* ─── ReasoningTrigger ───────────────────────────────────────────── */

export interface ReasoningTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => React.ReactNode;
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number): React.ReactNode => {
  if (isStreaming || duration === 0) {
    return <Shimmer>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

export const ReasoningTrigger = React.memo<ReasoningTriggerProps>(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="h-4 w-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                'h-4 w-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0'
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);
ReasoningTrigger.displayName = 'ReasoningTrigger';

/* ─── ReasoningContent ───────────────────────────────────────────── */

export interface ReasoningContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ReasoningContent = React.memo<ReasoningContentProps>(
  ({ className, children, ...props }) => (
    <CollapsibleContent
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    >
      {children}
    </CollapsibleContent>
  )
);
ReasoningContent.displayName = 'ReasoningContent';
