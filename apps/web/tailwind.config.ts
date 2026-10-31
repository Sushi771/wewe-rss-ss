import { dirname, join } from 'node:path';
import type { Config } from 'tailwindcss';
import { nextui } from '@nextui-org/react';

// Resolve through the direct dependency; pnpm does not hoist theme to the root.
const themeDirectory = dirname(
  require.resolve('@nextui-org/theme', {
    paths: [require.resolve('@nextui-org/react')],
  }),
);
const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    join(themeDirectory, '**/*.{js,mjs,ts,jsx,tsx}').replaceAll('\\', '/'),
  ],
  theme: {
    extend: {},
  },
  darkMode: 'class',
  plugins: [nextui()],
};
export default config;
