const config = {
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  testEnvironment: "jest-environment-jsdom",
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
