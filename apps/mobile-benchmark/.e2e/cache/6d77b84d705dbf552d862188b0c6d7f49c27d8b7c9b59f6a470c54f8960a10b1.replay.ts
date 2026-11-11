// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
