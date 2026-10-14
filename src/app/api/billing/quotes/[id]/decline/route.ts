// POST /api/billing/quotes/[id]/decline — sent → declined.
import { transitionQuote, type QuoteAction } from "@/lib/billing/quote-actions";

const ACTION: QuoteAction = "decline";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return transitionQuote(request, params, ACTION);
}
