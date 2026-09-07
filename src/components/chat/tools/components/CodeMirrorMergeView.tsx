import React, { useEffect, useMemo, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { MergeView } from '@codemirror/merge';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

import { getLanguageExtensions } from '../../../code-editor/utils/editorExtensions';

// One-time stylesheet for the split diff view — injected lazily into
// <head> the first time a MergeView mounts, rather than per-instance
// (a chat can render many diffs at once). Uses `.dark` (the app's
// html-level theme class) so a single injection covers both themes.
const MERGE_VIEW_STYLE_ID = 'cm-tool-diff-merge-view-styles';
const MERGE_VIEW_STYLES = `
.cm-tool-diff-merge-view .cm-mergeViewEditor + .cm-mergeViewEditor {
  border-left: 1px solid rgba(0, 0, 0, 0.1);
}
.dark .cm-tool-diff-merge-view .cm-mergeViewEditor + .cm-mergeViewEditor {
  border-left-color: rgba(255, 255, 255, 0.1);
}
.cm-tool-diff-merge-view .cm-editor {
  font-size: 11px;
}
.cm-tool-diff-merge-view .cm-content,
.cm-tool-diff-merge-view .cm-gutters {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.cm-tool-diff-merge-view .cm-scroller {
  line-height: 1.5;
}
.cm-tool-diff-merge-view .cm-gutters {
  background: transparent;
  border-right: none;
}
`;

function ensureMergeViewStylesInjected() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MERGE_VIEW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MERGE_VIEW_STYLE_ID;
  style.textContent = MERGE_VIEW_STYLES;
  document.head.appendChild(style);
}

interface CodeMirrorMergeViewProps {
  /** Content of the "before" (left) pane. */
  oldContent: string;
  /** Content of the "after" (right) pane. */
  newContent: string;
  /** Путь к файлу — по нему подбирается подсветка для обеих половин.
   *  Раньше расширения языка вычислялись снаружи, и из-за этого весь
   *  CodeMirror оказывался в стартовой загрузке даже у тех, кто ни одной
   *  правки файла в чате не открывал. */
  filePath: string;
  isDarkMode: boolean;
}

/**
 * Thin React wrapper around `@codemirror/merge`'s `MergeView` — a true
 * side-by-side (VS Code style) diff: two read-only CodeMirror editors,
 * old on the left / new on the right, with built-in line + inline-change
 * highlighting and vertical alignment of unchanged lines.
 *
 * `MergeView` is a vanilla-DOM class (not a React component), so it is
 * imperatively created against a container ref and torn down on unmount
 * or whenever the diffed content/language/theme changes.
 */
export const CodeMirrorMergeView: React.FC<CodeMirrorMergeViewProps> = ({
  oldContent,
  newContent,
  filePath,
  isDarkMode,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const languageExtensions = useMemo(() => getLanguageExtensions(filePath || ''), [filePath]);

  useEffect(() => {
    ensureMergeViewStylesInjected();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const sharedExtensions: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      EditorView.lineWrapping,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ...languageExtensions,
    ];
    if (isDarkMode) {
      sharedExtensions.push(oneDark);
    }

    const mergeView = new MergeView({
      parent: container,
      a: { doc: oldContent, extensions: sharedExtensions },
      b: { doc: newContent, extensions: sharedExtensions },
      highlightChanges: true,
      gutter: true,
    });

    return () => {
      mergeView.destroy();
    };
  }, [oldContent, newContent, languageExtensions, isDarkMode]);

  return <div ref={containerRef} className="cm-tool-diff-merge-view" />;
};

export default CodeMirrorMergeView;
