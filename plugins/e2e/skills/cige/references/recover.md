# Recovering the environment

For a result classified `infrastructure`: the case never fairly reached
the system. The case is not the problem, so this leaves it alone.

## Steps

1. Read the summary's `classification.message` and the trace's first
   failed step. Name what is missing: a sign-in, seed data, a service, the
   app itself.
2. Find the environment: `replay.environment` in the summary, or the
   case's `Context.environment`. `cige.config.ts` declares what it can do.
3. Restore it with the config's actions, smallest first:

   ```bash
   npx e2e-cige env reset staging       # re-seed, re-authenticate
   npx e2e-cige env provision staging   # create it again when it is gone
   ```

   A missing sign-in may instead be a setup test that saves the session;
   run it with `npx e2e run` and the project's setup file.
4. Replay the case: the summary's `replay.command`, or
   `npx e2e-cige replay <id>`.
5. Stop after three failed attempts. Hand a human what you tried, what
   still fails, and the environment's state. Don't keep retrying, and
   don't edit the case to work around a broken environment.

## When the environment itself moved

If the environment changed for good (a new URL, a renamed test account, a
service that moved), the fix belongs in Context or in the environment's
e2e config, not in Execution. Propose the Context change as a diff, run
`npx e2e-cige diff --base origin/main`, and hand it to a human with the
evidence that the old value no longer works. This is the one Context edit
the field rules allow, and it is never merged on your own.

## Done when

- The replay passes, or the case fails in a way that is no longer
  `infrastructure`; classify that result again with `classify.md`.
- No `.cige.json` changed, unless you are handing over a Context proposal.
