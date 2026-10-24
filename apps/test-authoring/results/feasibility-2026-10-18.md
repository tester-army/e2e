# Harder baseline feasibility check

The twelve-session baseline check did not admit a sixty-run comparison. The official decision is `unresolved`. Three sessions hit the token cutoff, and none of the twelve produced a qualifying miss. Production authoring guidance remains unchanged.

## Fixed cohort

The study used six complete products, with two fresh baseline sessions per product. Checkout, adjacent bookings, cancellation capacity, and dependent postal validation were informative families. Versioned cancellation policy and saved preferences were safeguards. Every author received the current installed skill, the same organic task, the complete product contract, app source, and lower tests. Authors could inspect lower tests voluntarily. No inspection instruction or treatment arm was added.

| Fixture | Scheduled | Returned tests | Correct-app valid | Known within budget | Changed-app failures among valid submissions | Qualifying misses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Checkout | 2 | 2 | 2 | 2 | 2 | 0 |
| Adjacent bookings | 2 | 2 | 2 | 2 | 2 | 0 |
| Cancellation capacity | 2 | 1 | 1 | 1 | 1 | 0 |
| Dependent postal validation | 2 | 2 | 2 | 2 | 2 | 0 |
| Versioned cancellation policy | 2 | 1 | 1 | 1 | 1 | 0 |
| Saved preferences | 2 | 2 | 1 | 1 | 1 | 0 |
| Total | 12 | 10 | 9 | 9 | 9 | 0 |

Admission required valid correct-app execution and known budget compliance in all twelve slots. It also required at least one qualifying miss in each of at least two informative families. A qualifying miss passes both app versions with matching nonempty selection and known compliance. Missing tests, invalid tests, unknown usage, unrelated failures, and safeguard misses cannot establish headroom.

All nine valid submissions passed the correct app and failed the changed app. The remaining saved-preferences submission failed both apps because it asserted overview content while the app showed Settings. Its author had been interrupted by the budget cutoff. The other two cutoff sessions returned no test. All twelve first attempts remain in the denominator. No author was retried, resumed, or repaired after export.

The grader selected and executed 43 test cases per app version across the ten returned files. It used exact returned bytes, fresh app copies, matching selection, one worker, zero retries, cache off, and no runtime model calls. The nine valid files contained forty cases. A changed-app failure alone is not an attributed detection.

## Reading and attribution

An external audit inspected all twelve captured author transcripts and matched substantive lower-test assertion lines against actual tool outputs. No session exposed a lower-test source body in those outputs, and no author command executed the lower-test suite. File listings, package metadata, app implementation reads, and self-reported inspection received no source-reading credit. This analysis does not add a transcript parser to the package.

One blinded `gpt-6-luna@xhigh` reviewer assessed the ten authored packets mixed with thirty-six controls. It attributed all nine valid changed-app failures to the intended defects and did not credit the invalid preferences submission. All six positive controls earned credit and all thirty negative controls earned none. The primary AI inspection of all ten returned tests and their assertion errors agreed. This small calibration set does not establish general reviewer accuracy.

Those decisions produce nine provisional detections out of twelve scheduled sessions. They are exploratory AI attribution. Human attribution remains pending for all nine valid changed-app failures, and the official summary contains zero accepted human-reviewed detections. No AI decisions enter the official human-judgment records.

## Conditions and operational limits

The cohort ran on 2026-10-18 using `gpt-6.1-sol@high`, Codex 0.159.2, Node 24.19.0, and the built E2E 0.21.2 and web engine 0.15.2. Each session had the same limits of 32 completed model responses, 400,000 reported input-plus-output tokens including cached input, and 600 authoring seconds. Seed 42 fixed the shuffled sequential order. The launcher enforced the token limit after completed responses, so observed overshoot was retained.

The frozen implementation corresponds to `8ee006fdbab32b07885c0fa59c3452b0ffba6f19`. Preparation recorded the preceding source revision plus its worktree content hash. A later test-helper-only repair changed no fixture, task, runtime, launcher, protocol, or grading input. The admission record binds that distinction and the frozen corpus, controls, settings, task, skill, launcher, and runtime hashes. No measured input or admission criterion changed after authoring began.

Nine sessions have complete, reconciled usage. Together they consumed 64 completed responses and 1,792,167 reported tokens. Their authoring times ranged from 68.90 to 167.05 seconds. The three interrupted sessions retain unknown final response and token totals. Their completed-response lower bounds were 432,702, 435,668, and 428,202 tokens. Those lower bounds explain why the launcher stopped them; they do not replace missing final usage. These token counts include repeated and cached input and are not monetary cost estimates.

The external Darwin boundary allowed each project's contents, named public runtime files, project writes, and loopback networking. It blocked operator files and sibling projects in the checked content-open probes. Public metadata and default process/Mach operations remained available. This was an operational restriction, not an adversarial sandbox certification.

The environment was incomplete for some ordinary authoring choices. `rg` was unavailable. All three cutoff sessions chose MCP exploration and encountered closed stdin, denied pseudo-terminal creation, denied heredoc temporary files, and Python library-loading failures. They then used Node bridges to interact with the app. These observations identify environment friction; they do not isolate how much each failure contributed to consumption or prove that larger budgets would help. The preflight verified a model-authored browser test and boundary access, but did not expose these interactive MCP paths.

Before admission, all thirty-six synthetic controls passed their mechanical checks. Six strong controls passed the correct app and reached the expected changed-app assertion. Six meaningful weaker journeys passed both versions with matching selection. Twenty-four negative controls received no detection credit. Lower tests passed on both versions of every fixture. A supplementary Harbor reload probe timed out once at the pinned assertion limit, then the same bytes and the complete supplementary set passed. Its cause remains unconfirmed. No timeout or budget was relaxed for this cohort.

## Decision for the draft PR

Keep the fixtures and fixed-study machinery as evaluation work. Do not start the sixty-run comparison or promote the inspection instruction. This baseline-only check cannot estimate an instruction effect. Nine valid submissions all failing the changed app gives no observed qualifying headroom, while the three cutoff sessions prevent a complete feasibility verdict.

A new proposal should first verify the ordinary CLI and MCP workflows inside the authoring boundary. It should then justify cases where realistic test selection leaves useful uncovered behavior despite complete current requirements. More complicated fixture code alone did not demonstrate that here. Any environment, task, scenario, or budget changes require a newly frozen study, with fresh first attempts and an explicit decision before spending another comparison cohort.

The contributor retains exact outputs, transcripts, raw usage events, grades, all 46 mixed review packets, sealed inputs, and the decision trail outside the repository. This document publishes aggregate observations. Those aggregates alone cannot reproduce or independently audit the historical live capture. The committed commands can prepare a new externally launched study; they do not replay the original author sessions.
