/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Local palette (used by app chrome)
        ink: {
          0: '#09090b',   // page bg
          50: '#0d0d10',  // surface
          100: '#141418', // surface-2
          200: '#1c1c22', // surface-3
          300: '#27272f', // border
          400: '#3f3f47', // border-strong
          500: '#71717a', // muted text
          600: '#a1a1aa', // text dim
          700: '#d4d4d8', // text
          800: '#e4e4e7', // text strong
          900: '#fafafa', // text emphasis
        },
        pulse: {
          DEFAULT: '#a3e635',
          dim: '#65a30d',
          glow: '#bef264',
        },
        // Tremor — minimal mapping so the few Tremor components inherit our look
        tremor: {
          brand: { faint: '#0d0d10', muted: '#141418', subtle: '#27272f', DEFAULT: '#a3e635', emphasis: '#bef264', inverted: '#09090b' },
          background: { muted: '#0d0d10', subtle: '#141418', DEFAULT: '#09090b', emphasis: '#e4e4e7' },
          border: { DEFAULT: '#27272f' },
          ring: { DEFAULT: '#27272f' },
          content: { subtle: '#71717a', DEFAULT: '#a1a1aa', emphasis: '#e4e4e7', strong: '#fafafa', inverted: '#09090b' },
        },
        'dark-tremor': {
          brand: { faint: '#0d0d10', muted: '#141418', subtle: '#27272f', DEFAULT: '#a3e635', emphasis: '#bef264', inverted: '#09090b' },
          background: { muted: '#0d0d10', subtle: '#141418', DEFAULT: '#09090b', emphasis: '#e4e4e7' },
          border: { DEFAULT: '#27272f' },
          ring: { DEFAULT: '#27272f' },
          content: { subtle: '#71717a', DEFAULT: '#a1a1aa', emphasis: '#e4e4e7', strong: '#fafafa', inverted: '#09090b' },
        },
      },
      boxShadow: {
        'tremor-input': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'tremor-card': 'none',
        'tremor-dropdown': '0 4px 6px -1px rgb(0 0 0 / 0.5)',
        'dark-tremor-input': '0 1px 2px 0 rgb(0 0 0 / 0.5)',
        'dark-tremor-card': 'none',
        'dark-tremor-dropdown': '0 4px 6px -1px rgb(0 0 0 / 0.5)',
        'pulse-glow': '0 0 0 4px rgba(163, 230, 53, 0.15)',
      },
      borderRadius: {
        'tremor-small': '0.25rem',
        'tremor-default': '0.375rem',
        'tremor-full': '9999px',
      },
      fontSize: {
        'tremor-label': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        'tremor-default': ['0.8125rem', { lineHeight: '1.15rem' }],
        'tremor-title': ['0.9375rem', { lineHeight: '1.4rem' }],
        'tremor-metric': ['1.5rem', { lineHeight: '1.875rem' }],
      },
      keyframes: {
        ping: { '0%': { transform: 'scale(1)', opacity: '0.8' }, '75%, 100%': { transform: 'scale(2.4)', opacity: '0' } },
      },
    },
  },
  safelist: [
    { pattern: /^(bg|text|border|ring|fill|stroke)-(tremor|dark-tremor)/ },
  ],
  plugins: [],
};
