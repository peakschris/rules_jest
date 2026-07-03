/**
 * Coverage bootstrap for `jest_test`, injected as a Node `--require` preload by
 * the rule (via `node_options`) ONLY when Bazel runs with coverage enabled.
 *
 * WHY THIS EXISTS
 * Under rules_js a test's source files appear in the runfiles tree as symlinks
 * whose realpath resolves into the bazel-out `bin` tree, OUTSIDE the sandbox
 * runfiles root. Jest's babel (istanbul) coverage provider instruments a file
 * only when that file's realpath'd path is inside `config.cwd`, and jest-config
 * unconditionally forces `config.cwd = realpath(process.cwd())`. With the
 * default working directory (the sandbox runfiles root) every source file is
 * "outside cwd", so istanbul skips them all and coverage comes out empty.
 *
 * FIX
 * Before jest's CLI starts, chdir into the real `bin` package directory so that
 * `realpath(process.cwd())` becomes an ancestor of the instrumented sources.
 * The `bin` package dir is the realpath of the generated jest config (the rule
 * emits it at the package root, next to the sources). `--config` is rewritten to
 * an absolute path first so it still resolves after the chdir.
 *
 * WHY A `--require` PRELOAD (and not the jest config module)
 * jest-cli captures `projects = [process.cwd()]` at CLI startup, before the
 * config module is ever loaded. A chdir performed from inside the config module
 * would therefore diverge `projects[0]` from `process.cwd()` and send jest into
 * a doomed config-file traversal ("Could not find a config file"). The chdir has
 * to happen before the jest CLI runs, which is exactly what a `--require`
 * preload guarantees.
 */
"use strict";

// Only act under coverage; a normal `bazel test` never sets COVERAGE_DIR and
// this preload is a no-op there (it is also only injected under coverage).
if (process.env.COVERAGE_DIR) {
    const path = require("path");
    const { realpathSync } = require("fs");
    const argv = process.argv;
    const i = argv.indexOf("--config");
    if (i !== -1 && argv[i + 1]) {
        try {
            // Resolve `--config` to an absolute path now, since we are about to
            // change the working directory out from under jest's relative-path
            // resolution.
            const absConfig = path.resolve(process.cwd(), argv[i + 1]);
            argv[i + 1] = absConfig;
            // realpath crosses the runfiles symlink into the bin tree; its
            // dirname is the bin package directory that holds the instrumented
            // sources.
            process.chdir(path.dirname(realpathSync(absConfig)));
        } catch (_) {
            // Best-effort: on any failure leave cwd/argv untouched. The test
            // still runs; coverage may just be empty.
        }
    }
}
