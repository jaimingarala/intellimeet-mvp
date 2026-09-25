import { defineConfig } from 'vitest/config';

/**
 * Vitest for the client, deliberately narrow.
 *
 * What has tests here is the part of the client that is *logic* rather than
 * rendering: `src/lib/webrtc.js`, where a mistake is invisible until two peers
 * fail to connect and there is no error to read. React components are covered by
 * the server's API suites plus the browser rehearsal of the demo path; a
 * component renderer with a mocked socket would mostly assert that React works.
 *
 * `environment: 'node'` because nothing here touches the DOM — the test setup
 * provides the two WebRTC globals the module constructs.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // Scoped to the module under test: a whole-SPA number would be a small,
      // meaningless figure dominated by JSX that this suite doesn't render.
      include: ['src/lib/**/*.js'],
      // These modules are small and pure, so this is a floor that says
      // "untested code was added", not a target to creep toward. The server's
      // floor is looser because it has genuinely awkward branches (a mail
      // webhook that fails, a provider that rate-limits) that are not worth
      // faking a network to reach.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
