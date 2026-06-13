import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bee: {
          DEFAULT: '#f7b220',
          dim: '#c98f15',
          glow: '#ffd166',
        },
        ink: {
          950: '#0a0a0c',
          900: '#101014',
          850: '#16161c',
          800: '#1c1c24',
          700: '#2a2a35',
        },
      },
      animation: {
        'pulse': 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      animationDelay: {
        '100': '100ms',
        '200': '200ms',
      },
    },
  },
  plugins: [],
} satisfies Config;
