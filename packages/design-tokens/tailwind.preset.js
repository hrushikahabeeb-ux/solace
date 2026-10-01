/** Tailwind preset — maps CSS custom properties from tokens.css into Tailwind utilities.
 *  Import this from apps/web/tailwind.config.js so every app shares one palette.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: 'var(--color-bg-canvas)',
          alt: 'var(--color-bg-canvas-alt)',
        },
        card: {
          DEFAULT: 'var(--color-bg-card)',
          alt: 'var(--color-bg-card-alt)',
        },
        cream: 'var(--color-bg-cream)',
        coral: {
          DEFAULT: 'var(--color-accent-coral)',
          hover: 'var(--color-accent-coral-hover)',
        },
        peach: 'var(--color-accent-peach)',
        lavender: {
          DEFAULT: 'var(--color-accent-lavender)',
          deep: 'var(--color-accent-lavender-deep)',
        },
        ink: {
          canvas: 'var(--color-text-on-canvas)',
          'canvas-muted': 'var(--color-text-on-canvas-muted)',
          card: 'var(--color-text-on-card)',
          'card-muted': 'var(--color-text-on-card-muted)',
        },
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
      },
      borderColor: {
        'on-canvas': 'var(--color-border-on-canvas)',
        soft: 'var(--color-border-soft)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        soft: 'var(--shadow-soft)',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
};
