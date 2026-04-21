import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="text-base font-semibold mt-2 mb-1.5" {...props} />,
          h2: (props) => <h2 className="text-sm font-semibold mt-2 mb-1" {...props} />,
          h3: (props) => <h3 className="text-sm font-semibold mt-1.5 mb-1" {...props} />,
          p: (props) => <p className="my-1.5" {...props} />,
          ul: (props) => <ul className="list-disc list-outside pl-5 my-1.5 space-y-0.5" {...props} />,
          ol: (props) => <ol className="list-decimal list-outside pl-5 my-1.5 space-y-0.5" {...props} />,
          li: (props) => <li className="marker:text-[var(--color-ink-muted)]" {...props} />,
          a: (props) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent)] underline underline-offset-2"
            />
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code
                  className={`${className ?? ''} block`}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-[var(--color-surface-3)] px-1 py-0.5 text-[0.85em] font-mono"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              className="rounded bg-[var(--color-surface-3)] border border-[var(--color-border)] p-2 my-2 text-[0.8rem] overflow-auto font-mono"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-[var(--color-accent)] pl-3 my-2 text-[var(--color-ink-muted)] italic"
              {...props}
            />
          ),
          hr: () => <hr className="my-3 border-[var(--color-border)]" />,
          table: (props) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse w-full" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border border-[var(--color-border)] px-2 py-1 text-left bg-[var(--color-surface-3)]"
              {...props}
            />
          ),
          td: (props) => (
            <td className="border border-[var(--color-border)] px-2 py-1" {...props} />
          ),
          strong: (props) => <strong className="font-semibold" {...props} />,
          em: (props) => <em className="italic" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
