// POST /api/billing/quotes/[id]/accept — sent → accepted.
import { transitionQuote, type QuoteAction } from "@/lib/billing/quote-actions";

const ACTION: QuoteAction = "accept";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return transitionQuote(request, params, ACTION);
}
