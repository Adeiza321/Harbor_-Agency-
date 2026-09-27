import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const { data: me } = await admin.from("profiles").select("role,status").eq("id", caller.user.id).single();
    if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can manage accounts" }, 403);

    const body = await req.json();
    const action = body.action || "create";

    if (action === "create") {
      const { email, password, full_name, role } = body;
      if (!["admin", "recops", "recruiter"].includes(role)) return json({ error: "Invalid role" }, 400);
      if (!email || !String(email).includes("@")) return json({ error: "Enter a valid email" }, 400);
      if (!password || String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: String(email).trim().toLowerCase(),
        password,
        email_confirm: true,
        user_metadata: { full_name: full_name || "" },
        app_metadata: { role },
      });
      if (error) return json({ error: error.message }, 400);

      const level = role === "admin" ? "Admin, owner" : role === "recops" ? "Rec Ops manager" : "Recruiter";
      const { error: pErr } = await admin.from("profiles")
        .update({ status: "Active", role, level, full_name: full_name || "" }).eq("id", data.user.id);
      if (pErr) return json({ error: pErr.message }, 500);
      return json({ ok: true, id: data.user.id });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "Missing id" }, 400);
      if (id === caller.user.id) return json({ error: "You can't delete your own account" }, 400);
      const { data: target } = await admin.from("profiles").select("is_owner,full_name").eq("id", id).single();
      if (!target) return json({ error: "User not found" }, 404);
      if (target.is_owner) return json({ error: "The owner can't be deleted. Transfer ownership first." }, 400);

      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) {
        // Postgres FK violation: this person created jobs, placements, engagements or
        // campaigns that reference their profile, so a hard delete would orphan those
        // records and is blocked at the database level. Disable them instead.
        const msg = /foreign key|violates/i.test(error.message)
          ? "Can't delete " + (target.full_name || "this user") + " — they have jobs, placements or other records tied to their account. Disable them instead."
          : error.message;
        return json({ error: msg }, 400);
      }
      return json({ ok: true });
    }

    if (action === "set_password") {
      const { id, password } = body;
      if (!id) return json({ error: "Missing id" }, 400);
      if (!password || String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
