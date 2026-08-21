// Extra esbuild options for the Bazel :component_harness bundle — mirrors the
// `--alias:obsidian=./tests/obsidian_browser_stub.ts` flag of the npm
// build:e2e script. esbuild resolves the substitution relative to its working
// directory, which under Bazel is the output bin dir, so the path is spelled
// from there.
export default {
  alias: {
    obsidian:
      './obsidian/obsidian-hanzi-practice/tests/obsidian_browser_stub.ts',
  },
};
