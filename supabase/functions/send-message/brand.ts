// Email branding: your agency's name (and logo, if set) from Agency settings, in your green.
// The same file is copied into every function that sends email, so all emails look alike.
export type Brand = { name: string; logo: string | null; color: string; address?: string };

export async function loadBrand(admin: any): Promise<Brand> {
  try {
    const { data } = await admin.from("agency_settings").select("agency_name,company,outreach").limit(1).maybeSingle();
    const company = (data?.company && typeof data.company === "object") ? data.company : {};
    const logo = String(company.logoUrl || "").trim();
    const address = String(company.address || data?.outreach?.businessAddress || "").trim();
    return { name: String(data?.agency_name || company.name || "Pronext").trim() || "Pronext", logo: /^https:\/\//.test(logo) ? logo : null, color: "#1F6F54", address };
  } catch { return { name: "Pronext", logo: null, color: "#1F6F54" }; }
}

export function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c] || c);
}

// Candidate emails leave `footer` empty and pass their unsubscribe link; staff emails pass their own footer line.
export function emailShell(b: Brand, preheader: string, bodyHtml: string, footer?: string, unsubscribeUrl?: string) {
  const mark = b.logo
    ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" height="32" style="height:32px;max-width:180px;display:block;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:32px;height:32px;border-radius:8px;background:#12241D;color:#C8F169;text-align:center;font-family:Georgia,serif;font-size:18px;line-height:32px;">${esc(b.name.charAt(0).toUpperCase())}</td><td style="padding-left:10px;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#14201B;">${esc(b.name)}</td></tr></table>`;
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#F3EFE7;font-family:Georgia,'Times New Roman',serif;color:#14201B;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<div style="max-width:480px;margin:0 auto;">
<div style="padding:0 4px 14px;">${mark}</div>
<div style="background:#ffffff;border:1px solid #E6E1D6;border-radius:16px;padding:28px;">
${bodyHtml}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr><td align="center" style="padding:18px 4px 0;font-size:12px;line-height:1.6;color:#56605A;font-family:Arial,sans-serif;text-align:center;">
<div style="font-weight:700;color:#14201B;text-align:center;">${esc(b.name)}</div>
${b.address ? `<div style="text-align:center;">${esc(b.address)}</div>` : ""}
<div style="margin-top:6px;text-align:center;">${footer ? esc(footer) : "You are receiving this email because you signed up as a candidate on " + esc(b.name) + "." + (unsubscribeUrl ? ` If you wish to unsubscribe, <a href="${esc(unsubscribeUrl)}" style="color:#56605A;text-decoration:underline;">click here</a>.` : "")}</div>
<div style="margin-top:6px;color:#8A8578;text-align:center;">&copy; ${new Date().getFullYear()} ${esc(b.name)}</div>
</td></tr></table>
</div></body></html>`;
}

export function button(b: Brand, href: string, label: string) {
  return `<a href="${esc(href)}" style="display:inline-block;margin-top:18px;padding:12px 22px;background:${b.color};color:#ffffff;text-decoration:none;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;">${esc(label)}</a>`;
}

export async function sendBrevo(b: Brand, to: { email: string; name?: string }, subject: string, html: string, attachment?: { name: string; content: string }): Promise<boolean> {
  const key = Deno.env.get("BREVO_API_KEY"), senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!key || !senderEmail || !to.email) { console.error("Brevo not configured or no recipient; email not sent"); return false; }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
      body: JSON.stringify({ sender: { email: senderEmail, name: b.name }, to: [to], subject, htmlContent: html, ...(attachment ? { attachment: [attachment] } : {}) }),
    });
    if (!res.ok) { console.error("brevo send failed", res.status, (await res.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error("brevo send threw", String((e as Error)?.message || e)); return false; }
}
