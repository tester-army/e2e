// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "c1dc0a607301036844b16e4996f71839030b412774a7febfe485f6ef5c12410d",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20rich-text-editor"
  },
  [
    replay.step(
      {
        "key": "8fd84a0f9335c6c96be5d82a9cda46146389f138c2fd46037ffbf64f4ef6e2eb",
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
              "text": "Document approved"
            }
          ],
          "endPath": "/e/rich-text-editor",
          "endWaitMs": 11834,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "text": "Type \"release approved\" in the editor and make the word approved bold, then check the document."
            },
            {
              "name": "B",
              "role": "button",
              "testId": "bold-button"
            },
            {
              "role": "textbox",
              "testId": "editor"
            },
            {
              "name": "Check document",
              "role": "button",
              "testId": "check-button"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "e37ad9ac878deebe5c840d23fded9589f67228d8229a059b855347ab5e49ab96",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20rich-text-editor"
          },
          "startPath": "/e/rich-text-editor",
          "summary": "Entered “release approved,” selected only “approved” and applied bold formatting, then checked the document. The page confirmed “Document approved.”"
        },
        [
          replay.type({
            "summary": "type \"release approved\" into textbox \"editor\"",
            "target": {
              "role": "textbox",
              "testId": "editor"
            },
            "value": "release approved"
          }),
          replay.press({
            "key": "Control+Shift+ArrowLeft",
            "summary": "press \"Control+Shift+ArrowLeft\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "ArrowRight",
            "summary": "press \"ArrowRight\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Control+Shift+ArrowLeft",
            "summary": "press \"Control+Shift+ArrowLeft\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.tap({
            "summary": "tap textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Shift+End",
            "summary": "press \"Shift+End\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.tap({
            "summary": "tap textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Control+a",
            "summary": "press \"Control+a\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.tap({
            "summary": "tap textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Control+a",
            "summary": "press \"Control+a\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Control+Shift+ArrowLeft",
            "summary": "press \"Control+Shift+ArrowLeft\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Home",
            "summary": "press \"Home\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.press({
            "key": "ArrowRight",
            "summary": "press \"ArrowRight\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.press({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on textbox \"release approved\"",
            "target": {
              "role": "textbox",
              "testId": "editor",
              "text": "release approved"
            }
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.pressKey({
            "key": "Shift+ArrowRight",
            "summary": "press \"Shift+ArrowRight\" on the focused field"
          }),
          replay.tap({
            "summary": "tap button \"B\"",
            "target": {
              "name": "B",
              "role": "button",
              "testId": "bold-button"
            }
          }),
          replay.tap({
            "summary": "tap button \"Check document\"",
            "target": {
              "name": "Check document",
              "role": "button",
              "testId": "check-button"
            }
          }),
        ],
      ),
    ),
  ],
);
