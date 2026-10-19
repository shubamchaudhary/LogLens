import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Shared markdown renderer for the report and grounded chat answers. GitHub-
 * flavoured (tables, lists, code) with Tailwind-styled elements so output reads
 * like a real document instead of a raw ``# heading`` dump. No raw HTML is ever
 * rendered (react-markdown escapes it), so model output can't inject markup.
 */
// react-markdown passes its AST `node` to every component; only forward what the
// DOM element needs so `node` never lands on an element as an attribute.
const tag = (Tag, className) =>
  function MarkdownTag({ children, href, style }) {
    return (
      <Tag className={className} href={href} style={style}>
        {children}
      </Tag>
    );
  };

const components = {
  h1: tag('h1', 'text-xl font-bold text-slate-900 mt-2 mb-3'),
  h2: tag('h2', 'text-base font-semibold text-slate-900 mt-5 mb-2 pb-1 border-b border-slate-100'),
  h3: tag('h3', 'text-sm font-semibold text-slate-800 mt-4 mb-1.5'),
  p: tag('p', 'text-sm leading-relaxed text-slate-700 my-2'),
  ul: tag('ul', 'list-disc pl-5 my-2 space-y-1 text-sm text-slate-700'),
  ol: tag('ol', 'list-decimal pl-5 my-2 space-y-1 text-sm text-slate-700'),
  li: tag('li', 'leading-relaxed'),
  strong: tag('strong', 'font-semibold text-slate-900'),
  a: ({ children, href }) => (
    <a className="text-violet-600 underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  blockquote: tag('blockquote', 'border-l-2 border-slate-200 pl-3 my-2 text-sm text-slate-500 italic'),
  pre: tag('pre', 'my-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[12px] text-slate-100'),
  // react-markdown v9 no longer passes `inline`: fenced blocks carry a language
  // class or newlines, everything else is inline code.
  code: ({ className, children }) =>
    /language-/.test(className || '') || String(children).includes('\n') ? (
      <code className={`font-mono ${className || ''}`}>{children}</code>
    ) : (
      <code className="rounded bg-violet-50 px-1 py-0.5 font-mono text-[12px] text-violet-800">{children}</code>
    ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full text-sm border border-slate-200 rounded-lg">{children}</table>
    </div>
  ),
  thead: tag('thead', 'bg-slate-50'),
  th: tag('th', 'text-left font-semibold text-slate-700 px-3 py-2 border-b border-slate-200'),
  td: tag('td', 'px-3 py-2 border-b border-slate-100 text-slate-700 align-top'),
  hr: () => <hr className="my-4 border-slate-100" />,
};

export default function Markdown({ children }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children || ''}
    </ReactMarkdown>
  );
}
