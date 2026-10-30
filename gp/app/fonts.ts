import localFont from 'next/font/local'

// Self-hosted (Latin subset, OFL-licensed — see app/fonts/LICENSES.txt). These replaced a
// render-blocking `@import url(fonts.googleapis.com…)` in globals.css, which chained
// HTML -> CSS -> Google CSS -> woff2 before the headline could paint, sent every visitor's IP to
// Google (not disclosed in the Privacy Policy) and had no size-matched fallback, so the Fraunces
// headline visibly reflowed when the font landed. next/font preloads the files from our own
// origin and generates a metric-adjusted fallback so the swap does not shift the layout.
// Glyphs outside Latin (e.g. Latin Extended city names) fall back to the system font per-glyph.
export const fontSans = localFont({
  src: './fonts/DMSans-latin-wght.woff2',
  weight: '100 1000',
  style: 'normal',
  variable: '--font-sans',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: ['system-ui', 'sans-serif'],
})

export const fontDisplay = localFont({
  src: './fonts/Fraunces-latin-wght.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-display',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
  fallback: ['Georgia', 'serif'],
})

// Mono is small print and labels: not worth a preload on every page.
export const fontMono = localFont({
  src: [
    { path: './fonts/DMMono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/DMMono-latin-500.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
})
