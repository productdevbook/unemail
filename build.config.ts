import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    'src/index',
    { input: 'src/providers/http', name: 'providers/http' },
    { input: 'src/providers/mailcrab', name: 'providers/mailcrab' },
    { input: 'src/providers/aws-ses', name: 'providers/aws-ses' },
    { input: 'src/providers/resend', name: 'providers/resend' },
    { input: 'src/providers', name: 'providers/base' },
    { input: 'src/types/index.ts' },
    { input: 'src/utils/index.ts' },
  ],
  declaration: 'node16',
  clean: true,
  rollup: {
    emitCJS: false, // No CommonJS output
  },
})
