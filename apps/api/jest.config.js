module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  // Applies the global libvips cache configuration to every worker.
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^@deep-zoom/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
  },
  // Integration specs spin up an in-memory MongoDB instance and real Sharp
  // pipelines, so they need more room than the Jest defaults.
  testTimeout: 120_000,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
};
