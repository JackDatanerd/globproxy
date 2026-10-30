/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Families come from next/font (app/fonts.ts), which sets these CSS variables on <html>.
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: '#0f1114', ink2: '#3d4451', muted: '#8892a0',
        border: '#e4e8ef', surface: '#f7f8fa',
        accent: '#0057ff', 'accent-light': '#eff4ff',
        accent2: '#00c896', 'accent2-light': '#edfaf5',
        // AA-contrast text colours for LIGHT backgrounds (public site). `muted` (#8892a0) is 3.15:1 on
        // white and `accent2` (#00c896) is 2.16:1, so small text uses these instead. Keep `muted` and
        // `accent2` for dark surfaces and decorative use.
        subtle: '#64707e',          // 5.05:1 white, 4.75:1 surface, 4.58:1 accent-light
        'accent2-dark': '#007a5a',  // 5.34:1 white, 4.98:1 accent2-light
      },
    },
  },
  plugins: [],
}
