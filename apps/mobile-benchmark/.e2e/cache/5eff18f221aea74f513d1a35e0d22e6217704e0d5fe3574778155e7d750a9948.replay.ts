// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Selected Benchmark Target",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11661,
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
        "name": "Search…",
        "placeholder": "Search…",
        "role": "textbox",
        "testId": "search-input"
      },
      {
        "role": "group",
        "testId": "search-results"
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
      "instructionDigest": "c212f90679a61041258d6d57a10468462a17a4c9c398605f324169c734daa7f5",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Debounced%20Search"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Searched for “Benchmark Target,” waited for the result to load, and selected the exact matching result once. The screen confirms “Selected Benchmark Target.”"
  },
  [
    replay.type({
      "summary": "type \"Benchmark Target\" into textbox \"Search…\" in \"Search for and select \\\"Benchmark Target\\\"\"",
      "target": {
        "name": "Search…",
        "placeholder": "Search…",
        "role": "textbox",
        "selector": "id=search-input",
        "testId": "search-input",
        "within": "Search for and select \"Benchmark Target\""
      },
      "value": "Benchmark Target"
    }),
    replay.tap({
      "summary": "tap group \"Benchmark Target\"",
      "target": {
        "name": "Benchmark Target",
        "role": "group",
        "selector": "id=\"result-Benchmark Target\"",
        "testId": "result-Benchmark Target"
      }
    }),
  ],
);
