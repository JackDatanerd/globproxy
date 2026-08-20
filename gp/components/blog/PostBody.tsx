import type { ContentBlock, FaqItem } from '@/lib/blog/types'

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="text-ink2 text-[17px] font-light leading-relaxed mb-6">{block.text}</p>
    case 'h2':
      return (
        <h2 id={block.id ?? slugify(block.text)} className="font-display font-bold text-2xl text-ink tracking-tight mt-12 mb-4 scroll-mt-24">
          {block.text}
        </h2>
      )
    case 'h3':
      return (
        <h3 id={block.id ?? slugify(block.text)} className="font-display font-bold text-xl text-ink tracking-tight mt-8 mb-3 scroll-mt-24">
          {block.text}
        </h3>
      )
    case 'ul':
      return (
        <ul className="flex flex-col gap-2.5 mb-6">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-3 text-ink2 text-[15px] font-light leading-relaxed">
              <span className="text-accent font-bold flex-shrink-0 mt-0.5">→</span>
              {item}
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol className="flex flex-col gap-3 mb-6">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-3 text-ink2 text-[15px] font-light leading-relaxed">
              <span className="w-6 h-6 rounded-full bg-accent-light text-accent font-mono text-xs font-medium flex items-center justify-center flex-shrink-0">
                {i + 1}
              </span>
              <span className="pt-0.5">{item}</span>
            </li>
          ))}
        </ol>
      )
    case 'quote':
      return (
        <blockquote className="border-l-2 border-accent pl-5 my-8 text-ink text-lg font-light italic leading-relaxed">
          {block.text}
          {block.cite && <cite className="block not-italic text-xs font-mono text-muted mt-2">— {block.cite}</cite>}
        </blockquote>
      )
    case 'callout':
      return (
        <div
          className={`rounded-xl p-6 my-8 border ${
            block.tone === 'accent2' ? 'bg-accent2-light border-accent2/20' : 'bg-accent-light border-accent/20'
          }`}
        >
          <div className={`font-display font-bold text-sm mb-1.5 ${block.tone === 'accent2' ? 'text-accent2' : 'text-accent'}`}>
            {block.title}
          </div>
          <p className="text-ink2 text-sm font-light leading-relaxed">{block.text}</p>
        </div>
      )
    case 'table':
      return (
        <div className="border border-border rounded-xl overflow-hidden my-8 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface border-b border-border">
                {block.headers.map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[10px] font-mono text-muted uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-none">
                  {row.map((cell, j) => (
                    <td key={j} className="px-4 py-3 text-ink2 text-sm align-top">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    default:
      return null
  }
}

export default function PostBody({ body }: { body: ContentBlock[] }) {
  return (
    <div>
      {body.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

export function PostFaq({ items }: { items: FaqItem[] }) {
  return (
    <div className="mt-14 pt-10 border-t border-border">
      <h2 className="font-display font-bold text-2xl text-ink tracking-tight mb-6">Frequently asked</h2>
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <div key={item.q} className="border border-border rounded-xl p-5">
            <div className="font-medium text-ink text-sm mb-2">{item.q}</div>
            <div className="text-ink2 text-sm font-light leading-relaxed">{item.a}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
