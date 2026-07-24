const config = {
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  testEnvironment: "jest-environment-jsdom",
  // Only run the repo's own tests — .claude/worktrees holds stale checkouts
  // whose test copies would otherwise run (and pollute coverage) too.
  testPathIgnorePatterns: ["/node_modules/", "/\\.claude/"],
  // Keep the worktree checkouts out of the module map too, or their
  // tests/__mocks__/obsidian.ts registers as a duplicate manual mock and
  // wins module resolution over the real one.
  modulePathIgnorePatterns: ["/\\.claude/"],
  // Coverage counts EVERY source file, not just the ones tests import.
  // Excluded from the requirement: main.ts (Obsidian plugin lifecycle glue —
  // exercised end-to-end by the docker E2E) and quiz_writer.ts (SVG pointer
  // capture — pixel-tested by the component golden runner; jsdom has no
  // layout so unit tests there would assert nothing real).
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/main.ts",
    "!src/writer/quiz_writer.ts"
  ],
  // Codepath floor: every metric must stay above 65%.
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 65,
      lines: 65,
      statements: 65
    }
  },
  setupFiles: ["<rootDir>/tests/setup_obsidian_dom.ts"],
  transform: {
    "\\.tsx?$": ["@swc/jest", {
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
          dynamicImport: true
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true
        }
      }
    }]
  },
  transformIgnorePatterns: [
    "/node_modules/(?!\\.pnpm)/"
  ],
  moduleNameMapper: {
    "^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts"
  }
};

module.exports = config;
