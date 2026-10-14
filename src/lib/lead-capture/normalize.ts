// ============================================================
// Provider payload normalization.
//
// Each supported source posts a different shape. This module maps
// them all onto one NormalizedLead so the ingestion path below
// doesn't care which provider sent the webhook. Unknown shapes
// degrade gracefully: fields that can't be found stay null and the
// raw payload is always preserved in `leads.raw_payload` for audit
// and re-mapping.
//
// Supported `lead_sources.type` values:
//   facebook_lead_ads — Meta Lead Ads webhook (field_data array)
//   justdial          — Justdial lead webhook (flat fields)
//   web_form          — generic website contact form (name/phone/email/message)
// ============================================================

export type LeadSourceType = 'facebook_lead_ads' | 'justdial' | 'web_form' | 'instagram';

export interface NormalizedLead {
  name: string | null;
  phone: string | null;
  email: string | null;
  campaign: string | null;
  /** Extra provider-specific bits worth keeping on the lead row. */
  extra: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Case-insensitive key lookup — providers are inconsistent about case. */
function pick(obj: AnyRecord, ...keys: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const k of Object.keys(obj)) lower.set(k.toLowerCase(), obj[k]);
  for (const key of keys) {
    const v = lower.get(key.toLowerCase());
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeFacebookLeadAds(body: AnyRecord): NormalizedLead {
  // Meta delivers leadgen webhooks as entry[].changes[] with
  // value.field_data = [{name, values[]}]. The common fields are
  // full_name, phone_number, email; everything else is custom.
  const fieldData: AnyRecord[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const fd = change?.value?.field_data;
      if (Array.isArray(fd)) fieldData.push(...fd);
    }
  }
  // Also tolerate a flat test payload (the dashboard "send test lead").
  const flat = fieldData.length === 0;

  const get = (name: string): string | null => {
    if (!flat) {
      const f = fieldData.find(
        (fd) => typeof fd.name === 'string' && fd.name.toLowerCase() === name.toLowerCase(),
      );
      return str(f?.values?.[0]);
    }
    return str(pick(body, name));
  };

  const name =
    get('full_name') ??
    ([get('first_name'), get('last_name')].filter(Boolean).join(' ') || null);

  return {
    name,
    phone: get('phone_number') ?? get('phone') ?? get('mobile'),
    email: get('email'),
    campaign: str(pick(body, 'campaign_name', 'ad_name', 'form_name')),
    extra: {
      leadgen_id: str(pick(body, 'leadgen_id')),
      page_id: str(pick(body, 'page_id')),
      form_id: str(pick(body, 'form_id')),
    },
  };
}

function normalizeJustdial(body: AnyRecord): NormalizedLead {
  return {
    name: str(pick(body, 'name', 'sender_name', 'lead_name', 'caller_name')),
    phone: str(pick(body, 'mobile', 'phone', 'phone_number', 'sender_mobile')),
    email: str(pick(body, 'email', 'sender_email')),
    campaign: str(pick(body, 'campaign', 'category', 'lead_category')),
    extra: {
      city: str(pick(body, 'city')),
      date: str(pick(body, 'date', 'lead_date')),
    },
  };
}

function normalizeWebForm(body: AnyRecord): NormalizedLead {
  return {
    name: str(pick(body, 'name', 'full_name', 'fullName')),
    phone: str(pick(body, 'phone', 'mobile', 'phone_number', 'phoneNumber')),
    email: str(pick(body, 'email')),
    campaign: str(pick(body, 'campaign', 'source_page', 'page', 'form_id')),
    extra: {
      message: str(pick(body, 'message', 'notes', 'query')),
    },
  };
}

/**
 * Normalize a provider webhook body. Throws on an unknown source
 * type — the route maps that to a 400, never a 500.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeLeadPayload(type: LeadSourceType, body: any): NormalizedLead {
  const obj: AnyRecord =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  switch (type) {
    case 'facebook_lead_ads':
      return normalizeFacebookLeadAds(obj);
    case 'justdial':
      return normalizeJustdial(obj);
    case 'web_form':
      return normalizeWebForm(obj);
    case 'instagram':
      // Instagram leads are created by the comment trigger engine,
      // not by this normalizer.
      throw new Error('instagram leads are created via the comment trigger, not webhooks');
    default:
      throw new Error(`unknown lead source type: ${type}`);
  }
}
