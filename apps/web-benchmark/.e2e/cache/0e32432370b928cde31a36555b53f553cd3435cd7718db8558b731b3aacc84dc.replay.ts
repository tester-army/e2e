// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"0e32432370b928cde31a36555b53f553cd3435cd7718db8558b731b3aacc84dc","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20date-picker"},
  [
  replay.step(
    {
      "key": "be7d298262310938ce138756a44f67f5f87010d6eca26d02996608769c664c54",
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
            "text": "Appointment booked for September 17, 2026"
          }
        ],
        "endPath": "/e/date-picker",
        "endWaitMs": 11647,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Select date",
            "placeholder": "Select date",
            "role": "textbox",
            "testId": "date-input"
          },
          {
            "name": "Confirm booking",
            "role": "button",
            "testId": "confirm-button"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "dcf88f9a5a9a284823967721c9316e3541f960b36032c247343f678217019dde",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20date-picker"
        },
        "startPath": "/e/date-picker",
        "summary": "Navigated the calendar from June to September 2026, selected September 17, and confirmed. The page shows “Appointment booked for September 17, 2026.”"
      },
      [
        replay.tap({
          "summary": "tap textbox \"Select date\"",
          "target": {
            "name": "Select date",
            "placeholder": "Select date",
            "role": "textbox",
            "testId": "date-input"
          }
        }),
        replay.tap({
          "summary": "tap button \"›\"",
          "target": {
            "name": "›",
            "role": "button",
            "testId": "next-month-button"
          }
        }),
        replay.tap({
          "summary": "tap button \"›\"",
          "target": {
            "name": "›",
            "role": "button",
            "testId": "next-month-button"
          }
        }),
        replay.tap({
          "summary": "tap button \"›\"",
          "target": {
            "name": "›",
            "role": "button",
            "testId": "next-month-button"
          }
        }),
        replay.tap({
          "summary": "tap button \"17\"",
          "target": {
            "name": "17",
            "role": "button",
            "testId": "day-button-17"
          }
        }),
        replay.tap({
          "summary": "tap button \"Confirm booking\"",
          "target": {
            "name": "Confirm booking",
            "role": "button",
            "testId": "confirm-button"
          }
        }),
      ],
    )
  ),
  ],
);
