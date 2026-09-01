import type { EmailMessage, MessageContent, Middleware, NormalizedMessage } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { patchMessage } from "../core/message.ts"
import { htmlToText } from "./html.ts"

export { htmlToText } from "./html.ts"

/** What a renderer produces. Returning only `html` is normal; `text` is
 *  derived for you unless you supply a better one. */
export interface RenderOutput {
  html: string
  text?: string
}

/**
 * Turns a `content` block into HTML. A renderer claims a message by
 * matching `content.type`, so adding React, MJML, or your own template
 * language is a package — the core never learns about it.
 *
 * ```ts
 * const markdown: Renderer = {
 *   name: "markdown",
 *   type: "markdown",
 *   render: (content) => ({ html: toHtml(content.source as string) }),
 * }
 * ```
 */
export interface Renderer {
  readonly name: string
  /** The `content.type` this renderer handles. */
  readonly type: string
  readonly render: (
    content: MessageContent,
    msg: NormalizedMessage,
  ) => RenderOutput | Promise<RenderOutput>
}

export interface RenderOptions {
  /** Derive `text` from the rendered HTML when the renderer and the
   *  message both leave it unset. Default: true — an HTML-only message
   *  scores worse with spam filters and is unreadable in a text client. */
  autoText?: boolean
}

/**
 * Resolve `message.content` into `html` before the driver sees it.
 *
 * The message is replaced, never mutated: a template object stays clean
 * and reusable across sends.
 *
 * ```ts
 * email.use(withRender(reactRenderer()))
 * await email.send({ to, subject, content: { type: "react", element: <Welcome /> } })
 * ```
 */
export function withRender(...args: [...Renderer[], RenderOptions] | Renderer[]): Middleware {
  const last = args.at(-1)
  const hasOptions = last != null && !isRenderer(last)
  const options = (hasOptions ? last : {}) as RenderOptions
  const renderers = (hasOptions ? args.slice(0, -1) : args) as Renderer[]
  const autoText = options.autoText ?? true
  const byType = new Map(renderers.map((renderer) => [renderer.type, renderer]))

  return defineMiddleware("render", (next) => async (msgs, ctx) => {
    const rendered = await Promise.all(
      msgs.map(async (msg) => {
        if (!msg.content) return msg
        const renderer = byType.get(msg.content.type)
        if (!renderer) {
          throw createError(
            ctx.driver,
            "INVALID_OPTIONS",
            `no renderer registered for content type ${JSON.stringify(msg.content.type)}`,
          )
        }
        const output = await renderer.render(msg.content, msg)
        const text = msg.text ?? output.text ?? (autoText ? htmlToText(output.html) : undefined)
        return patchMessage(msg, {
          html: output.html,
          ...(text == null ? {} : { text }),
          content: undefined,
        })
      }),
    )
    return next(rendered, ctx)
  })
}

/**
 * Declare a reusable message with typed variables. Returns a partial
 * message to spread into `send()`, so the call site stays one line and the
 * variables are checked at compile time.
 *
 * ```ts
 * const welcome = defineTemplate<{ name: string }>(({ name }) => ({
 *   subject: `Welcome, ${name}`,
 *   content: { type: "react", element: <Welcome name={name} /> },
 * }))
 *
 * await email.send({ to, ...welcome({ name: "Ada" }) })
 * ```
 */
export function defineTemplate<Vars = void>(
  build: (vars: Vars) => Partial<EmailMessage>,
): (vars: Vars) => Partial<EmailMessage> {
  return build
}

function isRenderer(value: Renderer | RenderOptions): value is Renderer {
  return typeof (value as Renderer).render === "function"
}
