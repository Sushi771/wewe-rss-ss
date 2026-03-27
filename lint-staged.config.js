export default {
  '*.{js,ts,tsx}': ['prettier --write'],
  'apps/web/**/*.{ts,tsx}': ['pnpm --filter web lint'],
  'apps/server/**/*.ts': ['pnpm --filter server lint'],
};
