// Auto-generated using scripts/gen-providers.
// Do not manually edit!

import type { AwsSesEmailOptions as AwsSesOptions } from "unemail/providers/aws-ses";
import type { HttpOptions as HttpOptions } from "unemail/providers/http";
import type { ResendOptions as ResendOptions } from "unemail/providers/resend";
import type { SmtpOptions as SmtpOptions } from "unemail/providers/smtp";
import type { ZeptomailOptions as ZeptomailOptions } from "unemail/providers/zeptomail";

export type BuiltinProviderName = "aws-ses" | "awsSes" | "http" | "resend" | "smtp" | "zeptomail";

export type BuiltinProviderOptions = {
  "aws-ses": AwsSesOptions;
  "awsSes": AwsSesOptions;
  "http": HttpOptions;
  "resend": ResendOptions;
  "smtp": SmtpOptions;
  "zeptomail": ZeptomailOptions;
};

export const builtinProviders = {
  "aws-ses": "unemail/providers/aws-ses",
  "awsSes": "unemail/providers/aws-ses",
  "http": "unemail/providers/http",
  "resend": "unemail/providers/resend",
  "smtp": "unemail/providers/smtp",
  "zeptomail": "unemail/providers/zeptomail",
} as const;
