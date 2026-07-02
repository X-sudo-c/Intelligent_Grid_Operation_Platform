/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        premium: {
          bg: '#121212',
          surface: '#161616',
          sidebar: '#1A1A1A',
          'sidebar-raised': '#1C1C1C',
          card: '#1C1C1C',
          hover: '#222222',
          'hover-strong': '#282828',
          border: '#2E2E2E',
          'border-subtle': '#383838',
          text: '#BCBCBC',
          'text-secondary': '#A8A8A8',
          muted: '#858585',
          'muted-dim': '#6B6B6B',
          accent: '#8FA4B8',
          'accent-hover': '#7A92A8',
          'accent-muted': '#2A3036',
          'accent-subtle': 'rgba(143, 164, 184, 0.12)',
          warn: {
            fg: '#A39E98',
            'fg-muted': '#78736E',
            bg: '#1A1918',
            'bg-subtle': '#161514',
            border: '#32302E',
          },
          success: {
            fg: '#8FAF9A',
            bg: '#151917',
            border: '#2C332E',
          },
          danger: {
            fg: '#C49A9A',
            bg: '#1A1515',
            border: '#3A2E2E',
          },
        },
      },
      boxShadow: {
        'premium-sm': '0 1px 2px rgba(0, 0, 0, 0.35)',
        premium: '0 4px 16px rgba(0, 0, 0, 0.4)',
        'premium-lg': '0 8px 24px rgba(0, 0, 0, 0.5)',
      },
    },
  },
  plugins: [],
};
