// Shared send helpers for the growth module.
//
// Reuses the base template's proven Meta sender (`engineSendText`)
// — no reimplemented WhatsApp code. The owner-user and conversation
// resolution mirrors src/lib/followups/send.ts.

import { engineSendText } from "@/lib/automations/meta-send";

type AdminClient = ReturnType<
  typeof import("@/lib/automations/admin-client").supabaseAdmin
>;

/** The admin who saved the WhatsApp config — sender-of-record. */
export async function resolveOwnerUserId(
  admin: AdminClient,
  accountId: string,
): Promise<string | null> {
  const { data: config } = await admin
    .from("whatsapp_config")
    .select("user_id")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (config as { user_id?: string | null } | null)?.user_id ?? null;
}

export async function findOrCreateConversationId(
  admin: AdminClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      status: "open",
    })
    .select("id")
    .single();
  if (error || !created) {
    throw new Error(`could not open conversation: ${error?.message ?? "unknown"}`);
  }
  return created.id as string;
}

/** Send a plain-text WhatsApp message to a contact. Throws when the
 *  account has no WhatsApp config — callers decide how to surface it. */
export async function sendTextToContact(
  admin: AdminClient,
  accountId: string,
  contactId: string,
  text: string,
): Promise<string> {
  const ownerUserId = await resolveOwnerUserId(admin, accountId);
  if (!ownerUserId) {
    throw new Error("no WhatsApp config for this account");
  }
  const conversationId = await findOrCreateConversationId(
    admin,
    accountId,
    ownerUserId,
    contactId,
  );
  const result = await engineSendText({
    accountId,
    userId: ownerUserId,
    conversationId,
    contactId,
    text,
  });
  return result.whatsapp_message_id;
}
