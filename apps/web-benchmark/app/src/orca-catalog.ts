/**
 * How the scenario reads the model catalog. The controls never build a list of
 * their own: they ask here, and what comes back is a `GET /v1/models` body.
 *
 * In this fixture app the body is the one the live endpoint answered
 * (`public/orca/catalog.json`, recorded through the provider's own catalog
 * code), served from the app's own origin. The request is asynchronous and can
 * fail, which is the point: an entry point has to show the live answer, a
 * bounded degraded answer when the catalog cannot be read, and never a field
 * the user types a model id into.
 */

import { readCatalog, type CatalogModel } from "./orca-options";

/** Where the catalog JSON is read from. */
const CATALOG_URL = "/orca/catalog.json";

export interface CatalogLoad {
  readonly models: readonly CatalogModel[];
  /** True when the live catalog could not be read; the controls say so and offer fewer models. */
  readonly degraded: boolean;
  /** Why it is degraded, for the status line. Never carries a credential. */
  readonly reason?: string;
}

/**
 * The models this workspace can call when the catalog cannot be read. Three
 * ids, each observed in the live `GET https://api.orcarouter.ai/v1/models`
 * answer, each with the metadata that answer declares: `orcarouter/auto`
 * carries no capability and always routes, `deepseek/deepseek-v4-pro` is
 * text-only, `deepseek/deepseek-v4-flash-vision-exp` declares image input.
 * The OpenAI, Anthropic, and Google namespaces are absent on purpose — the
 * live catalog advertises none of them, so nothing here is guessed from a
 * name.
 */
const VERIFIED_FALLBACK_CATALOG: readonly CatalogModel[] = [
  { id: "orcarouter/auto", endpointTypes: ["openai", "anthropic", "gemini", "openai-response"], inputModalities: [] },
  {
    id: "deepseek/deepseek-v4-pro",
    contextLength: 1_048_576,
    endpointTypes: ["openai", "openai-response"],
    inputModalities: ["text"],
  },
  {
    id: "deepseek/deepseek-v4-flash-vision-exp",
    contextLength: 1_048_576,
    endpointTypes: ["openai", "openai-response", "anthropic"],
    inputModalities: ["text", "image"],
  },
];

/**
 * Reads the catalog. A non-OK answer or a body that is not the expected shape
 * degrades to the verified seed rather than throwing, so a control can always
 * render a state instead of an empty promise. The seed is never mixed into a
 * live answer.
 */
export async function loadCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogLoad> {
  try {
    const response = await fetchImpl(CATALOG_URL, { headers: { accept: "application/json" } });
    if (!response.ok) return degraded(`the model catalog answered HTTP ${response.status}`);
    const models = readCatalog(await response.json());
    if (models.length === 0) return degraded("the model catalog listed no models");
    return { models, degraded: false };
  } catch (cause) {
    return degraded(cause instanceof Error ? cause.message : String(cause));
  }
}

function degraded(reason: string): CatalogLoad {
  return { models: VERIFIED_FALLBACK_CATALOG, degraded: true, reason };
}
