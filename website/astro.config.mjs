// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://spawnfile.com',
  integrations: [
    sitemap(),
    starlight({
      title: 'Spawnfile',
      description: 'Declare an AI agent team once, compile it for OpenClaw, PicoClaw and Daimon, run it in Docker on your subscriptions, and train its agents in place.',
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/noopolis/spawnfile' },
      ],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400..700&display=swap' },
        },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#08090a' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://spawnfile.com/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://spawnfile.com/og.png' } },
        { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' } },
        {
          tag: 'script',
          attrs: { async: true, src: 'https://www.googletagmanager.com/gtag/js?id=G-8ZM3Y7MCD5' },
        },
        {
          tag: 'script',
          content: "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-8ZM3Y7MCD5');",
        },
      ],
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        themes: ['github-dark'],
        styleOverrides: {
          borderRadius: '10px',
          borderColor: '#2b3036',
          codeBackground: '#050607',
          codeFontFamily: '"Geist Mono", ui-monospace, monospace',
          uiFontFamily: '"Geist Mono", ui-monospace, monospace',
          frames: {
            editorTabBarBackground: '#0e1012',
            editorActiveTabBackground: '#050607',
            editorActiveTabIndicatorTopColor: '#4f8cff',
            terminalTitlebarBackground: '#0e1012',
            terminalBackground: '#050607',
            frameBoxShadowCssValue: 'none',
            inlineButtonBorder: '#2b3036',
          },
        },
      },
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
            { label: 'Training', slug: 'guides/training' },
            { label: 'Release Images in CI', slug: 'guides/ci-release' },
            { label: 'Status', slug: 'guides/status' },
            { label: 'Releasing', slug: 'guides/release' },
            { label: 'Distribution', slug: 'guides/distribution' },
          ],
        },
        {
          label: 'Runtimes',
          items: [
            { label: 'Overview', slug: 'runtimes/overview' },
            { label: 'Daimon', slug: 'runtimes/daimon' },
            { label: 'OpenClaw', slug: 'runtimes/openclaw' },
            { label: 'PicoClaw', slug: 'runtimes/picoclaw' },
          ],
        },
        {
          label: 'Specification',
          items: [
            { label: 'Source format', slug: 'spec/spec' },
            { label: 'Compiler', slug: 'spec/compiler' },
            { label: 'Containers', slug: 'spec/containers' },
            { label: 'Surfaces', slug: 'spec/surfaces' },
            { label: 'Runtimes', slug: 'spec/runtimes' },
            { label: 'Status', slug: 'spec/status' },
            { label: 'Distribution', slug: 'spec/distribution' },
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
