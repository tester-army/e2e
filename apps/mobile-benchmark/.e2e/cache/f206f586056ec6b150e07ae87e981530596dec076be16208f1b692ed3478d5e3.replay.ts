// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"f206f586056ec6b150e07ae87e981530596dec076be16208f1b692ed3478d5e3","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Login%20Form"},
  [
  replay.step(
    {
      "key": "5e4707ace3e9b4c2f3c6369c65e05e4fd7d597831d893c541e09845ed1e0d2a9",
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
            "name": "Logged in successfully",
            "role": "text",
            "testId": "success-message"
          },
          {
            "name": "Log out",
            "role": "text"
          },
          {
            "name": "Log out",
            "role": "group",
            "testId": "logout-button"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11826,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Use tester@tester.army / <secret:benchmark.password>",
            "role": "text"
          },
          {
            "name": "Email",
            "placeholder": "Email",
            "role": "textbox",
            "testId": "email-input"
          },
          {
            "inputPurpose": "password",
            "name": "Password",
            "placeholder": "Password",
            "role": "textbox",
            "testId": "password-input"
          },
          {
            "name": "Log in",
            "role": "text"
          },
          {
            "name": "Log in",
            "role": "group",
            "testId": "login-button"
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
          "instructionDigest": "faf898a5790a0ed0790b7cf57f66838eaa92ae4cb5975ac34563020bbe5cc9a3",
          "paramsDigest": "7c4620c298b4003cb825c790cc548f7357fad575798b56d1bf1966e88babd7b9",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Login%20Form"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Logged in with tester@tester.army and the provided password. The screen shows “Logged in successfully” and a Log out control."
      },
      [
        replay.type({
          "summary": "type \"tester@tester.army\" into textbox \"Email\" in \"Use tester@tester.army / <secret:benchm…\"",
          "target": {
            "name": "Email",
            "placeholder": "Email",
            "role": "textbox",
            "selector": "id=email-input",
            "testId": "email-input",
            "within": "Use tester@tester.army / <secret:benchmark.password>"
          },
          "value": "tester@tester.army"
        }),
        replay.typeSecret({
          "secret": "benchmark.password",
          "summary": "fill secret \"benchmark.password\" into textbox \"Password\" in \"Use tester@tester.army / <secret:benchm…\"",
          "target": {
            "inputPurpose": "password",
            "name": "Password",
            "placeholder": "Password",
            "role": "textbox",
            "selector": "id=password-input",
            "testId": "password-input",
            "within": "Use tester@tester.army / <secret:benchmark.password>"
          }
        }),
        replay.tap({
          "summary": "tap group \"Log in\" in \"Use tester@tester.army / <secret:benchm…\"",
          "target": {
            "name": "Log in",
            "role": "group",
            "selector": "id=login-button",
            "testId": "login-button",
            "within": "Use tester@tester.army / <secret:benchmark.password>"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "688a148d704ae364e07e871685ee5cc1e425f5f592d9c90fcddb96ab4163ae50",
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
    )
  ),
  ],
);
