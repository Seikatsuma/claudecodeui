import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import lang_bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import lang_css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import lang_diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import lang_docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import lang_go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import lang_ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import lang_java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import lang_javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import lang_json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import lang_jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import lang_markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import lang_markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import lang_nginx from 'react-syntax-highlighter/dist/esm/languages/prism/nginx';
import lang_php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import lang_python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import lang_rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import lang_sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import lang_tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import lang_typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import lang_yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';

import MermaidDiagram from '../../../code-editor/view/subcomponents/markdown/MermaidDiagram';
import { normalizeInlineCodeFences, separateMarkdownBlocks } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import { useTheme } from '../../../../contexts/ThemeContext';

/**
 * Подсветка кода — только те языки, которые встречаются в этих чатах.
 *
 * Обычный `Prism` из react-syntax-highlighter тянет грамматики трёхсот языков
 * — почти шесть мегабайт исходника, и всё это разбирается браузером при
 * старте, включая ассемблер PL/I и язык разметки Wolfram. Здесь их два
 * десятка, зарегистрированных вручную: если попадётся незнакомый, блок
 * покажется без раскраски, но читаемым.
 */
SyntaxHighlighter.registerLanguage('bash', lang_bash);
SyntaxHighlighter.registerLanguage('css', lang_css);
SyntaxHighlighter.registerLanguage('diff', lang_diff);
SyntaxHighlighter.registerLanguage('docker', lang_docker);
SyntaxHighlighter.registerLanguage('go', lang_go);
SyntaxHighlighter.registerLanguage('ini', lang_ini);
SyntaxHighlighter.registerLanguage('java', lang_java);
SyntaxHighlighter.registerLanguage('javascript', lang_javascript);
SyntaxHighlighter.registerLanguage('json', lang_json);
SyntaxHighlighter.registerLanguage('jsx', lang_jsx);
SyntaxHighlighter.registerLanguage('markdown', lang_markdown);
SyntaxHighlighter.registerLanguage('markup', lang_markup);
SyntaxHighlighter.registerLanguage('nginx', lang_nginx);
SyntaxHighlighter.registerLanguage('php', lang_php);
SyntaxHighlighter.registerLanguage('python', lang_python);
SyntaxHighlighter.registerLanguage('rust', lang_rust);
SyntaxHighlighter.registerLanguage('sql', lang_sql);
SyntaxHighlighter.registerLanguage('tsx', lang_tsx);
SyntaxHighlighter.registerLanguage('typescript', lang_typescript);
SyntaxHighlighter.registerLanguage('yaml', lang_yaml);

/* Формулы KaTeX убраны: таблица стилей к ним никогда не подключалась, то
   есть математика и так рисовалась неоформленной, а библиотека занимала
   заметный кусок того, что грузится при старте. */

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Оставлен для совместимости вызовов: переносы строк теперь значимы
   *  всегда, и отдельный признак ни на что не влияет. */
  breaks?: boolean;
};

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

type CodeBlockProps = {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  /** Set by the custom `pre` renderer: this code element is a fenced/indented block. */
  forceBlock?: boolean;
};

// `node` is destructured out so react-markdown's hast node never reaches the DOM.
const CodeBlock = ({ node: _node, className, children, forceBlock, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  // Fenced blocks carry a trailing newline in the tree; trim it so the
  // highlighter doesn't render an empty final line.
  const raw = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
  // react-markdown v9+ dropped the `inline` prop: block code is whatever the
  // `pre` renderer hands us (forceBlock). Multiline is kept as a safety net.
  const shouldInline = !forceBlock && !/[\r\n]/.test(raw);

  if (shouldInline) {
    // box-decoration-clone + overflow-wrap:anywhere: this is an INLINE box with
    // horizontal padding and a border, so when its text filled the line the
    // padding and border kept painting past the container's right edge
    // (measured: ~6px past the list item on a 390px phone). `clone` makes each
    // wrapped line fragment carry its own padding/border instead of stretching
    // one box across the break, and `anywhere` lets a long unbroken token (a
    // path, a flag, an identifier) break before it has to overflow at all.
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted box-decoration-clone px-1.5 py-0.5 font-mono text-[0.875em] text-foreground [overflow-wrap:anywhere] ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);

  if (language === 'mermaid') {
    return <MermaidDiagram code={raw} />;
  }

  return (
    <div className="group my-3 overflow-hidden rounded-xl border border-border bg-muted/50 shadow-sm dark:bg-zinc-900">
      {/* Label row shares the block's background — no divider, ChatGPT-style */}
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="select-none text-xs text-muted-foreground">{languageLabel}</span>
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className={`rounded-md p-1 transition-opacity focus-visible:opacity-100 ${copied
            ? 'text-green-600 opacity-100 dark:text-green-500'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
            }`}
          title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        >
          {copied ? (
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
          )}
        </button>
      </div>

      <SyntaxHighlighter
        language={language}
        style={isDarkMode ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '0.8125rem',
          lineHeight: 1.6,
          padding: '0.5rem 1rem 1rem',
          // The container owns the background so the label row and code read as one panel.
          background: 'transparent',
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            background: 'transparent',
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );
};

const markdownComponents = {
  code: CodeBlock,
  // Fenced/indented code arrives as <pre><code>. Re-render the child CodeBlock
  // with `forceBlock` so it always gets the block treatment (react-markdown v9+
  // no longer passes an `inline` flag), and skip the outer <pre> so Tailwind
  // Typography doesn't wrap the highlighter in a second dark shell.
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children.find(React.isValidElement) : children;
    if (React.isValidElement(child) && child.type === CodeBlock) {
      return <CodeBlock {...(child.props as CodeBlockProps)} forceBlock />;
    }
    return <>{children}</>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,

  // Заголовки: заметный отрыв сверху, минимальный снизу — чтобы заголовок
  // читался как начало блока, а не висел между двумя одинаковыми пробелами.
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-5 text-[17px] font-semibold leading-snug text-foreground first:mt-0">{children}</h2>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-2 mt-5 text-[15px] font-semibold leading-snug text-foreground first:mt-0">{children}</h3>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="mb-1.5 mt-4 text-[14px] font-semibold leading-snug text-foreground first:mt-0">{children}</h4>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h5 className="mb-1.5 mt-4 text-[13px] font-semibold leading-snug text-foreground first:mt-0">{children}</h5>
  ),

  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2.5 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2.5 list-outside list-disc space-y-1 pl-5 marker:text-muted-foreground last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2.5 list-outside list-decimal space-y-1 pl-6 marker:text-muted-foreground marker:tabular-nums last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="pl-0.5 [&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
      <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="[&:last-child>td]:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
};

export function Markdown({ children, className }: MarkdownProps) {
  const content = separateMarkdownBlocks(normalizeInlineCodeFences(String(children ?? '')));
  // Перенос строки теперь значим везде, а не только в репликах человека.
  // Модель разбивает мысль на строки осмысленно; склеивать их обратно в
  // сплошной абзац — ровно то, на что было больно смотреть.
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks] as any, []);
  const { openFileInEditor } = usePaletteOps();

  const components = useMemo(
    () => ({
      ...markdownComponents,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(stripLineSuffix(fileRef));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [openFileInEditor],
  );

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
