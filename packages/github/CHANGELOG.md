# @e2e-dev/github

## 0.3.3

### Patch Changes

- [#713](https://github.com/tester-army/e2e/pull/713) [`7ab80bc`](https://github.com/tester-army/e2e/commit/7ab80bc61001dd102006ea020419b74b72ddf0c7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: an interrupted test is no longer counted as failed. `report.json` gains `run.summary.interrupted`, and `run.summary.failed` counts only failed and timed-out tests. `run.summary.skipped` now counts only selected tests, so `passed + failed + interrupted + flaky + skipped` equals `selected`; the tests a filter left out are `discovered - selected`. The `list` reporter prints `3 interrupted` in its own column, `summary.md` shows them with ⏹️ and gives them no failure block or page, and `junit.xml` writes each one as a `<skipped>` whose message starts `interrupted:`. A test that failed and whose retry an interrupt cut short stays failed, and its failure is the one reported. A `--repeat-each` run the interrupt stopped is listed as interrupted, not as a flake. The telemetry event gains `tests_interrupted`. In `@e2e-dev/github`, a test that was interrupted and then passed on a `--last-failed` rerun shows as passed, not flaky.

- [#724](https://github.com/tester-army/e2e/pull/724) [`3a9667c`](https://github.com/tester-army/e2e/commit/3a9667c0467f464bf542c50380d3468b0c222b17) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `--last-failed` no longer goes green on tests it never ran. It reruns tests `--max-failures` skipped, and a test or failed `beforeAll`/`afterAll` another filter leaves out stays owed in the report's new `run.carried` until a rerun runs it. A rerun also keeps the artifacts of the run it reruns and writes its own under `artifacts/rerun-<n>/` in the output directory (`.e2e` by default), so the folded pull request comment keeps its evidence and stays red while anything is owed.

## 0.3.2

### Patch Changes

- [#720](https://github.com/tester-army/e2e/pull/720) [`62bfe0a`](https://github.com/tester-army/e2e/commit/62bfe0a896a50f501f071d31c8935e0e0bdabfcf) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Two matrix jobs whose `key`, workflow, or job differ only after the first 200 encoded characters now keep their own pull request comments instead of overwriting one. A long field's marker ends in a digest of the whole value; markers of shorter fields are unchanged, so existing comments are still found. A job with a field that long posts one new comment after upgrading and leaves its old one behind. The reporter only takes a comment whose first line is its marker, so a reply quoting the marker is never edited.

- [#763](https://github.com/tester-army/e2e/pull/763) [`b573756`](https://github.com/tester-army/e2e/commit/b573756818d7d04088142d29e0e730cfbaf21b45) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Installing `e2e` pulls in 29 packages instead of 117 and takes about 31MB instead of 36MB. `e2e mcp` now runs on the split MCP SDK (`@modelcontextprotocol/server` 2.2.0) in place of `@modelcontextprotocol/sdk`, which brought in express, hono, and the rest of an HTTP server stack that stdio never used. The server keeps the same protocol version, so existing clients connect as before. Packages are built and published without sourcemaps, which pointed at a `src/` that was never shipped. Stack traces show `dist/` positions.

## 0.3.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

## 0.3.0

### Patch Changes

- [#682](https://github.com/tester-army/e2e/pull/682) [`e4fca9d`](https://github.com/tester-army/e2e/commit/e4fca9debd85cc5be2b2df40357e9e071e92595e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `@e2e-dev/github` installs next to a stable `e2e` again. The published builds pinned their `e2e` peer to one canary build, so `npm install` refused to resolve it against a versioned runner.

## 0.3.0-canary-20260928184528

### Minor Changes

- [#602](https://github.com/tester-army/e2e/pull/602) [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engines and the reporter publish under the `@e2e-dev` scope: `@e2edev/web` is `@e2e-dev/web`, `@e2edev/mobile` is `@e2e-dev/mobile`, and `@e2edev/github` is `@e2e-dev/github`. The `@e2edev` packages get no new releases. To move, swap the dependencies (`npm uninstall @e2edev/web && npm install --save-dev @e2e-dev/web`) and rewrite the imports: `from '@e2edev/web'` becomes `from '@e2e-dev/web'`, and the same for `@e2edev/mobile`, `@e2edev/mobile/tools`, and `@e2edev/github`. `e2e init` installs and imports the new names.

### Patch Changes

- [#537](https://github.com/tester-army/e2e/pull/537) [`61603e6`](https://github.com/tester-army/e2e/commit/61603e6c2c103013eee2fe98c72066d59ac9363b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `--last-failed` rerun updates the pull request comment as one run instead of shrinking it to the tests it ran again. The tests the rerun left out keep their results from the run it selected from, a test that failed and then passed shows as flaky with both runs' attempts, a test that failed again stays failed, and the counts cover the whole suite, so `e2e run || e2e run --last-failed` in one step leaves a comment that says what the job's status says.
- Updated dependencies [[`89e2a19`](https://github.com/tester-army/e2e/commit/89e2a19a3932adf0bdbb3c2b2b8df7527f3a3750), [`f9f49f4`](https://github.com/tester-army/e2e/commit/f9f49f41ef521fd712db340ab291afa58e259ec6), [`676a015`](https://github.com/tester-army/e2e/commit/676a0153d88c9fb20d74e06c847e9303e18c4b59), [`8ff15d7`](https://github.com/tester-army/e2e/commit/8ff15d7cb2541490d29d0bb2dc64c2e9bcd1f126), [`786f65d`](https://github.com/tester-army/e2e/commit/786f65d8e4ede28c833717374cea6a23cd1b7164), [`c089fa6`](https://github.com/tester-army/e2e/commit/c089fa6cc21a3de7b925123b3e9fd8cf4165e29a), [`61603e6`](https://github.com/tester-army/e2e/commit/61603e6c2c103013eee2fe98c72066d59ac9363b), [`90356f1`](https://github.com/tester-army/e2e/commit/90356f17fcf515a0f05e4745235f645243acb51d), [`301e71d`](https://github.com/tester-army/e2e/commit/301e71d09be40c9f26c3bc4853d8f70d19b24d66), [`ac3eb57`](https://github.com/tester-army/e2e/commit/ac3eb57477137c5106d84d997745558f86be22ca), [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947), [`c1e9029`](https://github.com/tester-army/e2e/commit/c1e9029fed3ff5d58b147877228132e6a016ae86), [`dceae62`](https://github.com/tester-army/e2e/commit/dceae627300c2746b0a902cb90df75a0e1bb45a9), [`cf59269`](https://github.com/tester-army/e2e/commit/cf592694fea667dc25faaa514f3d65c7e13f63df), [`3e1a568`](https://github.com/tester-army/e2e/commit/3e1a5685b7336915da67ff4ef4cdfdf580f5e2d5), [`75e4145`](https://github.com/tester-army/e2e/commit/75e414536da73a23f37e213aab0a0880cd5869df), [`cb84c13`](https://github.com/tester-army/e2e/commit/cb84c13d8664c9637c19b9b9491cd727a0dfbb80), [`21b43b6`](https://github.com/tester-army/e2e/commit/21b43b6eb819b87d3c31fb5cdea36d10eac575ee), [`299c546`](https://github.com/tester-army/e2e/commit/299c546468a7e4cacc4084cfe0892c161530e333), [`2e96878`](https://github.com/tester-army/e2e/commit/2e968783bf6283d9fd507f06af1b559b323699db), [`a399bac`](https://github.com/tester-army/e2e/commit/a399bac83b927f8c5a58f4906bc25f1b992754ad), [`d0359eb`](https://github.com/tester-army/e2e/commit/d0359ebeef65835771667379c4fa51171fe670bb), [`d6947bc`](https://github.com/tester-army/e2e/commit/d6947bc66dca1d1d51dff20a67198f7929e1dfb5), [`11a286d`](https://github.com/tester-army/e2e/commit/11a286d54fc58ce1fc19d3317aa41122b271a1fd), [`bad98ea`](https://github.com/tester-army/e2e/commit/bad98ea2ebd4ab30fb7408b9b40467ea6a18caa9), [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd), [`d87465b`](https://github.com/tester-army/e2e/commit/d87465b77fe1e04e981e9bddeaddd732c33c9861), [`eaac502`](https://github.com/tester-army/e2e/commit/eaac50292d4f71a0ca267263568be7152170c596), [`cef69d2`](https://github.com/tester-army/e2e/commit/cef69d26095a045d2282c9d43ad1f115e48b11dd)]:
  - e2e@0.15.0-canary-20260928184528

## 0.3.0-canary-20260924194828

### Patch Changes

- [#432](https://github.com/tester-army/e2e/pull/432) [`9614834`](https://github.com/tester-army/e2e/commit/9614834797dfac35ed89515bfa7b9cba82d5686a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The peer range on `e2e` is `>=0.15.0 <1` again instead of the exact version of one runner build, so updating `e2e` alone no longer leaves an unmet peer that npm refuses with ERESOLVE, and a runner release no longer republishes the engines and the reporter.
- Updated dependencies [[`7d93c08`](https://github.com/tester-army/e2e/commit/7d93c085eb7d7c56c4007b870ff7f8b5c644d3d2), [`ed151e0`](https://github.com/tester-army/e2e/commit/ed151e042080371ab47dbbec49aa296011b34370), [`cc691d4`](https://github.com/tester-army/e2e/commit/cc691d472151d423637b3d22d477347644303068), [`66fb1e3`](https://github.com/tester-army/e2e/commit/66fb1e3d369cc5789fc768e4258f63e0b7120e2f), [`2ee94cc`](https://github.com/tester-army/e2e/commit/2ee94cc379779d62ab8e1b64a61852d25929bc93), [`3c52f93`](https://github.com/tester-army/e2e/commit/3c52f93272832892d6b36456df89d638b0bca084), [`8802b0f`](https://github.com/tester-army/e2e/commit/8802b0f0dc85fdd0bcdccc5b4ba6b351000d1769), [`edbb84f`](https://github.com/tester-army/e2e/commit/edbb84f6a1fcc57f6f8f5e7f88155691a96df369), [`ee4929d`](https://github.com/tester-army/e2e/commit/ee4929ddb6aa4de9004efd2e9107157103fd3c2f), [`91cacc9`](https://github.com/tester-army/e2e/commit/91cacc9e9ab6413308e3926885ec452d2e1a8371), [`4314f5f`](https://github.com/tester-army/e2e/commit/4314f5f8869b7d7369f1878b9ff23fd07790eb35), [`1de46ce`](https://github.com/tester-army/e2e/commit/1de46ce08c4943c17e4fdd16b0b18ee7a420307a), [`7ef3553`](https://github.com/tester-army/e2e/commit/7ef3553b67c90d18cafe63e9a496a16344603608), [`881afee`](https://github.com/tester-army/e2e/commit/881afee5c4973988b4811680b642e6ab6b1ec7bb), [`7aa0ffe`](https://github.com/tester-army/e2e/commit/7aa0ffe0b2425a5721bf5cf7a07335b03bd3c5b6), [`943de73`](https://github.com/tester-army/e2e/commit/943de73404259517ea8bdc7c36e6c830cb969142), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`e95135d`](https://github.com/tester-army/e2e/commit/e95135d5124c5008c79bc25b9f3cff8b89688d06), [`18cb9fc`](https://github.com/tester-army/e2e/commit/18cb9fcc3de47c4b49004f834a8d71fcc1f42f11), [`7753859`](https://github.com/tester-army/e2e/commit/77538594af6df0ca03aadd58b25cd090645f2a92), [`cdc4109`](https://github.com/tester-army/e2e/commit/cdc41098c7d3f5ba92705a87f758e470e859a559), [`e2b5570`](https://github.com/tester-army/e2e/commit/e2b557074ff4f18aa437fae351ac0ced6f02f53a), [`0dcf6a4`](https://github.com/tester-army/e2e/commit/0dcf6a492722b2e275c2f6b943ba728e5abd8dac), [`c975fb2`](https://github.com/tester-army/e2e/commit/c975fb26cc92bae4f42e4f26bc7f92d8a2df562e), [`1cb0c73`](https://github.com/tester-army/e2e/commit/1cb0c73c9ff846b5fef115a6bd3b805c0a540410), [`fa41517`](https://github.com/tester-army/e2e/commit/fa415178000d435fb97b6f07b9e1f0feb7743019), [`9c847ba`](https://github.com/tester-army/e2e/commit/9c847ba3e6f69ddbf84d39add17b7d993aadeb59), [`3bbcc96`](https://github.com/tester-army/e2e/commit/3bbcc968dddd1499db30b9a99ab949920cf98f74), [`6efc77d`](https://github.com/tester-army/e2e/commit/6efc77da5e4ca69468b5ce1b4eb6ac625d5c7c63), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`a0df697`](https://github.com/tester-army/e2e/commit/a0df69790679e02d7011dbaa3932028bac90b226), [`a9f8256`](https://github.com/tester-army/e2e/commit/a9f8256b800160eb88e6bb6efb69f767f9e2b000), [`cc23e51`](https://github.com/tester-army/e2e/commit/cc23e5142ec02dbecfbf555aa0d76e16c430c49a), [`5aaac75`](https://github.com/tester-army/e2e/commit/5aaac751f64141eb9fc80114ba945703ebc8709c), [`778fccc`](https://github.com/tester-army/e2e/commit/778fcccdfee595505b7905488aab9e3ff7067470), [`4305718`](https://github.com/tester-army/e2e/commit/4305718f1b43d362349698aaa28bac47d3e41271), [`33044a7`](https://github.com/tester-army/e2e/commit/33044a70e785ab94c77f01fff525648891a3e8b9)]:
  - e2e@0.15.0-canary-20260924194828

## 0.3.0-canary-20260922161512

### Patch Changes

- [#422](https://github.com/tester-army/e2e/pull/422) [`b71ecc0`](https://github.com/tester-army/e2e/commit/b71ecc0f09bd49801c2f4ff27a8822de846e7c3e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Source links in the pull request comment resolve for a project below the checkout root. The report's files are relative to the project root, so a suite in `packages/e2e-tests` linked to `blob/<sha>/tests/...` and 404ed; the link now carries the project's path inside `GITHUB_WORKSPACE`.
  
  Evidence links open the run page's Artifacts section (`actions/runs/<id>#artifacts`) and the page names each file's path inside the upload, so a reader finds the screenshot or trace in the downloaded artifact instead of landing on the run page.
- Updated dependencies [[`707c894`](https://github.com/tester-army/e2e/commit/707c8942fd13a9f67d0212c340c662ad152971d0), [`b71ecc0`](https://github.com/tester-army/e2e/commit/b71ecc0f09bd49801c2f4ff27a8822de846e7c3e)]:
  - e2e@0.15.0-canary-20260922161512

## 0.3.0-canary-20260922135036

### Patch Changes

- Updated dependencies [[`eb739e9`](https://github.com/tester-army/e2e/commit/eb739e930d533db36206d622c960d18a1ba965e7), [`4c93414`](https://github.com/tester-army/e2e/commit/4c934142bc4ef4002811eff2be20d463343dd381), [`a577da3`](https://github.com/tester-army/e2e/commit/a577da3199c42402dfb9a04cd8452c5d89ab40dc), [`a583a88`](https://github.com/tester-army/e2e/commit/a583a88254cd80450f986174b022cf961442e7f0), [`0f864ad`](https://github.com/tester-army/e2e/commit/0f864ad3f3e7f5242ed957941e58e55e1a818aee), [`2b9361f`](https://github.com/tester-army/e2e/commit/2b9361ffea8e39d2c32a5b1e2a6a98c2da759380), [`2e4d40e`](https://github.com/tester-army/e2e/commit/2e4d40eb0754f2558e5e89fe80b4b4933183d023), [`0e525a0`](https://github.com/tester-army/e2e/commit/0e525a09dd2b8287280b1ede81a06d32dcb7f1d3), [`f01c01f`](https://github.com/tester-army/e2e/commit/f01c01fbe3a73f2e9380a7db2e62718517ab2e6b), [`d043035`](https://github.com/tester-army/e2e/commit/d04303523652b264b02af82d200f7cc726c044b3), [`dcfe53a`](https://github.com/tester-army/e2e/commit/dcfe53a4b0e4c70b5f9a01f980c6dffea021f8c9), [`ae930bb`](https://github.com/tester-army/e2e/commit/ae930bbf9a6d3793ad9f96e0efb2e8c36cb7665a), [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844)]:
  - e2e@0.15.0-canary-20260922135036

## 0.3.0-canary-20260921180210

### Patch Changes

- Updated dependencies [[`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08), [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98), [`2e18196`](https://github.com/tester-army/e2e/commit/2e18196b79ac724c2a274a27562ea06d7a316d02), [`9f2b73f`](https://github.com/tester-army/e2e/commit/9f2b73f9293d4cdee449bb04e4f8272477d22402), [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8)]:
  - e2e@0.15.0-canary-20260921180210

## 0.3.0-canary-20260921154506

### Patch Changes

- [#373](https://github.com/tester-army/e2e/pull/373) [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Relicense from MIT to Apache-2.0. The package ships the license text and a `NOTICE` file.
- Updated dependencies [[`45c08b1`](https://github.com/tester-army/e2e/commit/45c08b123e52369257433da2e133a84f2d6bdfa7), [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690), [`d438348`](https://github.com/tester-army/e2e/commit/d438348fda96a512cc03b51c41f1140353030003), [`b9abd60`](https://github.com/tester-army/e2e/commit/b9abd60c435935fc96816249f48315885d8ac85f), [`c1d23b2`](https://github.com/tester-army/e2e/commit/c1d23b230b8c8502f551e869710ed26f606a7469), [`ea27708`](https://github.com/tester-army/e2e/commit/ea2770804fe55857d105224355eef7b45453d665), [`195bd0d`](https://github.com/tester-army/e2e/commit/195bd0d14cc3f32440bfa140ed468dfa705d851d), [`da6b939`](https://github.com/tester-army/e2e/commit/da6b939e4c306b5dba64088599961a666f680c9a), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`f09b69e`](https://github.com/tester-army/e2e/commit/f09b69e90a8f76172ba5e5e006e7ec10dd99c172), [`f3d61e8`](https://github.com/tester-army/e2e/commit/f3d61e8ce7a8ab9a40090ecd72c9f43557a12492), [`d746ce4`](https://github.com/tester-army/e2e/commit/d746ce4b3f568c00ac736c116a561ef4e4dc67df), [`d7d843a`](https://github.com/tester-army/e2e/commit/d7d843af9d241246d225795b7d2439cb98a27a8a), [`bd2a9a6`](https://github.com/tester-army/e2e/commit/bd2a9a6db7c23193be6a914f961c3fb178074d59), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`e9c2914`](https://github.com/tester-army/e2e/commit/e9c2914c6d8f8d664d820b13a1fa454e9247e94b), [`91dcd30`](https://github.com/tester-army/e2e/commit/91dcd30b535331d89d197f6c5f3e8ae984e92960), [`ddf9747`](https://github.com/tester-army/e2e/commit/ddf97479d734b294f826b01b206e3b49cb7822bf), [`9fbba0b`](https://github.com/tester-army/e2e/commit/9fbba0b34c4f6a387d62914d35fc756b84ba7f8e)]:
  - e2e@0.15.0-canary-20260921154506

## 0.3.0-canary-20260917213813

### Patch Changes

- Updated dependencies [[`ba8d9ba`](https://github.com/tester-army/e2e/commit/ba8d9ba81de2879cbf216afaba0a0fe2a638cf11), [`15081f3`](https://github.com/tester-army/e2e/commit/15081f306837ebe1040fbcb2e63bd2efe283faaa), [`b558e78`](https://github.com/tester-army/e2e/commit/b558e78ba3b21cb86b20cc26bdd18aea08aa8a17), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac), [`ed3999e`](https://github.com/tester-army/e2e/commit/ed3999e8931693f02a1a6e1737315fcea60f341b), [`95b3d7f`](https://github.com/tester-army/e2e/commit/95b3d7f41946bdf35d5865d9619e92f16e625866), [`99f9ea8`](https://github.com/tester-army/e2e/commit/99f9ea81cf3d40d4eb7966b9a98cdea9c2df1745)]:
  - e2e@0.15.0-canary-20260917213813

## 0.3.0-canary-20260917081546

### Minor Changes

- [#310](https://github.com/tester-army/e2e/pull/310) [`4c76360`](https://github.com/tester-army/e2e/commit/4c76360cb65b20c5193240b0e5a0489bd7e0c558) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The reporter's `key` also names the comment in its headline (`e2e chromium: 77 passed`), so two jobs posting to one pull request read apart. The comment itself takes the new page layout from `e2e`: no file table, flaky tests folded, one line of small print.

### Patch Changes

- Updated dependencies [[`0a4b7f4`](https://github.com/tester-army/e2e/commit/0a4b7f4fe9f3b316907ce896d21153a918f853e8), [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004), [`1c9cc16`](https://github.com/tester-army/e2e/commit/1c9cc16697cb82c0a6db924f6c0f389886b2a468), [`9c835ba`](https://github.com/tester-army/e2e/commit/9c835ba64e866a8e87c1bcddc04376939edca74c), [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868), [`9249de2`](https://github.com/tester-army/e2e/commit/9249de20eea96fccc5b24e3747f36708eaf8edb8), [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90), [`3524a59`](https://github.com/tester-army/e2e/commit/3524a59290da01a1adf28d83272eb5ecf0219c40), [`6016083`](https://github.com/tester-army/e2e/commit/60160830154972d31e81b10ddc90f6c63776a470), [`4c76360`](https://github.com/tester-army/e2e/commit/4c76360cb65b20c5193240b0e5a0489bd7e0c558), [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac)]:
  - e2e@0.15.0-canary-20260917081546

## 0.3.0-canary-20260914134810

### Patch Changes

- Updated dependencies [[`5908a10`](https://github.com/tester-army/e2e/commit/5908a107f97d6f3845ed75c5676cc514b6f03dcd)]:
  - e2e@0.15.0-canary-20260914134810

## 0.3.0-canary-20260914095510

### Patch Changes

- Updated dependencies [[`f2f2e6f`](https://github.com/tester-army/e2e/commit/f2f2e6fb1024ffb4cd481f7ea571c2d29be6d6d8), [`ec3b6a1`](https://github.com/tester-army/e2e/commit/ec3b6a145a9e1a58bc70227ba4e868d7c9e3c3e5)]:
  - e2e@0.15.0-canary-20260914095510

## 0.3.0-canary-20260914081513

### Minor Changes

- [#294](https://github.com/tester-army/e2e/pull/294) [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.

### Patch Changes

- [#293](https://github.com/tester-army/e2e/pull/293) [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publishes as a public package, like the rest of the `@e2edev` scope.
- Updated dependencies [[`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755), [`aa3b05b`](https://github.com/tester-army/e2e/commit/aa3b05bbbdd4534ef111e51b950002513998076f), [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b), [`d486e40`](https://github.com/tester-army/e2e/commit/d486e40e73bfe23ac70a99f7938f05db0ba4e30c), [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c), [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59)]:
  - e2e@0.15.0-canary-20260914081513

## 0.2.0

### Minor Changes

- [#284](https://github.com/tester-army/e2e/pull/284) [`8811ba7`](https://github.com/tester-army/e2e/commit/8811ba7de97b239f8d1a32fb0785ff00d7f0011e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A built-in `markdown` reporter writes the run as one markdown page,
  `.e2e/summary.md` beside `report.json`, laid out for a pull request: a
  headline with the counts and, when the agent ran, what the run spent (agent
  steps, cache replays, model calls, tokens, cost); run-level errors; one block
  per test that failed or was flaky with its error, the step it went wrong at,
  the agent's own explanation of what it saw, the attempt's step timeline, and
  the paths of its evidence from the project root; a table with one row per
  test file; and every test folded away, grouped by file. An `e2e explore` run
  renders its record instead: the goal and steps, every finding with what was
  expected, what the screen showed, the actions that reach it, and its
  screenshot, then the assessment. It is the text a coding agent pastes into a
  pull request or a handoff instead of retelling the result.
  `renderMarkdownReport(report, { artifactsUrl, artifactsDir, sourceUrl })` is
  exported from the main entrypoint for a reporter that posts the page
  elsewhere. `@e2edev/github` posts this page as the pull request comment in
  place of its one table of tests that did not pass; its `renderComment`,
  `CommentOptions`, `MAX_MARKER_CHARS`, and `MAX_URL_CHARS` exports are gone
  (nothing consumed them), and the package now needs `@e2edev/e2e` 0.13 or
  later. `e2e init` ignores `.e2e/summary.md`.

## 0.1.0

### Minor Changes

- [#246](https://github.com/tester-army/e2e/pull/246) [`a0a4df0`](https://github.com/tester-army/e2e/commit/a0a4df01b463dd6117d44e0844a81880f7a4abdb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The GitHub reporter. `reporters: ['list', github()]` posts one pull request
  comment per run from GitHub Actions and keeps it current across reruns: the
  counts, the run-level errors, one row per test that did not simply pass with
  its error and the evidence it left, the passed tests folded away, links to
  each test's source at the PR head and to the workflow run where the artifacts
  are. The same text goes to the job summary, pull request or not. It reads
  `GITHUB_TOKEN` (or `GH_TOKEN`) and the event when the run finishes; `key`
  tells matrix replicas' comments apart. Off
  GitHub Actions, on a push, or without a token it posts nothing and says so in
  one summary row. `renderComment` is exported so another host can render the
  same comment from a report-1 document.
