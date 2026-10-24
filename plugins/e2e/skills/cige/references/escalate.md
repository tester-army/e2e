# Escalating a product defect

For a result classified `product-defect`: the case reached a healthy
system along a current path, and the outcome contradicts Intent. This
reference changes no case. It decides between a bug and a changed
requirement, using the refs.

## Fetch the ground truth

```bash
npx e2e-cige refs <id>     # add --variant <v> for a variant
```

Read `.e2e/cige/<id>.refs/index.json` (`<id>.<variant>.refs/` for a
variant). Each of `spec`, `build` (release notes for the build under
test), and `expected` (what the build should produce) has some of: a
`pointer` from the case, a `url`, `files`, or `text`, the name of a file
beside the index. Follow whichever of `url`, `files`, or `text` it has. A
`pointer` alone, a missing key, or an `error` means the ref is unresolved:
name it as a gap and use the Unclear row.

## Decide

| What the refs say | Outcome |
| --- | --- |
| The spec still asks for the Intent, and the build claims no change to it | **A bug.** File it |
| The spec changed, the release notes for this build ship that change, and the app matches the new spec | **A changed requirement.** Propose an Intent change |
| The spec changed, but the release notes don't confirm this build shipped it | **Unclear.** The spec may be ahead of the release. Stop and ask |
| A ref is missing or failed to resolve | **Unclear.** Name the missing ref as a gap in the case and stop |

## File a bug

Include the Intent, what the app did instead (the failed step and its
message from the summary), the spec section it contradicts, the build
from the summary's `build`, and the trace and artifacts the summary points
to. Leave the case failing: it is right.

## Propose an Intent change

Only for the second row, and only as a proposal:

1. Edit the Intent (and the Execution that follows from it) to match the
   new spec.
2. Run `npx e2e-cige diff --base origin/main`. It will show
   `intent-changed` as blocking. That is expected.
3. Hand a human the diff, the spec change, and the release-notes line that
   shows this build shipped it. Never merge it yourself, and never change
   an Intent to make a failing case pass.
