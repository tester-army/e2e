// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Account created",
        "role": "text"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 14651,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Create your benchmark account",
        "role": "text"
      },
      {
        "name": "First name",
        "role": "text"
      },
      {
        "name": "Last name",
        "role": "text"
      },
      {
        "name": "Email address",
        "role": "text"
      },
      {
        "name": "Set password",
        "role": "text"
      },
      {
        "name": "Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multiple pages, matching the production app this scenario was distilled from.",
        "role": "text"
      },
      {
        "name": "CREATE ACCOUNT",
        "role": "text"
      },
      {
        "name": "More filler content below the primary action: support links, privacy policy, and terms and conditions would normally live here. It pads the scroll extent so off-screen estimation has something to measure.",
        "role": "text"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "e18e9835187bab993e11f2dd7ff5624429bc26890c846accacf0057b525e92a0",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "android",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "99f3046e1cffa27d71f282e7a46fd975917dcd9e39992518bc6fc19c46f414ac",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Registration%20Form"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Filled the registration form with Ada Lovelace, ada@example.com, and the requested password, then submitted it. The screen confirms “Account created.”"
  },
  [
    replay.type({
      "summary": "type \"Ada\" into textbox in \"Create your benchmark account\" (1 of 3)",
      "target": {
        "position": {
          "index": 0,
          "of": 3
        },
        "role": "textbox",
        "within": "Create your benchmark account"
      },
      "value": "Ada"
    }),
    replay.type({
      "summary": "type \"Lovelace\" into textbox in \"Create your benchmark account\" (1 of 2)",
      "target": {
        "position": {
          "index": 0,
          "of": 2
        },
        "role": "textbox",
        "within": "Create your benchmark account"
      },
      "value": "Lovelace"
    }),
    replay.type({
      "summary": "type \"ada@example.com\" into textbox in \"Create your benchmark account\" (1 of 1)",
      "target": {
        "position": {
          "index": 0,
          "of": 1
        },
        "role": "textbox",
        "within": "Create your benchmark account"
      },
      "value": "ada@example.com"
    }),
    replay.type({
      "summary": "type \"Lovelace1815\" into textbox in \"Create your benchmark account\" (1 of 1)",
      "target": {
        "inputPurpose": "password",
        "position": {
          "index": 0,
          "of": 1
        },
        "role": "textbox",
        "within": "Create your benchmark account"
      },
      "value": "Lovelace1815"
    }),
    replay.tap({
      "summary": "tap group \"CREATE ACCOUNT\" in \"Create your benchmark account\"",
      "target": {
        "name": "CREATE ACCOUNT",
        "role": "group",
        "within": "Create your benchmark account"
      }
    }),
  ],
);
