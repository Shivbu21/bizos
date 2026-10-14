// ============================================================
// Instagram comment-to-DM trigger engine.
//
// Flow:
//   1. Meta GET-verifies our webhook URL (hub.mode / hub.challenge /
//      hub.verify_token, matched against the account's instagram
//      lead_source row).
//   2. Meta POSTs comment events (entry[].changes[] with field
//      "comments" and value {text, from:{id,username}, media}).
//   3. Each comment is matched against the account's active
//      `keyword_rules` (case-insensitive substring). On a hit we
//      create/find a lead, log `keyword.matched`, and queue a DM
//      action.
//
// DM delivery — STUB, clearly marked. Sending a real Instagram DM
// needs a Meta app with the instagram_manage_messages permission,
// a connected IG Business/Creator account, and a Page access token.
// Until `META_IG_PAGE_ACCESS_TOKEN` is set, `queueDmAction` only
// logs `dm.queued` with `delivered: false` so the intent is visible
// in lead_events without pretending a message went out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestLead, logLeadEvent } from './ingest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export interface InstagramComment {
  commentId: string;
  text: string;
  fromId: string | null;
  fromUsername: string | null;
  mediaId: string | null;
}

/** Pull comment objects out of a Meta instagram webhook body. */
export function extractComments(body: AnyRecord): InstagramComment[] {
  const out: InstagramComment[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'comments') continue;
      const v = change?.value ?? {};
      const text = typeof v.text === 'string' ? v.text : '';
      if (!text) continue;
      out.push({
        commentId: String(v.id ?? ''),
        text,
        fromId: v.from?.id != null ? String(v.from.id) : null,
        fromUsername: typeof v.from?.username === 'string' ? v.from.username : null,
        mediaId: v.media?.id != null ? String(v.media.id) : null,
      });
    }
  }
  return out;
}

export interface KeywordRule {
  id: string;
  keyword: string;
  reply_template: string;
}

/** Case-insensitive substring match. Returns the first matching rule. */
export function matchKeywordRule(
  text: string,
  rules: KeywordRule[],
): KeywordRule | null {
  const lowered = text.toLowerCase();
  for (const rule of rules) {
    if (rule.keyword && lowered.includes(rule.keyword.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

export function renderReplyTemplate(template: string, name: string | null): string {
  return template.replace(/\{\{\s*name\s*\}\}/g, name ?? 'there');
}

export interface DmQueueResult {
  /** False until META_IG_PAGE_ACCESS_TOKEN is configured. */
  delivered: boolean;
  reason: string;
}

/**
 * STUB — queue/send the DM reply.
 *
 * CREDENTIAL PLUG-IN POINT: set META_IG_PAGE_ACCESS_TOKEN (a Page
 * access token for the Meta app that owns the webhook subscription)
 * and META_IG_PAGE_ID. When both are present, replace the stub body
 * with a POST to
 *   https://graph.facebook.com/v21.0/me/messages
 * with recipient {id: <igScopedUserId>} and message {text}.
 * Instagram DMs go to the IG-scoped user id from the comment's
 * `from.id` — it is NOT the app-scoped id used elsewhere.
 */
export async function queueDmAction(
  _supabase: SupabaseClient,
  _accountId: string,
  _comment: InstagramComment,
  _replyText: string,
): Promise<DmQueueResult> {
  const token = process.env.META_IG_PAGE_ACCESS_TOKEN;
  const pageId = process.env.META_IG_PAGE_ID;
  if (!token || !pageId) {
    return {
      delivered: false,
      reason:
        'META_IG_PAGE_ACCESS_TOKEN / META_IG_PAGE_ID not configured — DM action logged only',
    };
  }
  // Credentials present but the Graph send is intentionally not
  // wired yet: verify the token + permission set in the Meta
  // dashboard first, then implement the POST here.
  return {
    delivered: false,
    reason: 'Graph DM send not implemented yet — see stub docs in instagram.ts',
  };
}

export interface CommentHandleResult {
  commentId: string;
  matchedKeyword: string | null;
  leadId: string | null;
  dmDelivered: boolean;
}

/** Full per-comment pipeline: match → lead → DM stub. */
export async function handleInstagramComment(
  supabase: SupabaseClient,
  accountId: string,
  leadSourceId: string | null,
  comment: InstagramComment,
  rules: KeywordRule[],
): Promise<CommentHandleResult> {
  const rule = matchKeywordRule(comment.text, rules);
  if (!rule) {
    return { commentId: comment.commentId, matchedKeyword: null, leadId: null, dmDelivered: false };
  }

  const name = comment.fromUsername ? `@${comment.fromUsername}` : null;
  const { leadId } = await ingestLead(supabase, {
    accountId,
    leadSourceId,
    source: 'instagram',
    lead: {
      name,
      phone: null,
      email: null,
      campaign: comment.mediaId ? `ig_media:${comment.mediaId}` : null,
      extra: { ig_user_id: comment.fromId, ig_comment_id: comment.commentId },
    },
    rawPayload: { comment },
  });

  await logLeadEvent(supabase, accountId, leadId, 'keyword.matched', {
    keyword: rule.keyword,
    comment_id: comment.commentId,
    from_username: comment.fromUsername,
  });

  const replyText = renderReplyTemplate(rule.reply_template, name);
  const dm = await queueDmAction(supabase, accountId, comment, replyText);
  await logLeadEvent(supabase, accountId, leadId, dm.delivered ? 'dm.sent' : 'dm.queued', {
    keyword: rule.keyword,
    comment_id: comment.commentId,
    delivered: dm.delivered,
    reason: dm.reason,
  });

  return {
    commentId: comment.commentId,
    matchedKeyword: rule.keyword,
    leadId,
    dmDelivered: dm.delivered,
  };
}
