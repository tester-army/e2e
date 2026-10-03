# @e2e-dev/testmuai

[TestMu AI](https://www.lambdatest.com) hosted browsers for [`e2e`](https://www.npmjs.com/package/e2e):
`web({ browser: testmuai() })` runs a web target in TestMu AI's hosted
Chrome and Edge on Windows and macOS.

## Install

```bash
npm install --save-dev @e2e-dev/testmuai
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { testmuai } from '@e2e-dev/testmuai';

export default {
  targets: [
    {
      name: 'testmuai',
      engine: web({ browser: testmuai({ platform: 'Windows 11' }), viewport: null }),
      app: { url: 'https://staging.example.com' },
    },
  ],
} satisfies E2EConfig;
```

Set `LT_USERNAME` and `LT_ACCESS_KEY` in the environment `e2e run` starts in.
To get them, [sign up for TestMu AI](https://accounts.lambdatest.com/register)
or log in to your account, then copy your username and access key from
**Account Settings → Password & Security → Username and Access Key**
([accounts.lambdatest.com/security/username-accesskey](https://accounts.lambdatest.com/security/username-accesskey)).

The [TestMu AI integration page](https://e2e.tester.army/docs/integrations/testmuai)
covers the options, scopes, routes, recordings, and downloads.
