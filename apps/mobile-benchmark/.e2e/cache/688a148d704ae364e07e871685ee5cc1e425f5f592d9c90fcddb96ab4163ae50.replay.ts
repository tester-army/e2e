// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Log out",
        "role": "other",
        "testId": "logout-button"
      },
      {
        "name": "Logged in successfully",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Login Form",
    "endWaitMs": 13558,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "placeholder": "Email",
        "role": "textbox",
        "testId": "email-input",
        "value": "Email"
      },
      {
        "inputPurpose": "password",
        "placeholder": "Password",
        "role": "textbox",
        "testId": "password-input"
      },
      {
        "name": "Log in",
        "role": "other",
        "testId": "login-button"
      },
      {
        "name": "Use tester@tester.army / <secret:benchmark.password>",
        "role": "text"
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
      "instructionDigest": "faf898a5790a0ed0790b7cf57f66838eaa92ae4cb5975ac34563020bbe5cc9a3",
      "paramsDigest": "7c4620c298b4003cb825c790cc548f7357fad575798b56d1bf1966e88babd7b9",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Login%20Form"
    },
    "startPath": "dev.e2e.benchmark / Login Form",
    "summary": "Entered tester@tester.army and the provided password, submitted the login form, dismissed the system password-save prompt, and verified the screen shows “Logged in successfully” with a Log out control."
  },
  [
    replay.type({
      "summary": "type \"tester@tester.army\" into textbox \"Email\"",
      "target": {
        "placeholder": "Email",
        "role": "textbox",
        "selector": "id=email-input",
        "testId": "email-input"
      },
      "value": "tester@tester.army"
    }),
    replay.typeSecret({
      "secret": "benchmark.password",
      "summary": "fill secret \"benchmark.password\" into textbox \"Password\"",
      "target": {
        "inputPurpose": "password",
        "placeholder": "Password",
        "role": "textbox",
        "selector": "id=password-input",
        "testId": "password-input"
      }
    }),
    replay.tap({
      "summary": "tap other \"Log in\"",
      "target": {
        "name": "Log in",
        "role": "other",
        "selector": "id=login-button",
        "testId": "login-button"
      }
    }),
    replay.press({
      "key": "Enter",
      "summary": "press \"Enter\" on textbox \"Password\"",
      "target": {
        "inputPurpose": "password",
        "placeholder": "Password",
        "role": "textbox",
        "selector": "id=password-input",
        "testId": "password-input"
      }
    }),
    replay.tap({
      "summary": "tap other \"Log in\"",
      "target": {
        "name": "Log in",
        "role": "other",
        "selector": "id=login-button",
        "testId": "login-button"
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
