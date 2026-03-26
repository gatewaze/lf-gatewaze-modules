import type { GatewazeModule } from '@gatewaze/shared';

/**
 * LF (Linux Foundation) Brand Theme Module
 *
 * Overrides the Gatewaze admin and portal themes with LF branding.
 * Only one theme module can be active at a time — enabling this
 * module will automatically disable any other active theme.
 */
const lfTheme: GatewazeModule = {
  id: 'lf-theme',
  name: 'LF Brand Theme',
  description: 'Linux Foundation brand theme for Gatewaze — overrides admin and portal appearance with LF branding.',
  version: '1.0.0',
  type: 'theme',
  visibility: 'public',
  group: 'theme',
  features: ['theme.lf'],

  themeOverrides: {
    admin: {
      primaryColor: 'blue',
      darkColor: 'navy',
      lightColor: 'slate',
      themeMode: 'light',
      cardSkin: 'bordered',
      customCss: './admin/custom.css',
    },
    portal: {
      brandingDefaults: {
        primary_color: '#003764',
        secondary_color: '#ffffff',
        tertiary_color: '#f5f5f5',
        font_heading: 'Open Sans',
        font_heading_weight: '700',
        font_body: 'Open Sans',
        font_body_weight: '400',
      },
      portalTheme: 'basic',
      cornerStyle: 'rounded',
      themeColors: {
        basic: { background: '#ffffff' },
      },
      htmlClassName: 'lf-brand',
    },
    lockedSettings: [
      'primary_color',
      'secondary_color',
      'tertiary_color',
      'font_heading',
      'font_heading_weight',
      'font_body',
      'font_body_weight',
      'portal_theme',
      'corner_style',
    ],
  },

  configSchema: {
    showLfLogo: {
      key: 'showLfLogo',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Show the LF logo in portal header',
    },
  },

  onEnable: async () => {
    console.log('[lf-theme] LF brand theme activated');
  },

  onDisable: async () => {
    console.log('[lf-theme] LF brand theme deactivated');
  },
};

export default lfTheme;
