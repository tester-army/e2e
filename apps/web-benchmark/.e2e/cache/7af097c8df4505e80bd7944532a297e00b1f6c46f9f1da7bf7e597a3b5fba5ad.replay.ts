// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "7af097c8df4505e80bd7944532a297e00b1f6c46f9f1da7bf7e597a3b5fba5ad",
    "testId": "tests-agent/login-form.e2e.ts::act%20signs%20in%20with%20the%20benchmark%20account"
  },
  [
    replay.step(
      {
        "key": "d9508413b3c3bd9567d0277a312312d32c4a1770d65e8e789d3ba0298717e662",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "6c340b4558007fd12144b6a4e0daf3abb724b92faa2d08705fa564444b68533c",
          "target": "4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2"
        }
      },
      replay.define(
        {
          "endAnchors": [
            {
              "testId": "success-message",
              "text": "Logged in successfully"
            },
            {
              "name": "Log out",
              "role": "button",
              "testId": "logout-button"
            }
          ],
          "endPath": "/e/login-form",
          "endWaitMs": 11548,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "text": "Use tester@tester.army / <secret:benchmark.password>"
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
              "role": "button",
              "testId": "login-button"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "c26456300e1d572e5598b0d8d2584171681d80d8a20bef86bdda6e9d2c7f976e",
            "paramsDigest": "10cf8df51d5b30096b97501956aa95d056885035f7bc67d093d076b7c4caecf0",
            "targetId": "web",
            "testId": "tests-agent/login-form.e2e.ts::act%20signs%20in%20with%20the%20benchmark%20account"
          },
          "startPath": "/e/login-form",
          "summary": "Logged in with tester@tester.army and the supplied password. The page shows “Logged in successfully” and a Log out button."
        },
        [
          replay.type({
            "summary": "type \"tester@tester.army\" into textbox \"Email\"",
            "target": {
              "name": "Email",
              "placeholder": "Email",
              "role": "textbox",
              "testId": "email-input"
            },
            "value": "tester@tester.army"
          }),
          replay.typeSecret({
            "secret": "benchmark.password",
            "summary": "fill secret \"benchmark.password\" into textbox \"Password\"",
            "target": {
              "inputPurpose": "password",
              "name": "Password",
              "placeholder": "Password",
              "role": "textbox",
              "testId": "password-input"
            }
          }),
          replay.tap({
            "summary": "tap button \"Log in\"",
            "target": {
              "name": "Log in",
              "role": "button",
              "testId": "login-button"
            }
          }),
        ],
      ),
    ),
  ],
);
