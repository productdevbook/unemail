import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/providers/smtp.ts',
    'src/providers/resend.ts',
    'src/providers/aws-ses.ts',
    'src/providers/http.ts',
    'src/providers/zeptomail.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  unbundle: true,
  external: [
    'nodemailer',
    'resend',
    '@aws-sdk/client-ses',
    'ofetch',
  ],
  noExternal: [
    'zeptomail',
  ],
})
