const designTokens = require('../../packages/design-tokens/tailwind.preset.js');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [designTokens],
  content: ['./src/**/*.{ts,tsx}'],
};
