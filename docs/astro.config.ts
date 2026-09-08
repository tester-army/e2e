import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import vercel from '@astrojs/vercel';
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import starlightLinksValidator from 'starlight-links-validator';
import { testerArmyCodeTheme } from './src/code-theme';

// The public origin of the site. Set DOCS_SITE where the site is built; on
// Vercel the production URL is picked up automatically.
const site =
  process.env.DOCS_SITE ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined);

export default defineConfig({
  site,
  // Static output; the adapter turns `redirects` into real 301s on Vercel.
  adapter: vercel(),
  // Pages keep the slugs the Fern site published, and the redirects below keep
  // the URLs it used to answer.
  redirects: {
    '/introduction': '/',
    '/web': '/reference/app-web',
    '/running-tests': '/reference/cli',
    '/configuration': '/reference/config',
    '/from-playwright': '/writing-tests',
    '/troubleshooting': '/reference/errors',
    '/writing-a-driver': '/writing-an-engine',
    '/writing-a-backend': '/writing-an-engine',
    '/reference/backend': '/reference/engine',
  },
  integrations: [
    starlight({
      title: 'e2e',
      description: 'An open framework for agentic end-to-end testing.',
      logo: { src: './src/logo.png', alt: '' },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tester-army/e2e' }],
      editLink: { baseUrl: 'https://github.com/tester-army/e2e/edit/main/docs/' },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/custom.css',
      ],
      components: {
        PageTitle: './src/components/PageTitle.astro',
      },
      expressiveCode: {
        // One dark theme in both color schemes, the way code renders on tester.army.
        themes: [new ExpressiveCodeTheme(testerArmyCodeTheme)],
        useStarlightDarkModeSwitch: false,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '0',
          borderColor: 'var(--sl-color-hairline-light)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: 'var(--sl-text-code)',
          frames: {
            frameBoxShadowCssValue: 'none',
            editorActiveTabIndicatorTopColor: 'var(--ta-orange-300)',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBarBackground: 'rgb(30 30 30)',
            editorActiveTabBackground: '#1a1a1a',
            editorActiveTabForeground: 'rgb(249 248 247)',
            editorTabBarBorderBottomColor: 'rgb(78 78 78)',
            terminalTitlebarBackground: 'rgb(30 30 30)',
            terminalTitlebarBorderBottomColor: 'rgb(78 78 78)',
            terminalBackground: '#1a1a1a',
            inlineButtonBorderOpacity: '0',
          },
        },
      },
      sidebar: [
        {
          label: 'Get started',
          items: [{ label: 'Introduction', link: '/' }, 'quickstart', 'writing-tests', 'agents'],
        },
        {
          label: 'Guides',
          items: ['authentication', 'ci', 'coding-agents'],
        },
        {
          label: 'Extend',
          items: ['writing-an-engine'],
        },
        {
          label: 'Reference',
          items: [
            'reference/test',
            'reference/expect',
            'reference/screen',
            'reference/app-web',
            'reference/device',
            'reference/agent',
            'reference/config',
            'reference/cli',
            'reference/embedding',
            'reference/errors',
            'reference/engine',
          ],
        },
      ],
      plugins: [starlightLinksValidator()],
    }),
  ],
});
