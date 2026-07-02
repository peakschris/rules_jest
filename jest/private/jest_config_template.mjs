/**
 * Template for the wrapper Jest config written by the `jest_test` rule.
 *
 * `{{...}}` placeholders are substituted by Bazel via `ctx.actions.expand_template`
 * (see `jest_test.bzl`). The wrapper exports an async factory rather than a
 * top-level-awaited config object: that keeps the `.mjs` loadable under both Jest's
 * `import()` path and Node 22.12+'s `require(esm)` path, which would otherwise fail
 * with `ERR_REQUIRE_ASYNC_MODULE` on any top-level `await`.
 *
 * Side effects that must run before Jest forks workers (env vars, warnings) sit at
 * module scope; everything that mutates the config object lives inside the factory.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const updateSnapshots = !!process.env.JEST_TEST__UPDATE_SNAPSHOTS;
const coverageEnabled = !!process.env.COVERAGE_DIR;
const autoConfReporting = !!"{{AUTO_CONF_REPORTING}}";
const autoConfReporters = !!"{{AUTO_CONF_REPORTERS}}";
const autoConfTestSequencer = !!"{{AUTO_CONF_TEST_SEQUENCER}}";
const userConfigShortPath = "{{USER_CONFIG_SHORT_PATH}}";
const userConfigPath = "{{USER_CONFIG_PATH}}";

function _resolveRunfilesPath(rootpath) {
  return path.join(
    process.env.JS_BINARY__RUNFILES,
    process.env.JS_BINARY__WORKSPACE,
    rootpath,
  );
}

function _resolveExecrootPath(execpath) {
  return path.join(process.env.JS_BINARY__EXECROOT, execpath);
}

const bazelSequencerPath = _resolveRunfilesPath(
  "{{BAZEL_SEQUENCER_SHORT_PATH}}",
);
const bazelSnapshotReporterPath = _resolveRunfilesPath(
  "{{BAZEL_SNAPSHOT_REPORTER_SHORT_PATH}}",
);
const bazelSnapshotResolverPath = _resolveRunfilesPath(
  "{{BAZEL_SNAPSHOT_RESOLVER_SHORT_PATH}}",
);
const bazelHasteMapModulePath = _resolveRunfilesPath(
  "{{BAZEL_HASTE_MAP_MODULE_SHORT_PATH}}",
);
const bazelFilelistJsonPath = _resolveRunfilesPath(
  "{{BAZEL_FILELIST_JSON_SHORT_PATH}}",
);

// Set at module scope so child processes Jest spawns inherit it before bazel_haste_map.cjs runs.
process.env.BAZEL_FILELIST_JSON_FULL_PATH = bazelFilelistJsonPath;

if (
  !updateSnapshots &&
  process.env.JEST_JUNIT_OUTPUT_FILE != process.env.XML_OUTPUT_FILE
) {
  console.error(
    `WARNING: aspect_rules_jest[jest_test]: expected JEST_JUNIT_OUTPUT_FILE environment variable to be set to ${process.env.XML_OUTPUT_FILE} in jest_test target ${process.env.TEST_TARGET}`,
  );
}

/**
 * Load the user-supplied Jest config from runfiles and return it as a fresh object.
 *
 * `import()` caches modules by URL, so the same default export is handed back on every
 * call. Returning a shallow clone keeps later config mutations from leaking across
 * factory invocations. The `file://` prefix is required on Windows where bare drive-
 * letter paths (`c:\...`) aren't valid module specifiers.
 */
async function _loadUserConfig() {
  if (!userConfigShortPath) return {};
  const url = "file://" + _resolveRunfilesPath(userConfigShortPath);
  if (path.extname(userConfigShortPath).toLowerCase() === ".json") {
    // `with` is the spec import attribute (Node 20.10+, 22+); the legacy `assert` form
    // was removed in Node 22 and now throws ERR_IMPORT_ATTRIBUTE_MISSING.
    return { ...(await import(url, { with: { type: "json" } })).default };
  }
  const exported = (await import(url)).default;
  return { ...(typeof exported === "function" ? await exported() : exported) };
}

/**
 * Warn if the user's Jest config uses `projects`, which bypasses rules_jest's
 * configuration (reporters, coverage, snapshots, sharding).
 * @see https://jestjs.io/docs/configuration#projects-arraystring--projectconfig
 */
function _verifyJestConfig(config) {
  if (config.projects && config.projects.length > 0) {
    console.error(`WARNING: aspect_rules_jest[jest_test]: Jest config in target ${process.env.TEST_TARGET} uses 'projects'.
      The use of 'projects' in aspect_rules_jest is unsupported and will cause unexpected behavior including breaking use of
      reporting, coverage, snapshots and sharding.`);
  }
}

