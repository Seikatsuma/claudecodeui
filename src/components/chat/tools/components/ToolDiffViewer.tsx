import React, { useMemo, useState } from 'react';

import { useTheme } from '../../../../contexts/ThemeContext';
import { getLanguageExtensions } from '../../../code-editor/utils/editorExtensions';

import { CodeMirrorMergeView } from './CodeMirrorMergeView';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolDiffViewerProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  /**
   * Legacy line-diff calculator — no longer used to render the diff itself
   * (the split view lets `@codemirror/merge` diff `oldContent`/`newContent`
   * directly, which is more precise than the LCS line diff this produced),
   * but kept in the prop signature so callers upstream don't need to change.
   */
  createDiff?: (oldStr: string, newStr: string) => DiffLine[];
  onFileClick?: () => void;
  badge?: string;
  badgeColor?: 'gray' | 'green';
}

// Diffs taller than this (in lines, on either side) start collapsed behind
// a "click to expand" overlay instead of dumping hundreds of lines into
// the chat feed.
const LARGE_DIFF_LINE_THRESHOLD = 24;
const COLLAPSED_MAX_HEIGHT = 260;

/**
 * Split (VS Code style) diff viewer — old content on the left, new content
 * on the right, rendered via `@codemirror/merge`'s `MergeView` with
 * line-level and inline-change highlighting plus syntax highlighting by
 * file extension.
 */
export const ToolDiffViewer: React.FC<ToolDiffViewerProps> = ({
  oldContent,
  newContent,
  filePath,
  onFileClick,
  badge = 'Diff',
  badgeColor = 'gray'
}) => {
  const { isDarkMode } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const badgeClasses = badgeColor === 'green'
    ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400';

  const safeOldContent = oldContent ?? '';
  const safeNewContent = newContent ?? '';

  const languageExtensions = useMemo(
    () => getLanguageExtensions(filePath || ''),
    [filePath]
  );

  const maxLineCount = useMemo(() => {
    const oldLines = safeOldContent.split('\n').length;
    const newLines = safeNewContent.split('\n').length;
    return Math.max(oldLines, newLines);
  }, [safeOldContent, safeNewContent]);

  const isLargeDiff = maxLineCount > LARGE_DIFF_LINE_THRESHOLD;
  const isCollapsed = isLargeDiff && !expanded;

  return (
    <div className="overflow-hidden rounded border border-gray-200/60 dark:border-gray-700/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200/60 bg-gray-50/80 px-2.5 py-1 dark:border-gray-700/50 dark:bg-gray-800/40">
        {onFileClick ? (
          <button
            onClick={onFileClick}
            className="cursor-pointer truncate font-mono text-[11px] text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {filePath}
          </button>
        ) : (
          <span className="truncate font-mono text-[11px] text-gray-600 dark:text-gray-400">
            {filePath}
          </span>
        )}
        <span className={`rounded px-1.5 py-px text-[10px] font-medium ${badgeClasses} ml-2 flex-shrink-0`}>
          {badge}
        </span>
      </div>

      {/* Split diff */}
      <div className="relative">
        <div
          className="overflow-hidden"
          style={isCollapsed ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
        >
          <CodeMirrorMergeView
            oldContent={safeOldContent}
            newContent={safeNewContent}
            languageExtensions={languageExtensions}
            isDarkMode={isDarkMode}
          />
        </div>

        {isCollapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-white to-transparent pb-1.5 dark:from-gray-900">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="pointer-events-auto rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Show full diff ({maxLineCount} lines)
            </button>
          </div>
        )}
      </div>

      {isLargeDiff && expanded && (
        <div className="flex justify-center border-t border-gray-200/60 bg-gray-50/80 py-1 dark:border-gray-700/50 dark:bg-gray-800/40">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-[11px] font-medium text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  );
};
