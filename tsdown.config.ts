import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: 'cjs',
  inputOptions: { platform: 'browser' },
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  target: 'chrome120',
  dts: false,
  sourcemap: false,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "@spectershell/dsh-harness-zcode", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
