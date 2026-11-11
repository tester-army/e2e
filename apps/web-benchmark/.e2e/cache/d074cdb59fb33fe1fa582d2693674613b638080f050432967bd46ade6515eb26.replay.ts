// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Board matches the goal"
      }
    ],
    "endPath": "/e/kanban-board",
    "endWaitMs": 11433,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Empty"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "79f28df979547ae9abe14bba1c341873d1aa9d74dccc07d1e76bf46c279b8cb5",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20kanban-board"
    },
    "startPath": "/e/kanban-board",
    "summary": "Moved Fix payment bug to Done and Refactor onboarding to In Progress, then submitted. The page confirmed “Board matches the goal.”"
  },
  [
    replay.drag({
      "destination": {
        "testId": "column-done"
      },
      "summary": "drag node \"Fix payment bug\" to node \"column-done\"",
      "target": {
        "testId": "card-fix-payment-bug",
        "text": "Fix payment bug"
      }
    }),
    replay.drag({
      "destination": {
        "testId": "column-in-progress"
      },
      "summary": "drag node \"Refactor onboarding\" to node \"column-in-progress\"",
      "target": {
        "testId": "card-refactor-onboarding",
        "text": "Refactor onboarding"
      }
    }),
    replay.tap({
      "summary": "tap button \"Submit board\"",
      "target": {
        "name": "Submit board",
        "role": "button",
        "testId": "submit-board"
      }
    }),
  ],
);
