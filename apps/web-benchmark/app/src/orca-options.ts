/**
 * Which models the OrcaRouter entry points offer, decided from the record's
 * own metadata and nothing else. This is the browser-side twin of
 * `selectModels` in `packages/e2e/src/oauth/orcarouter-catalog.ts`: the same
 * records, the same capabilities, the same fail-closed rule. It lives here
 * rather than in the published package because this fixture app may not import
 * `e2e/src`, and one readable copy is what lets the parity check pin the two
 * against each other.
 *
 * A record that does not declare the endpoint type or the input modality an
 * entry point needs is absent from that entry point's list. Nothing is ever
 * inferred from a model's name.
 */

/** A model the catalog lists, reduced to the fields a model control needs. */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly contextLength?: number;
  readonly endpointTypes: readonly string[];
  readonly inputModalities: readonly string[];
}

/** One kind of request an entry point sends; each filters the catalog its own way. */
export type Capability = "chat" | "multimodal" | "embedding" | "image" | "video" | "rerank";

/** Endpoint types the OpenAI-compatible chat client can speak, in the catalog's own spelling. */
const CHAT_ENDPOINT_TYPES = ["openai", "anthropic", "gemini", "openai-response"] as const;

const ALL_ENDPOINT_TYPES = new Set<string>([
  ...CHAT_ENDPOINT_TYPES,
  "openai-video",
  "image-generation",
  "embeddings",
  "jina-rerank",
]);

const ALL_MODALITIES = new Set(["text", "image", "audio", "video"]);

/** The endpoint types a capability may serve, from the catalog's vocabulary. */
function endpointTypesFor(capability: Capability): readonly string[] {
  switch (capability) {
    case "chat":
    case "multimodal":
      return CHAT_ENDPOINT_TYPES;
    case "embedding":
      return ["embeddings"];
    case "image":
      return ["image-generation"];
    case "video":
      return ["openai-video"];
    case "rerank":
      return ["jina-rerank"];
  }
}

/** The non-text input modalities a capability must have declared. */
function requiredInputModalities(capability: Capability): readonly string[] {
  return capability === "multimodal" ? ["image"] : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** One record from the endpoint's `data[]`, or undefined when it carries no usable id. */
function readRecord(entry: unknown): CatalogModel | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly context_length?: unknown;
    readonly supported_endpoint_types?: unknown;
    readonly architecture?: { readonly input_modalities?: unknown } | undefined;
  };
  const id = record.id;
  if (typeof id !== "string" || id === "") return undefined;
  const name = record.name;
  const contextLength = record.context_length;
  return {
    id,
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    ...(typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0
      ? { contextLength }
      : {}),
    endpointTypes: strings(record.supported_endpoint_types).filter((type) => ALL_ENDPOINT_TYPES.has(type)),
    inputModalities: strings(record.architecture?.input_modalities).filter((modality) => ALL_MODALITIES.has(modality)),
  };
}

/** Every usable record in a `GET /models` body, in the order the endpoint sent them. */
export function readCatalog(body: unknown): CatalogModel[] {
  const data = (body as { readonly data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const models: CatalogModel[] = [];
  for (const entry of data) {
    const model = readRecord(entry);
    if (model !== undefined) models.push(model);
  }
  return models;
}

/** The models one capability may offer: a declared endpoint type, then every required modality. */
export function modelsFor(models: readonly CatalogModel[], capability: Capability): CatalogModel[] {
  const endpointTypes = endpointTypesFor(capability);
  const required = requiredInputModalities(capability);
  return models.filter((model) => {
    if (!endpointTypes.some((type) => model.endpointTypes.includes(type))) return false;
    return required.every((modality) => model.inputModalities.includes(modality));
  });
}

/** The one line a `<select>` shows for a model: the id a config passes, and what the catalog declares. */
export function describeModel(model: CatalogModel, capability: Capability): string {
  const facts = [
    model.endpointTypes.length === 0 ? undefined : model.endpointTypes.join("/"),
    model.contextLength === undefined ? undefined : `${model.contextLength.toLocaleString("en-US")} ctx`,
    capability === "multimodal" ? "image in" : undefined,
  ].filter((part): part is string => part !== undefined);
  return facts.length === 0 ? model.id : `${model.id} — ${facts.join(", ")}`;
}
