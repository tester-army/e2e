// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "f957b586c4bc72eea27b50f68b9949edfaad665f4f651165e18e86ff63e02fd2",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Text%20Input%20Variations"
  },
  [
    replay.step(
      {
        "key": "b0f2667c3389282144384dd4387d5d6fd3047839e79a2861ae42f7e65aa75085",
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
              "name": "Form submitted",
              "role": "text",
              "testId": "success-message"
            }
          ],
          "endPath": "dev.e2e.benchmark",
          "endWaitMs": 11669,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Username (min 3 chars)",
              "role": "text"
            },
            {
              "role": "textbox",
              "testId": "username-input"
            },
            {
              "name": "PIN (exactly 4 digits, secure)",
              "role": "text"
            },
            {
              "inputPurpose": "password",
              "role": "textbox",
              "testId": "pin-input"
            },
            {
              "name": "Notes (multiline, min 10 chars) — 0/10",
              "role": "text"
            },
            {
              "role": "textbox",
              "testId": "notes-input"
            },
            {
              "name": "Submit",
              "role": "text"
            },
            {
              "name": "Submit",
              "role": "group",
              "testId": "submit-button"
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
            "instructionDigest": "fbc47cae1853b33f40b2f33da5fd5f41dfc811c660e7aecb291ad1d964757d21",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "android-emulator",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Text%20Input%20Variations"
          },
          "startPath": "dev.e2e.benchmark",
          "summary": "Entered username \"testuser\", a 4-digit PIN, and notes exceeding 10 characters, then submitted. The screen confirms “Form submitted.”"
        },
        [
          replay.type({
            "summary": "type \"testuser\" into textbox \"username-input\" in \"Username (min 3 chars)\"",
            "target": {
              "role": "textbox",
              "selector": "id=username-input",
              "testId": "username-input",
              "within": "Username (min 3 chars)"
            },
            "value": "testuser"
          }),
          replay.type({
            "summary": "type \"4827\" into textbox \"pin-input\" in \"Username (min 3 chars)\"",
            "target": {
              "inputPurpose": "password",
              "role": "textbox",
              "selector": "id=pin-input",
              "testId": "pin-input",
              "within": "Username (min 3 chars)"
            },
            "value": "4827"
          }),
          replay.type({
            "summary": "type \"These are at least ten characters.\" into textbox \"notes-input\" in \"Username (min 3 chars)\"",
            "target": {
              "role": "textbox",
              "selector": "id=notes-input",
              "testId": "notes-input",
              "within": "Username (min 3 chars)"
            },
            "value": "These are at least ten characters."
          }),
          replay.tap({
            "summary": "tap group \"Submit\" in \"Username (min 3 chars)\"",
            "target": {
              "name": "Submit",
              "role": "group",
              "selector": "id=submit-button",
              "testId": "submit-button",
              "within": "Username (min 3 chars)"
            }
          }),
        ],
      ),
    ),
    replay.step(
      {
        "key": "6d77b84d705dbf552d862188b0c6d7f49c27d8b7c9b59f6a470c54f8960a10b1",
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
              "name": "Form submitted",
              "role": "text",
              "testId": "success-message"
            }
          ],
          "endPath": "dev.e2e.benchmark / Text Input Variations",
          "endWaitMs": 12130,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "role": "textbox",
              "testId": "username-input"
            },
            {
              "inputPurpose": "password",
              "role": "textbox",
              "testId": "pin-input"
            },
            {
              "name": "Submit",
              "role": "other",
              "testId": "submit-button"
            },
            {
              "name": "Username (min 3 chars)",
              "role": "text"
            },
            {
              "name": "PIN (exactly 4 digits, secure)",
              "role": "text"
            },
            {
              "name": "Notes (multiline, min 10 chars) — 0/10",
              "role": "text"
            },
            {
              "role": "textbox",
              "testId": "notes-input"
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
          "recordedBy": {
            "model": "openai/gpt-6-luna-fast",
            "provider": "gateway"
          },
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "fbc47cae1853b33f40b2f33da5fd5f41dfc811c660e7aecb291ad1d964757d21",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "ios-simulator",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Text%20Input%20Variations"
          },
          "startPath": "dev.e2e.benchmark / Text Input Variations",
          "summary": "Entered notes (43 characters) with the existing username and 4-digit PIN, then submitted. The screen shows “Form submitted.”"
        },
        [
          replay.type({
            "summary": "type \"tester\" into textbox \"username-input\"",
            "target": {
              "role": "textbox",
              "selector": "id=username-input",
              "testId": "username-input"
            },
            "value": "tester"
          }),
          replay.type({
            "summary": "type \"1234\" into textbox \"pin-input\"",
            "target": {
              "inputPurpose": "password",
              "role": "textbox",
              "selector": "id=pin-input",
              "testId": "pin-input"
            },
            "value": "1234"
          }),
          replay.type({
            "summary": "type \"These are at least ten characters of no…\" into textbox \"notes-input\"",
            "target": {
              "role": "textbox",
              "selector": "id=notes-input",
              "testId": "notes-input"
            },
            "value": "These are at least ten characters of notes."
          }),
          replay.tap({
            "summary": "tap other \"Submit\"",
            "target": {
              "name": "Submit",
              "role": "other",
              "selector": "id=submit-button",
              "testId": "submit-button"
            }
          }),
        ],
      ),
    ),
  ],
);
