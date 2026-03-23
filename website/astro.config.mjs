// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://spawnfile.ai',
  integrations: [
    sitemap(),
    starlight({
      title: 'Spawnfile',
      description: 'A fully open-source spec and compiler for autonomous agents and teams.',
      components: {
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/noopolis/spawnfile' },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Core Concepts', slug: 'concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Writing a Spawnfile', slug: 'guides/writing-a-spawnfile' },
            { label: 'Agent Docs', slug: 'guides/agent-docs' },
            { label: 'Skills & MCP', slug: 'guides/skills-and-mcp' },
            { label: 'Teams', slug: 'guides/teams' },
            { label: 'Compiling', slug: 'guides/compiling' },
            { label: 'Docker Packaging', slug: 'guides/docker' },
          ],
        },
        {
          label: 'Runtimes',
          items: [
            { label: 'Overview', slug: 'runtimes/overview' },
            { label: 'OpenClaw', slug: 'runtimes/openclaw' },
            { label: 'PicoClaw', slug: 'runtimes/picoclaw' },
            { label: 'TinyClaw', slug: 'runtimes/tinyclaw' },
            { label: 'NullClaw', slug: 'runtimes/nullclaw' },
            { label: 'ZeroClaw', slug: 'runtimes/zeroclaw' },
          ],
        },
        {
          label: 'Specification',
          items: [
            { label: 'SPEC.md', slug: 'spec/spec' },
            { label: 'COMPILER.md', slug: 'spec/compiler' },
            { label: 'CONTAINERS.md', slug: 'spec/containers' },
            { label: 'RUNTIMES.md', slug: 'spec/runtimes' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'How to Contribute', slug: 'contributing/how-to-contribute' },
            { label: 'Adding a Runtime', slug: 'contributing/adding-a-runtime' },
          ],
        },
      ],
    }),
  ],
});
