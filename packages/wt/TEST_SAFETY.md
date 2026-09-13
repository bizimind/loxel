# wt test safety

The `wt` package manages and removes Git worktrees and runs repository-provided shell hooks. A
bad test can therefore delete a real checkout, delete a real branch, or execute an arbitrary local
hook. Treat every change to a wt test or its shared test infrastructure as potentially destructive.
The safety preload is configured at both the monorepo root and package root so that supported full
suite and single-file test commands cannot silently bypass the hash check.

## Rules for tests

Before approving a changed test suite, review every changed test and test-support file and confirm:

- No test targets the repository containing the test process, an existing worktree, the home
  directory, or a path supplied by the ambient environment.
- Destructive paths cannot escape a test-owned location through `..`, absolute paths, environment
  variables, symlinks, or accidentally reused production state.
- Cleanup never uses the process working directory, repository root, home directory, or an empty or
  unresolved variable as its target.
- Tests do not execute repository hooks or arbitrary shell scripts from the developer's machine.
- Any real Git or shell execution is intentional and remains confined to disposable test state.
- Failure before setup completes cannot make cleanup fall back to a broader path.

The preload clears ambient temporary-directory variables, `WT_DIR`, `WT_AUTO_UPDATE`, Git
environment overrides, and shell startup file variables before approved tests run. The shared
repository helper also refuses to create test state when the system temporary directory overlaps
the source checkout, and refuses recursive cleanup unless its target is an immediate `wt-test-*`
child of that directory.

The preferred design is to inject and stub Git, filesystem mutation, hook execution, and process
control. The hash gate below is a review tripwire, not an operating-system sandbox: approving the
hash authorizes the reviewed test code to run with the developer's own permissions.

## Approving an intentional test change

1. Read this entire file.
2. Review the changed tests and every changed helper they use against the rules above.
3. Run the following command with the acknowledgement token below:

   ```sh
   pnpm -C packages/wt run test:safety:approve -- --acknowledge <token>
   ```

4. Review the generated `test/approved-test-hash.ts` diff before running the tests.

Acknowledgement token: `32DFDB1E-98A7-40CE-903F-6CDD9DF5C77C`

Do not approve a hash merely to make the test command pass. A changed hash means the safety review
must be repeated.
