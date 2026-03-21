# LF Gatewaze Modules

Linux Foundation specific modules for [Gatewaze](https://github.com/gatewaze/gatewaze) — AI-powered content intelligence for the agentic AI ecosystem.

## Available Modules

| Module | Description |
|--------|-------------|
| `@lf-gatewaze-modules/content-pipeline` | Content pipeline infrastructure: database tables, admin UI, and service layer for content discovery, indexing, and deep video search |
| `@lf-gatewaze-modules/content-discovery` | Automated discovery agents: workers and schedulers that scan sources (YouTube, RSS, GitHub, Reddit, HN) for new agentic AI content |
| `@lf-gatewaze-modules/lfid-auth` | LFID authentication via Auth0 — replaces magic link sign-in with LF SSO for portal and admin, with auto-provisioning on event registration |

## Usage

### Option 1: Local Path

If you have this repo cloned locally, add the module source to your `gatewaze.config.ts`:

```typescript
moduleSources: ['../lf-gatewaze-modules/modules'],
```

### Option 2: Git Repository

Point directly at the git repo so Gatewaze clones it automatically (no local checkout needed):

```typescript
moduleSources: [
  'https://github.com/gatewaze/lf-gatewaze-modules.git#path=modules',
],
```

You can also pin to a specific branch or tag:

```typescript
moduleSources: [
  'https://github.com/gatewaze/lf-gatewaze-modules.git#path=modules&branch=v1.0',
],
```

Or use the object format for full control:

```typescript
moduleSources: [
  {
    url: 'https://github.com/gatewaze/lf-gatewaze-modules.git',
    path: 'modules',
    branch: 'main',
  },
],
```

Git sources are shallow-cloned to `.gatewaze-modules/` in your project root and updated on subsequent builds.

### Option 3: Gatewaze Admin UI

You can also add this module source directly from the admin interface:

1. Navigate to **Admin → Modules** (`/admin/modules`)
2. Click **"Add Source"**
3. Enter the repository URL: `https://github.com/gatewaze/lf-gatewaze-modules.git`
4. Set **Subdirectory** to `modules`
5. Optionally set a **Branch** (defaults to `main`)
6. Click **Save**

The modules will appear in the module list. Use the **Enable/Disable** toggle on each module card to activate them. Enabling a module triggers reconciliation, which applies any pending database migrations and runs lifecycle hooks.

Sources added via the admin UI are stored in the database and can be managed dynamically without editing config files. They can also be removed from the UI, unlike sources defined in `gatewaze.config.ts`.

### Auto-Discovery

In all cases, the modules are auto-discovered by the Gatewaze module loader.