/** Add a reporter to `config.reporters` if one named `name` isn't already present. */
function _addReporter(config, name, reporter = name) {
  config.reporters ??= [];
  const exists = config.reporters.some((r) =>
    Array.isArray(r) ? r[0] === name : r === name,
  );
  if (!exists) config.reporters.push(reporter);
}

/**
 * Minimal glob -> RegExp for `collectCoverageFrom` matching -- a small subset of
 * micromatch (`**`, `**​/`, `*`, `?`) sufficient for the conventional coverage
 * globs (e.g. `lib/**​/*.js`, `!lib/**​/*.test.js`). Only used by the exit-time
 * 0%-backfill below; NOT a general micromatch replacement.
 */
function _globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // globstar segment: zero or more dirs
        } else {
          re += ".*"; // trailing/embedded globstar
        }
      } else {
        re += "[^/]*"; // single-segment wildcard
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "/") {
      re += "/";
    } else if ("\\^$.|+()[]{}".indexOf(c) !== -1) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Append synthetic 0%-coverage LCOV records for source files that match
 * `collectCoverageFrom` but were never loaded by any test.
 *
 * WHY: jest's v8 coverage provider only records files actually executed, and its
 * `_addUntestedFiles` 0%-backfill enumerates `collectCoverageFrom` relative to
 * `rootDir` -- which the v8 fix repoints at the bin tree while the haste FS comes
 * from the runfiles tree, so the globs never match and untested files are simply
 * absent from the report (making overall coverage read optimistically). The
 * runfiles/bin/haste-map split makes this irreconcilable via `rootDir` alone, so
 * we backfill here at exit instead, independent of jest's own enumeration.
 *
 * Enumeration source is the Bazel filelist (`test__jest.files.json`: an array of
 * workspace-relative data paths), filtered by the package-relative
 * `collectCoverageFrom` globs (`JS_BINARY__PACKAGE` is stripped to make filelist
 * entries package-relative). Line counts come from the runfiles copy of each
 * file. Emits `DA:n,0` for every physical line + `LF`/`LH:0`, matching the shape
 * v8/lcovonly produces for covered files (a DA entry per line). `presentPaths`
 * (workspace-relative SF paths already in the report) are skipped. Best-effort:
 * any failure returns the report unchanged.
 */
function _appendUntestedFiles(lcov, config, presentPaths) {
  const patterns = config.collectCoverageFrom;
  if (!Array.isArray(patterns) || patterns.length === 0) return lcov;
  if (!bazelFilelistJsonPath || !existsSync(bazelFilelistJsonPath)) return lcov;

  const pkg = process.env.JS_BINARY__PACKAGE || "";
  const pkgPrefix = pkg ? pkg.replace(/\\/g, "/") + "/" : "";

  const includes = [];
  const excludes = [];
  for (const p of patterns) {
    if (p.startsWith("!")) excludes.push(_globToRegExp(p.slice(1)));
    else includes.push(_globToRegExp(p));
  }
  if (includes.length === 0) return lcov;

  let files;
  try {
    files = JSON.parse(readFileSync(bazelFilelistJsonPath, "utf8"));
  } catch (_) {
    return lcov;
  }
  if (!Array.isArray(files)) return lcov;

  let appended = "";
  for (const wsPath of files) {
    const norm = String(wsPath).replace(/\\/g, "/");
    if (presentPaths.has(norm)) continue;
    if (pkgPrefix && !norm.startsWith(pkgPrefix)) continue;
    const rel = pkgPrefix ? norm.slice(pkgPrefix.length) : norm;
    if (!includes.some((re) => re.test(rel))) continue;
    if (excludes.some((re) => re.test(rel))) continue;

    let text;
    try {
      text = readFileSync(_resolveRunfilesPath(norm), "utf8");
    } catch (_) {
      continue; // directory entry or unreadable -- skip
    }
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const n = lines.length;
    if (n === 0) continue;

    presentPaths.add(norm);
    let rec = "SF:" + norm + "\n";
    for (let i = 1; i <= n; i++) rec += "DA:" + i + ",0\n";
    rec += "LF:" + n + "\nLH:0\nend_of_record\n";
    appended += rec;
  }
  return appended ? lcov + appended : lcov;
}

