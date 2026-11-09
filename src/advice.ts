import { z } from 'zod';

export const reasons = {
  MISSING_INFO: 'Check whether the synthetic record is missing required information.',
  ELIGIBILITY: 'Review the synthetic eligibility record before deciding next steps.',
  DUPLICATE: 'Compare this record with other entries to confirm whether it is a duplicate.',
  OTHER: 'Review the adjustment and decide whether follow-up is needed.',
};
export type Reason = keyof typeof reasons;
export const draftSchema = z.object({
  summary: z.string().trim().min(1).max(220),
  nextStep: z.string().trim().min(1).max(300),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
export type AdviceInput = {reason: Reason; paid_cents: number; billed_cents: number};
export type Provider = (input: AdviceInput) => Promise<Draft>;

export function fallback(input: AdviceInput): Draft {
  return {summary: input.paid_cents ? 'Partial payment requires review.' : 'No payment recorded.', nextStep: reasons[input.reason]};
}
export function azureProvider(endpoint: string, key: string, deployment: string, request = fetch): Provider {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.openai.azure.com')) {
    throw new Error('Expected an HTTPS Azure OpenAI resource endpoint.');
  }
  return async input => {
    const res = await request(new URL('/openai/v1/chat/completions', url), {
      method:'POST', signal:AbortSignal.timeout(5000),
      headers:{'Content-Type':'application/json','api-key':key},
      body:JSON.stringify({
        model:deployment,response_format:{type:'json_object'},
        messages:[
          {role:'system',content:'Draft an internal work-queue note for a fictional claims demo. Return JSON with summary and nextStep string keys. Suggest review only. Never assert a coverage decision, approval, or required action.'},
          {role:'user',content:JSON.stringify(input)},
        ],
      }),
    });
    if(!res.ok) throw new Error('Draft provider unavailable');
    const data = await res.json();
    return draftSchema.parse(JSON.parse(data.choices?.[0]?.message?.content ?? 'null'));
  };
}
