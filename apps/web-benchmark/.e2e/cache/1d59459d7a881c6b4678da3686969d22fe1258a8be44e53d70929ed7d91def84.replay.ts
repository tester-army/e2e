// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Code verified"
      }
    ],
    "endPath": "/e/otp-auto-advance",
    "endWaitMs": 14371,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Enter code 493027."
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-0"
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-1"
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-2"
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-3"
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-4"
      },
      {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-5"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "c878aa968fdbc93d377500f8aecb2f3b0ab701c37b7f9757f8d993f0fc87e109",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20otp-auto-advance"
    },
    "startPath": "/e/otp-auto-advance",
    "summary": "Entered the displayed code 493027 into the six segmented inputs. The page now displays “Code verified.”"
  },
  [
    replay.type({
      "summary": "type \"4\" into textbox \"otp-input-0\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-0"
      },
      "value": "4"
    }),
    replay.type({
      "summary": "type \"9\" into textbox \"otp-input-1\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-1"
      },
      "value": "9"
    }),
    replay.type({
      "summary": "type \"3\" into textbox \"otp-input-2\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-2"
      },
      "value": "3"
    }),
    replay.type({
      "summary": "type \"0\" into textbox \"otp-input-3\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-3"
      },
      "value": "0"
    }),
    replay.type({
      "summary": "type \"2\" into textbox \"otp-input-4\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-4"
      },
      "value": "2"
    }),
    replay.type({
      "summary": "type \"7\" into textbox \"otp-input-5\"",
      "target": {
        "inputPurpose": "one-time-code",
        "role": "textbox",
        "testId": "otp-input-5"
      },
      "value": "7"
    }),
  ],
);
