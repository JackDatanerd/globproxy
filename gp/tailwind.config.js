/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        display: ['Fraunces', 'serif'],
        mono: ['DM Mono', 'monospace'],
      },
      colors: {
        ink: '#0f1114', ink2: '#3d4451', muted: '#8892a0',
        border: '#e4e8ef', surface: '#f7f8fa',
        accent: '#0057ff', 'accent-light': '#eff4ff',
        accent2: '#00c896', 'accent2-light': '#edfaf5',
      },
    },
  },
  plugins: [],
}