export default async function jestConfig() {
  const config = await _loadUserConfig();
  _verifyJestConfig(config);

  config.cacheDirectory ||= path.join(process.env.TEST_TMPDIR, "jest_cache");

  config.haste = {
    // Walk the filesystem to find inputs. See https://github.com/facebook/jest/pull/9351
    enableSymlinks: true,
    // Don't shell out to watchman or find; use the rules_jest haste map module instead.
    forceNodeFilesystemAPI: true,
    hasteMapModulePath: bazelHasteMapModulePath,
    // Caching is Bazel's job; SHA1/dependency computation is only useful with persistent caching.
    computeSha1: false,
    ...config.haste,
  };

  // Watching, caching, and change detection are all Bazel/ibazel's job.
  config.watchman = false;
  config.watch = config.watchAll = false;
  config.cache = false;
  config.onlyChanged = false;

  if (autoConfReporters) {
    _addReporter(config, "default");
    if (!updateSnapshots) {
      _addReporter(config, "jest-junit", [
        "jest-junit",
        { outputFile: process.env.XML_OUTPUT_FILE },
      ]);
    }
  }

  if (!updateSnapshots) {
    _addReporter(config, bazelSnapshotReporterPath);
  }

  if (autoConfTestSequencer) {
    if (config.testSequencer) {
      console.error(`WARNING: aspect_rules_jest[jest_test]: user supplied Jest config testSequencer value '${config.testSequencer}' will be overridden by jest_test in target ${process.env.TEST_TARGET}.
      See https://jestjs.io/docs/configuration#testsequencer-string for more information on Jest testSequencer config option.
      Set auto_configure_test_sequencer to False to disable this override.`);
    }
    config.testSequencer = bazelSequencerPath;
  }

  if (updateSnapshots) {
    if (config.snapshotResolver) {
      const snapshotResolverPath = path.isAbsolute(config.snapshotResolver)
        ? config.snapshotResolver
        : path.resolve(
            _resolveExecrootPath(userConfigPath),
            "..",
            config.snapshotResolver,
          );
      if (!existsSync(snapshotResolverPath)) {
        throw new Error(
          `configured snapshotResolver '${config.snapshotResolver}' not found at ${snapshotResolverPath}`,
        );
      }
      process.env.JEST_TEST__USER_SNAPSHOT_RESOLVER = snapshotResolverPath;
    }
    config.snapshotResolver = bazelSnapshotResolverPath;
  }

  if (coverageEnabled) {
    config.collectCoverage = true;
    // Leave `coverageProvider` unset so jest's default (babel/istanbul) is used.
    // babel-jest is already jest's transformer here, so enabling coverage just
    // makes it additionally inject babel-plugin-istanbul, instrumenting every
    // collectCoverageFrom match at transform time. That lists never-loaded source
    // files at an honest 0% (real executable-line/branch/function denominators),
    // unlike v8 which only records scripts actually executed. The service configs
    // set no coverageProvider, so the default wins.
    //
    // rules_js stages sources as REAL files in the execroot bin output tree
    // (bazel-out/<cfg>/bin/src/<svc>/lib/*.js) and exposes them to the test
    // through a runfiles symlink tree. jest-resolve realpaths required modules, so
    // loaded source files resolve to their BIN-tree path. Two coverage gates must
    // line up with that bin-tree path or babel/istanbul silently produces nothing:
    //
    //  1. shouldInstrument matches
    //       replacePathSepForGlob(path.relative(config.rootDir, <file>))
    //     against collectCoverageFrom. For that to yield `lib/x.js` (matching
    //     `lib/**/*.js`), rootDir must be the bin-tree `src/<svc>` dir that
    //     directly contains `lib/`. import.meta.url is this generated config,
    //     loaded through the runfiles symlink; realpathSync resolves it into the
    //     bin tree, so its dirname is exactly that directory. (With the wrong
    //     rootDir the instrument flag is never set -> uninstrumented sources.)
    //
    //  2. babel-jest hands babel-plugin-istanbul `{ cwd: transformOptions.config.cwd }`
    //     and "files outside cwd will not be instrumented". jest forces
    //     ProjectConfig.cwd to process.cwd() (the runfiles dir) and ignores any
    //     `config.cwd` we set, so the bin-tree files fall outside cwd and istanbul
    //     drops them -- instrument flag on, but zero counters emitted. chdir into
    //     the bin src dir is the only lever that moves ProjectConfig.cwd, so do
    //     that here. Only reached on coverage runs (not plain `bazel test`).
    try {
      config.rootDir = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
      config.roots = [config.rootDir];
      process.chdir(config.rootDir);
    } catch (_) {
      // Fall back to default rootDir/cwd if symlink resolution fails.
    }

    let coverageFile = path.basename(process.env.COVERAGE_OUTPUT_FILE);
    let coverageDirectory = path.dirname(process.env.COVERAGE_OUTPUT_FILE);

    // Users can opt out of auto-configured reporting to integrate their own coverage
    // reporters; in that case they're also responsible for split coverage processing.
    if (autoConfReporting) {
      if (process.env.SPLIT_COVERAGE_POST_PROCESSING == "1") {
        // In split coverage post-processing mode Bazel expects COVERAGE_OUTPUT_FILE to
        // be produced by lcov_merger, which runs as a separate action over everything
        // in COVERAGE_DIR. Emit at `COVERAGE_DIR/coverage.dat` for merger.sh to pick up.
        coverageDirectory = process.env.COVERAGE_DIR;
        coverageFile = "coverage.dat";
      }

      config.coverageDirectory = coverageDirectory;
      config.coverageReporters = ["text", ["lcovonly", { file: coverageFile }]];

      // Bazel's coverage merger expects SF paths to be workspace-relative
      // (e.g. src/cfgsvc/lib/app.js). With coverageProvider v8 the recorded
      // paths are absolute (or relative to cwd). Depending on platform they
      // resolve either into the bazel-out bin tree (Windows, where V8 follows
      // the symlink) or into the runfiles tree (Linux, default rootDir).
      // Rewrite both forms to workspace-relative short paths after Jest
      // finishes; runs on every platform (a best-effort, exit-time file
      // rewrite that cannot affect test execution).
      if (!process._jestCoverageRewriteRegistered) {
        process._jestCoverageRewriteRegistered = true;
        const covFilePath = path.join(coverageDirectory, coverageFile);
        const bindir = process.env.JS_BINARY__BINDIR;
        const binSuffix = bindir
          ? "/" + bindir.replace(/\\/g, "/") + "/"
          : null;
        // Runfiles-tree marker, e.g. `.runfiles/_main/`. On Linux the recorded
        // SF path runs through the runfiles tree
        //   src/node-mgr/test_/test.runfiles/_main/src/node-mgr/lib/cli.js
        // and resolving it below against a cwd that itself sits under the
        // runfiles root doubles the prefix -- so match with lastIndexOf (strip
        // to the innermost/source copy), NOT startsWith. This marker must be
        // tried BEFORE binSuffix: the runfiles tree lives under
        // bazel-out/<cfg>/bin/, so a bin-tree strip would fire first and leave
        // the nested `.../test.runfiles/_main/src/...` prefix in place.
        const workspace = process.env.JS_BINARY__WORKSPACE || "_main";
        const runfilesMarker = ".runfiles/" + workspace + "/";
        process.on("exit", () => {
          try {
            if (!existsSync(covFilePath)) return;
            const cwd = process.cwd();
            const lcov = readFileSync(covFilePath, "utf8");
            // Workspace-relative SF paths already present after rewrite -- used
            // to skip files that already have real coverage when backfilling.
            const presentPaths = new Set();
            const fixed = lcov.replace(/^SF:(.*)$/gm, (_, sfPath) => {
              // Windows records paths relative to the (bin-tree) rootDir as
              // `..\..\..\lib\app.js`; resolve them to absolute first.
              let abs = path.isAbsolute(sfPath)
                ? sfPath
                : path.resolve(cwd, sfPath);
              abs = abs.replace(/\\/g, "/");
              let ws = sfPath;
              // runfiles tree (Linux, default rootDir).
              const r = abs.lastIndexOf(runfilesMarker);
              if (r >= 0) {
                ws = abs.slice(r + runfilesMarker.length);
              } else if (binSuffix) {
                // bazel-out/<config>/bin/ tree (Windows, V8 follows the symlink).
                const b = abs.lastIndexOf(binSuffix);
                if (b >= 0) ws = abs.slice(b + binSuffix.length);
              }
              presentPaths.add(ws.replace(/\\/g, "/"));
              return "SF:" + ws;
            });
            // Backfill never-loaded source files at 0% (see _appendUntestedFiles).
            const withUntested = _appendUntestedFiles(
              fixed,
              config,
              presentPaths,
            );
            writeFileSync(covFilePath, withUntested);
          } catch (_) {
            // Best-effort rewrite; coverage still works without it
          }
        });
      }
    }
  }

  // Map Bazel's --test_filter (TESTBRIDGE_TEST_ONLY) to file-level filtering, matching
  // the semantics of other Bazel test rules like java_test which filter by class name.
  if (process.env.TESTBRIDGE_TEST_ONLY) {
    config.testRegex = process.env.TESTBRIDGE_TEST_ONLY;
  }

  if (process.env.JS_BINARY__LOG_DEBUG) {
    console.error(
      "DEBUG: aspect_rules_jest[jest_test]: config:",
      JSON.stringify(config, null, 2),
    );
  }

  return config;
}
