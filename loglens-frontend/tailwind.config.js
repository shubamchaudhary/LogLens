/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Theme tokens (src/index.css): light by default, dark on the public pages when
        // <html data-theme="dark">. Values are "R G B" so opacity modifiers work.
        paper: 'rgb(var(--paper) / <alpha-value>)', // page background
        sand: 'rgb(var(--sand) / <alpha-value>)', // secondary panels
        surface: 'rgb(var(--surface) / <alpha-value>)', // panels and cards
        line: 'rgb(var(--line) / <alpha-value>)', // hairline borders
        line2: 'rgb(var(--line2) / <alpha-value>)', // stronger lines, neutral bars
        ink: 'rgb(var(--ink) / <alpha-value>)', // headings
        body: 'rgb(var(--body) / <alpha-value>)', // running text
        muted: 'rgb(var(--muted) / <alpha-value>)', // secondary text
        dim: 'rgb(var(--dim) / <alpha-value>)', // faint labels
        accent: 'rgb(var(--accent) / <alpha-value>)', // violet text and marks
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)', // violet tint behind it
        hot: 'rgb(var(--hot) / <alpha-value>)', // pink text (live set, verdicts)
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out both',
      },
    },
  },
  plugins: [],
}
