import type {
  Experimental_DecisionModelV4 as DecisionModel,
  Experimental_DecisionModelV4Answer as DecisionAnswer,
  Experimental_DecisionModelV4CallOptions as DecisionCallOptions,
  Experimental_DecisionModelV4Result as DecisionResult,
  JSONValue,
} from '@ai-sdk/provider';
import { InvalidResponseDataError } from '@ai-sdk/provider';
import {
  combineHeaders,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  loadApiKey,
  loadOptionalSetting,
  parseProviderOptions,
  postJsonToApi,
  withoutTrailingSlash,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod';
/**
 * The OpenAI Decisions API as an AI SDK decision model, with image input.
 * Mirrors `openai.decisionModel()` from `@ai-sdk/openai` 4.0.86 (request
 * mapping, answer validation, confidence under `providerMetadata.openai`),
 * and additionally sends a screenshot passed as
 * `providerOptions.decision.screenshot` beside the JSON state, which the
 * SDK's own model cannot do yet. Temporary: it goes away once the SDK model
 * takes images.
 */
export interface OpenAIDecisionModelOptions {
  /** Defaults to `gpt-6-luna`, the only model the Decisions API serves. */
  readonly modelId?: string;
  /** Defaults to `OPENAI_API_KEY`. */
  readonly apiKey?: string;
  /** Defaults to `OPENAI_BASE_URL`, then `https://api.openai.com/v1`. */
  readonly baseURL?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}
/** What `providerOptions.decision.screenshot` carries: the image as base64. */
const screenshotSchema = z.object({
  mediaType: z.literal('image/png'),
  data: z.string(),
});
const decisionOptionsSchema = zodSchema(z.object({ screenshot: screenshotSchema.optional() }));
const openaiOptionsSchema = zodSchema(z.object({ safetyIdentifier: z.string().max(128).optional() }));
const probability = z.number().min(0).max(1);
const responseSchema = z.object({
  model: z.string().nullish(),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      input_tokens_details: z.object({ cached_tokens: z.number().nullish(), cache_write_tokens: z.number().nullish() }).nullish(),
      output_tokens: z.number().nullish(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('refusal'), name: z.string().nullable() }),
      z.object({ type: z.literal('predicate'), name: z.string(), probability }),
      z.object({
        type: z.literal('choice'),
        name: z.string(),
        choice: z.string(),
        confidence: probability.nullish(),
        probabilities: z.array(z.object({ value: z.string(), probability })),
      }),
      z.object({
        type: z.literal('score'),
        name: z.string(),
        score: z.number(),
        confidence: probability.nullish(),
        probabilities: z.array(z.object({ value: z.number().int().nonnegative(), probability })),
      }),
    ]),
  ),
});
const errorSchema = z.object({
  error: z.object({ message: z.string(), type: z.string().nullish(), param: z.any().nullish(), code: z.union([z.string(), z.number()]).nullish() }),
});
const failedResponseHandler = createJsonErrorResponseHandler({ errorSchema: zodSchema(errorSchema), errorToMessage: (data) => data.error.message });
/** JSON text for an instruction, criterion, or the state. */
function toText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}
/** Builds a decision model over the OpenAI Decisions API that also takes a screenshot. */
export function openaiDecisionModel(options: OpenAIDecisionModelOptions = {}): DecisionModel {
  const baseURL =
    withoutTrailingSlash(loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: 'OPENAI_BASE_URL' })) ??
    'https://api.openai.com/v1';
  const modelId = options.modelId ?? 'gpt-6-luna';
  const headers = (): Record<string, string | undefined> => ({
    Authorization: `Bearer ${loadApiKey({ apiKey: options.apiKey, environmentVariableName: 'OPENAI_API_KEY', description: 'OpenAI' })}`,
    ...options.headers,
  });
  return {
    specificationVersion: 'v4',
    provider: 'openai.decision',
    modelId,
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    async doDecide({ state, questions, headers: callHeaders, abortSignal, providerOptions }: DecisionCallOptions): Promise<DecisionResult> {
      const decision = await parseProviderOptions({ provider: 'decision', providerOptions, schema: decisionOptionsSchema });
      const openai = await parseProviderOptions({ provider: 'openai', providerOptions, schema: openaiOptionsSchema });
      const text = toText(state);
      const screenshot = decision?.screenshot;
      const input =
        screenshot === undefined
          ? text
          : [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text },
                  { type: 'input_image', image_url: `data:${screenshot.mediaType};base64,${screenshot.data}` },
                ],
              },
            ];
      const { value: response, rawValue, responseHeaders } = await postJsonToApi({
        url: `${baseURL}/decisions`,
        headers: combineHeaders(headers(), callHeaders),
        body: {
          model: modelId,
          safety_identifier: openai?.safetyIdentifier,
          input,
          questions: Object.entries(questions).map(([name, question]) => {
            const instructions = toText(question.instructions);
            switch (question.type) {
              case 'boolean':
                return {
                  type: 'predicate',
                  name,
                  instructions: [
                    instructions,
                    question.criteria?.true == null ? undefined : `Criteria for true:\n${toText(question.criteria.true)}`,
                    question.criteria?.false == null ? undefined : `Criteria for false:\n${toText(question.criteria.false)}`,
                  ]
                    .filter((part) => part !== undefined)
                    .join('\n\n'),
                };
              case 'choice':
                return {
                  type: 'choice',
                  name,
                  instructions,
                  choices: Object.entries(question.criteria).map(([value, description]) => ({
                    value,
                    ...(description == null ? {} : { description: toText(description) }),
                  })),
                };
              case 'score':
                return {
                  type: 'score',
                  name,
                  instructions,
                  levels: question.criteria.map((description, index) => ({
                    label: String(index),
                    ...(description == null ? {} : { description: toText(description) }),
                  })),
                };
            }
          }),
        },
        ...(abortSignal === undefined ? {} : { abortSignal }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        failedResponseHandler,
        successfulResponseHandler: createJsonResponseHandler(zodSchema(responseSchema)),
      });
      const answers: Record<string, DecisionAnswer> = {};
      for (const answer of response.answers) {
        if (answer.type === 'refusal') {
          if (answer.name === null) throw new InvalidResponseDataError({ data: rawValue, message: 'OpenAI Decisions refused an unnamed question.' });
          answers[answer.name] = { type: 'refusal' };
          continue;
        }
        if (answer.type === 'predicate') {
          answers[answer.name] = { type: 'boolean', probability: answer.probability };
          continue;
        }
        const probabilities = Object.fromEntries(answer.probabilities.map(({ value, probability: p }) => [String(value), p]));
        if (Object.keys(probabilities).length !== answer.probabilities.length) {
          throw new InvalidResponseDataError({ data: rawValue, message: 'Decisions returned duplicate probability values.' });
        }
        answers[answer.name] =
          answer.type === 'choice'
            ? { type: 'choice', choice: answer.choice, probabilities }
            : { type: 'score', score: answer.score, probabilities };
      }
      const names = response.answers.map((answer) => answer.name);
      const complete =
        names.length === Object.keys(questions).length &&
        new Set(names).size === names.length &&
        names.every((name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(questions, name));
      if (!complete) {
        throw new InvalidResponseDataError({ data: rawValue, message: 'Decisions must return exactly one answer for every question.' });
      }
      const confidence: Record<string, number> = {};
      for (const answer of response.answers) {
        if ((answer.type === 'choice' || answer.type === 'score') && answer.confidence != null) confidence[answer.name] = answer.confidence;
      }
      const inputTokens = response.usage?.input_tokens ?? undefined;
      const outputTokens = response.usage?.output_tokens ?? undefined;
      return {
        answers,
        ...(response.usage == null
          ? {}
          : { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }),
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
        warnings: [],
        providerMetadata: {
          openai: { ...(response.usage == null ? {} : { usage: response.usage as JSONValue }), confidence },
        },
        response: { modelId: response.model ?? modelId, ...(responseHeaders === undefined ? {} : { headers: responseHeaders }), body: rawValue },
      };
    },
  };
}
