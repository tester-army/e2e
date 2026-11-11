// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"f1f714d2533e8f1047b0dd6840b2da814f0a931a3d493c6cf689e129df208a54","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Registration%20Form"},
  [
  replay.step(
    {
      "key": "21c26ef65b43c8ca1338372eea1412028bc5ba3fa6b7f3d31a238f29b56debe6",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
        "target": "a34152a60079722a259a417c0251ad71bf53cd3ef002e7f6c1e465dad98bee2b"
      }
    },
    replay.define(
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
    )
  ),
  replay.step(
    {
      "key": "96dbe50d1d0e8ea20edae76d25c00397dac07e3679d0588a0bba7d574fd04ce9",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
        "target": "d34e594487171911acb852c9c20a9b1e42d960b2c08aeb43fe1145049c6f1eed"
      }
    },
    replay.define(
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
    )
  ),
  ],
);
