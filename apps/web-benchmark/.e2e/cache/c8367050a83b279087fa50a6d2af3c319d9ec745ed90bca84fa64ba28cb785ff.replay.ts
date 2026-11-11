// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "c8367050a83b279087fa50a6d2af3c319d9ec745ed90bca84fa64ba28cb785ff",
    "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::a%20right-click%20opens%20the%20file%20menu%20and%20Rename%20renames%20the%20file"
  },
  [
    replay.step(
      {
        "key": "e4472e79abcc4566856591a2baba5ae0e474e37f95fc2cd9cd2fd336f2d9da80",
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
              "name": "File state",
              "role": "status",
              "text": "report.pdf renamed to summary.pdf"
            },
            {
              "text": "summary.pdf"
            },
            {
              "name": "summary.pdf",
              "role": "listitem"
            }
          ],
          "endPath": "/e/control-inventory",
          "endWaitMs": 11535,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "File state",
              "role": "status",
              "text": "no menu open"
            },
            {
              "text": "report.pdf"
            },
            {
              "name": "report.pdf",
              "role": "listitem"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "cb3da13c69639f87ac80d3bd6fa2b908c9df0bbbda211433bdc779611d4909fe",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::a%20right-click%20opens%20the%20file%20menu%20and%20Rename%20renames%20the%20file"
          },
          "startPath": "/e/control-inventory",
          "summary": "Right-clicked report.pdf to open its actions menu, selected Rename, and verified the file list now shows summary.pdf with the status “report.pdf renamed to summary.pdf.”"
        },
        [
          replay.secondaryTap({
            "summary": "secondary-tap listitem \"report.pdf\" in \"Files\"",
            "target": {
              "name": "report.pdf",
              "role": "listitem",
              "within": "Files"
            }
          }),
          replay.secondaryTap({
            "summary": "secondary-tap node \"report.pdf\"",
            "target": {
              "text": "report.pdf"
            }
          }),
          replay.tap({
            "summary": "tap menuitem \"Rename\" in \"report.pdf\"",
            "target": {
              "name": "Rename",
              "role": "menuitem",
              "within": "report.pdf"
            }
          }),
        ],
      ),
    ),
  ],
);
