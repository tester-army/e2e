// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Selected Benchmark Target",
        "role": "other"
      },
      {
        "name": "Selected Benchmark Target",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Debounced Search",
    "endWaitMs": 12017,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Search for and select \"Benchmark Target\"",
        "role": "text"
      },
      {
        "placeholder": "Search…",
        "role": "textbox",
        "testId": "search-input"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Horizontal scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Search for and select \"Benchmark Target\"",
        "role": "other"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other",
        "testId": "search-results"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "scroll-view"
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
      "instructionDigest": "c212f90679a61041258d6d57a10468462a17a4c9c398605f324169c734daa7f5",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Debounced%20Search"
    },
    "startPath": "dev.e2e.benchmark / Debounced Search",
    "summary": "Searched for “Benchmark Target,” waited for the exact result to load, and selected it once. The screen confirms “Selected Benchmark Target.”"
  },
  [
    replay.tap({
      "summary": "tap textbox \"Search…\"",
      "target": {
        "placeholder": "Search…",
        "role": "textbox",
        "selector": "id=search-input",
        "testId": "search-input"
      }
    }),
    replay.type({
      "summary": "type \"Benchmark Target\" into textbox \"Search…\"",
      "target": {
        "placeholder": "Search…",
        "role": "textbox",
        "selector": "id=search-input",
        "testId": "search-input"
      },
      "value": "Benchmark Target"
    }),
    replay.tap({
      "summary": "tap other \"Benchmark Target\"",
      "target": {
        "name": "Benchmark Target",
        "role": "other",
        "selector": "id=\"result-Benchmark Target\"",
        "testId": "result-Benchmark Target"
      }
    }),
    replay.tap({
      "summary": "tap other \"Benchmark Target\"",
      "target": {
        "name": "Benchmark Target",
        "role": "other",
        "selector": "id=\"result-Benchmark Target\"",
        "testId": "result-Benchmark Target"
      }
    }),
  ],
);
