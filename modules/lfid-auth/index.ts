import type { GatewazeModule } from '@gatewaze/shared';

const lfidAuthModule: GatewazeModule = {
  id: 'lfid-auth',
  type: 'integration',
  visibility: 'hidden',
  name: 'LFID Authentication',
  description: 'Linux Foundation ID (LFID) authentication via Auth0 — replaces magic link sign-in with LFID SSO for portal and admin users',
  version: '1.0.0',

  features: [
    'lfid-auth',
    'lfid-auth.provision',
  ],

  adminSlots: [
    {
      slotName: 'sign-in:providers',
      component: () => import('./admin/components/LfidSignInButton'),
      order: 10,
      requiredFeature: 'lfid-auth',
      meta: { label: 'Sign in with LFID' },
    },
  ],

  portalSlots: [
    {
      slotName: 'sign-in:providers',
      component: () => import('./portal/components/LfidSignInButton'),
      order: 10,
      requiredFeature: 'lfid-auth',
      meta: { label: 'Sign in with LFID' },
    },
  ],

  edgeFunctions: [
    'integrations-lfid-provision',
  ],

  migrations: [
    'migrations/001_lfid_mappings.sql',
  ],

  configSchema: {
    AUTH0_DOMAIN: {
      key: 'AUTH0_DOMAIN',
      type: 'string',
      required: true,
      default: 'linuxfoundation.auth0.com',
      description: 'LF Auth0 tenant domain',
    },
    AUTH0_CLIENT_ID: {
      key: 'AUTH0_CLIENT_ID',
      type: 'string',
      required: true,
      description: 'Auth0 client ID for the Gatewaze application (from LF Auth0 tenant)',
    },
    AUTH0_CLIENT_SECRET: {
      key: 'AUTH0_CLIENT_SECRET',
      type: 'secret',
      required: true,
      description: 'Auth0 client secret for the Gatewaze application',
    },
    AUTH0_MGMT_CLIENT_ID: {
      key: 'AUTH0_MGMT_CLIENT_ID',
      type: 'string',
      required: false,
      description: 'Auth0 Management API client ID — required for LFID provisioning (lookup/create users)',
    },
    AUTH0_MGMT_CLIENT_SECRET: {
      key: 'AUTH0_MGMT_CLIENT_SECRET',
      type: 'secret',
      required: false,
      description: 'Auth0 Management API client secret — required for LFID provisioning',
    },
    AUTH0_ROLE_CLAIM: {
      key: 'AUTH0_ROLE_CLAIM',
      type: 'string',
      required: false,
      default: 'https://gatewaze.com/roles',
      description: 'JWT claim path that contains user roles (configured in LF Auth0 post-login action)',
    },
    LFID_PROVISION_ON_REGISTRATION: {
      key: 'LFID_PROVISION_ON_REGISTRATION',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Automatically look up / create LFID when a person registers for an event',
    },
  },

  onInstall: async () => {
    console.log('[lfid-auth] Module installed — configure Auth0 credentials in Integrations settings');
  },

  onEnable: async () => {
    console.log('[lfid-auth] Module enabled — ensure Supabase Auth0 provider is configured');
  },

  onDisable: async () => {
    console.log('[lfid-auth] Module disabled — portal and admin will fall back to magic link sign-in');
  },
};

export default lfidAuthModule;
