// Resolve a contact by phone for the Growth UI (member read).
//
// GET /api/growth/contacts/resolve?phone=… → { contact } | 404

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const phone = (searchParams.get("phone") ?? "").trim();
  if (!phone) {
    return NextResponse.json({ error: "phone is required" }, { status: 400 });
  }
  const digits = phone.replace(/\D/g, "");
  const suffix = digits.slice(-8);
  if (suffix.length < 8) {
    return NextResponse.json({ error: "phone needs at least 8 digits" }, { status: 400 });
  }
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("contacts")
      .select("id, name, phone")
      .like("phone", `%${suffix}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "contact not found" }, { status: 404 });
    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
