// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"fc0f7e6d1480b04fc8d302b622449f2d78659a13bcbf1ac0379fb89af70eff5c","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Sequential%20Onboarding"},
  [
  replay.step(
    {
      "key": "bac4ef2c2e541ff451b7cacb5b4470aa86a01fbb224794ca75972e219b5215e8",
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
            "name": "Onboarding complete",
            "role": "text",
            "testId": "success-message"
          },
          {
            "name": "jane@example.com",
            "role": "text",
            "testId": "echo-email"
          },
          {
            "name": "Jane Merchant",
            "role": "text",
            "testId": "echo-name"
          },
          {
            "name": "0612435678",
            "role": "text",
            "testId": "echo-phone"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11700,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Step 1 of 3",
            "role": "text"
          },
          {
            "name": "Let's start with your email",
            "role": "text"
          },
          {
            "name": "e.g. jane@example.com",
            "placeholder": "e.g. jane@example.com",
            "role": "textbox",
            "testId": "email-input"
          },
          {
            "name": "Continue",
            "role": "text"
          },
          {
            "role": "group",
            "testId": "onboarding-step-email"
          },
          {
            "name": "Continue",
            "role": "group",
            "testId": "continue-button"
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
          "instructionDigest": "970c887978c38f936a27d9b90e47b8e93318f07069e136ba3b343e8bfa936525",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Sequential%20Onboarding"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Completed all three signup steps using jane@example.com, Jane Merchant, and 0612435678. Dismissed the keyboard before each Continue; the final screen confirms “Onboarding complete” and echoes all three values."
      },
      [
        replay.type({
          "summary": "type \"jane@example.com\" into textbox \"e.g. jane@example.com\" in \"Step 1 of 3\"",
          "target": {
            "name": "e.g. jane@example.com",
            "placeholder": "e.g. jane@example.com",
            "role": "textbox",
            "selector": "id=email-input",
            "testId": "email-input",
            "within": "Step 1 of 3"
          },
          "value": "jane@example.com"
        }),
        replay.dismissKeyboard({
          "summary": "dismiss the keyboard"
        }),
        replay.tap({
          "summary": "tap group \"Continue\" in \"Step 1 of 3\"",
          "target": {
            "name": "Continue",
            "role": "group",
            "selector": "id=continue-button",
            "testId": "continue-button",
            "within": "Step 1 of 3"
          }
        }),
        replay.type({
          "summary": "type \"Jane\" into textbox \"e.g. Jane\" in \"Step 2 of 3\"",
          "target": {
            "name": "e.g. Jane",
            "placeholder": "e.g. Jane",
            "role": "textbox",
            "selector": "id=first-name-input",
            "testId": "first-name-input",
            "within": "Step 2 of 3"
          },
          "value": "Jane"
        }),
        replay.type({
          "summary": "type \"Merchant\" into textbox \"e.g. Merchant\" in \"Step 2 of 3\"",
          "target": {
            "name": "e.g. Merchant",
            "placeholder": "e.g. Merchant",
            "role": "textbox",
            "selector": "id=last-name-input",
            "testId": "last-name-input",
            "within": "Step 2 of 3"
          },
          "value": "Merchant"
        }),
        replay.dismissKeyboard({
          "summary": "dismiss the keyboard"
        }),
        replay.tap({
          "summary": "tap group \"Continue\" in \"Step 2 of 3\"",
          "target": {
            "name": "Continue",
            "role": "group",
            "selector": "id=continue-button",
            "testId": "continue-button",
            "within": "Step 2 of 3"
          }
        }),
        replay.type({
          "summary": "type \"0612435678\" into textbox \"e.g. 0612435678\" in \"Step 3 of 3\"",
          "target": {
            "name": "e.g. 0612435678",
            "placeholder": "e.g. 0612435678",
            "role": "textbox",
            "selector": "id=phone-input",
            "testId": "phone-input",
            "within": "Step 3 of 3"
          },
          "value": "0612435678"
        }),
        replay.dismissKeyboard({
          "summary": "dismiss the keyboard"
        }),
        replay.tap({
          "summary": "tap group \"Continue\" in \"Step 3 of 3\"",
          "target": {
            "name": "Continue",
            "role": "group",
            "selector": "id=continue-button",
            "testId": "continue-button",
            "within": "Step 3 of 3"
          }
        }),
      ],
    )
  ),
  ],
);
