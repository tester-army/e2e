/**
 * The browser `e2e login` opens, as the command it runs.
 *
 * The URL is the vendor's: in the device flow it is the `verification_uri`
 * the vendor's own response carries, so it is external input. It must never
 * reach a command interpreter, or a URL that carries `|`, `&`, or `^` runs a
 * command of its own on the user's machine. So the opener takes the URL as a
 * plain argument of a program that reads it verbatim: on Windows that is
 * `rundll32 url.dll,FileProtocolHandler`, the default handler for the URL's
 * scheme, and not `cmd /c start`, which reads the URL as a command line.
 *
 * Only an `http:` or `https:` URL is opened, the same rule the runner's
 * navigation follows. Anything else is left to the user, who reads the link
 * the CLI prints and opens it themselves.
 */

export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The schemes the opener opens, the ones a browser can follow. */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * The command that opens `url` in the user's browser, or undefined when the
 * URL is not one to open: a URL that does not parse, or one whose scheme is
 * not `http:` or `https:`. The argument is the parsed URL, so the value the
 * opener checks is the value it opens.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand | undefined {
  const openable = openableUrl(url);
  if (openable === undefined) return undefined;
  if (platform === 'darwin') return { command: 'open', args: [openable] };
  // `rundll32` hands the URL to the handler for its scheme as it is, with
  // no command line of its own for the URL to be read as.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', openable] };
  return { command: 'xdg-open', args: [openable] };
}

/** The URL the opener may open, normalized as the parser read it, or undefined for any other URL. */
function openableUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
}
