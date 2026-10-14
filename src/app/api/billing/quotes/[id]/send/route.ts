// POST /api/billing/quotes/[id]/send — draft → sent.
import { transitionQuote, type QuoteAction } from "@/lib/billing/quote-actions";

const ACTION: QuoteAction = "send";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return transitionQuote(request, params, ACTION);
}
