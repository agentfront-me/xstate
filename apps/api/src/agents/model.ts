// The language model for a run, with the organization's own key. Calls go through AI Gateway when AI_GATEWAY_ID is
// set (per-request logs, token counts and rate limits on Cloudflare's side); otherwise straight to the provider.

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ProviderId } from './config'

export async function languageModel(env: Env, provider: ProviderId, modelId: string, apiKey: string): Promise<LanguageModel> {
  // The gateway URL ends at the provider (…/<gateway>/anthropic). Anthropic's SDK wants the /v1 base; OpenAI's
  // gateway path already maps to /v1.
  const gateway = env.AI_GATEWAY_ID ? await env.AI.gateway(env.AI_GATEWAY_ID).getUrl(provider) : undefined
  if (provider === 'anthropic') return createAnthropic({ apiKey, baseURL: gateway ? `${gateway}/v1` : undefined })(modelId)
  return createOpenAI({ apiKey, baseURL: gateway })(modelId)
}
