import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { vscode: new URL('./test/vscode-mock.ts', import.meta.url).pathname } },
});
