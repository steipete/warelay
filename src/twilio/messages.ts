import { withWhatsAppPrefix } from "../utils.js";
import { readEnv } from "../env.js";
import { createClient } from "./client.js";

export type ListedMessage = {
  sid: string;
  status: string | null;
  direction: string | null;
  dateCreated: Date | undefined;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  errorCode: number | null;
  errorMessage: string | null;
};

// Remove duplicates by SID while preserving order.
export function uniqueBySid(messages: ListedMessage[]): ListedMessage[] {
	const seen = new Set<string>();
	const deduped: ListedMessage[] = [];
	for (const m of messages) {
		if (seen.has(m.sid)) continue;
		seen.add(m.sid);
		deduped.push(m);
	}
	return deduped;
}

// Sort messages newest -> oldest by dateCreated.
export function sortByDateDesc(messages: ListedMessage[]): ListedMessage[] {
	return [...messages].sort((a, b) => {
		const da = a.dateCreated?.getTime() ?? 0;
		const db = b.dateCreated?.getTime() ?? 0;
		return db - da;
	});
}

// Merge inbound/outbound messages (recent first) for status commands and tests.
export async function listRecentMessages(
  lookbackMinutes: number,
  limit: number,
  clientOverride?: ReturnType<typeof createClient>,
): Promise<ListedMessage[]> {
  const env = readEnv();
  const client = clientOverride ?? createClient(env);
  const from = withWhatsAppPrefix(env.whatsappFrom);
  const since = new Date(Date.now() - lookbackMinutes * 60_000);

  // Fetch inbound (to our WA number) and outbound (from our WA number), merge, sort, limit.
  const fetchLimit = Math.min(Math.max(limit * 2, limit + 10), 100);
  const inbound = await client.messages.list({ to: from, dateSentAfter: since, limit: fetchLimit });
  const outbound = await client.messages.list({ from, dateSentAfter: since, limit: fetchLimit });

  const inboundArr = Array.isArray(inbound) ? inbound : [];
  const outboundArr = Array.isArray(outbound) ? outbound : [];
  const combined = uniqueBySid(
    [...inboundArr, ...outboundArr].map((m) => ({
      sid: m.sid,
      status: m.status ?? null,
      direction: m.direction ?? null,
      dateCreated: m.dateCreated,
      from: m.from,
      to: m.to,
      body: m.body,
      errorCode: m.errorCode ?? null,
      errorMessage: m.errorMessage ?? null,
    })),
  );

  return sortByDateDesc(combined).slice(0, limit);
}

// Human-friendly single-line formatter for recent messages.
export function formatMessageLine(m: ListedMessage): string {
  const ts = m.dateCreated?.toISOString() ?? "unknown-time";
  const dir =
    m.direction === "inbound"
      ? "⬅️ "
      : m.direction === "outbound-api" || m.direction === "outbound-reply"
        ? "➡️ "
        : "↔️ ";
  const status = m.status ?? "unknown";
  const err =
    m.errorCode != null
      ? ` error ${m.errorCode}${m.errorMessage ? ` (${m.errorMessage})` : ""}`
      : "";
  const body = (m.body ?? "").replace(/\s+/g, " ").trim();
  const bodyPreview = body.length > 140 ? `${body.slice(0, 137)}…` : body || "<empty>";
  return `[${ts}] ${dir}${m.from ?? "?"} -> ${m.to ?? "?"} | ${status}${err} | ${bodyPreview} (sid ${m.sid})`;
}
