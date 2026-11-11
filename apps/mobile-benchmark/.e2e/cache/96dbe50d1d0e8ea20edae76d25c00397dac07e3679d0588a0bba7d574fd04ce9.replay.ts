// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Account created",
        "role": "other"
      }
    ],
    "endPath": "dev.e2e.benchmark / Flattened Registration Form",
    "endWaitMs": 14948,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Vertical scroll bar, 2 pages",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Horizontal scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Vertical scroll bar, 2 pages",
        "role": "other"
      },
      {
        "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
        "role": "other"
      },
      {
        "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
        "role": "scroll-view"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "873e96a3c0364ffd8e603a0fb9ccef7bb32dd2c64eb8bddaa76d36fdfbf446ae",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "ios",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "99f3046e1cffa27d71f282e7a46fd975917dcd9e39992518bc6fc19c46f414ac",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Registration%20Form"
    },
    "startPath": "dev.e2e.benchmark / Flattened Registration Form",
    "summary": "Filled the registration form with Ada Lovelace, ada@example.com, and the requested password; dismissed the system password-save prompt. The screen now displays “Account created.”"
  },
  [
    replay.tapAt({
      "point": {
        "x": 191,
        "y": 227
      },
      "summary": "tap the point (191, 227) on other \"Create your benchmark account, First na…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4751,
        "fy": 0.1464,
        "target": {
          "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
          "role": "other"
        }
      }
    }),
    replay.typeText({
      "replace": false,
      "summary": "type \"Ada\" into the focused field",
      "value": "Ada"
    }),
    replay.tapAt({
      "point": {
        "x": 199,
        "y": 310
      },
      "summary": "tap the point (199, 310) on other \"Create your benchmark account, First na…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.495,
        "fy": 0.2559,
        "target": {
          "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
          "role": "other"
        }
      }
    }),
    replay.typeText({
      "replace": false,
      "summary": "type \"Lovelace\" into the focused field",
      "value": "Lovelace"
    }),
    replay.tapAt({
      "point": {
        "x": 186,
        "y": 396
      },
      "summary": "tap the point (186, 396) on other \"Create your benchmark account, First na…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4627,
        "fy": 0.3694,
        "target": {
          "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
          "role": "other"
        }
      }
    }),
    replay.typeText({
      "replace": false,
      "summary": "type \"ada@example.com\" into the focused field",
      "value": "ada@example.com"
    }),
    replay.tapAt({
      "point": {
        "x": 198,
        "y": 478
      },
      "summary": "tap the point (198, 478) on other \"Create your benchmark account, First na…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4925,
        "fy": 0.4776,
        "target": {
          "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
          "role": "other"
        }
      }
    }),
    replay.typeText({
      "replace": false,
      "summary": "type \"Lovelace1815\" into the focused field",
      "value": "Lovelace1815"
    }),
    replay.dismissKeyboard({
      "summary": "dismiss the keyboard"
    }),
    replay.tapAt({
      "point": {
        "x": 199,
        "y": 757
      },
      "summary": "tap the point (199, 757) on other \"Create your benchmark account, First na…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.495,
        "fy": 0.8456,
        "target": {
          "name": "Create your benchmark account, First name, Last name, Email address, Set password, Passwords must contain a minimum of 8 characters. By signing up you confirm you have read the benchmark terms. This filler paragraph exists so the form spans roughly two screens and the scroll indicator reports multi…",
          "role": "other"
        }
      }
    }),
    replay.tap({
      "summary": "tap button \"Not Now\"",
      "target": {
        "name": "Not Now",
        "role": "button"
      }
    }),
  ],
);
