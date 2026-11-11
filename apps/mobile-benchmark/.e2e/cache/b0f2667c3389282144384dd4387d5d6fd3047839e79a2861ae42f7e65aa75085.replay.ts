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
);
