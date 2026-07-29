/** Stub: Webhook validation. */
export function validateWebhookUrl(url: string): { valid: boolean; error?: string } {
  return { valid: !!url };
}
