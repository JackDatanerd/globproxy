// Renders a <script type="application/ld+json"> tag for any schema.org object.
// JSON.stringify + the </script>-in-string escape is the standard safe pattern
// for embedding structured data server-side in Next's App Router.
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}
