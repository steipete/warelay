import { REST, Routes } from "discord.js";

import { chunkText } from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { loadWebMedia } from "../web/media.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_TEXT_LIMIT = 2000;

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type DiscordSendOpts = {
  token?: string;
  mediaUrl?: string;
  verbose?: boolean;
  rest?: REST;
  /** Discord message ID to reply to (creates native reply link) */
  replyTo?: string;
};

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordReactOpts = {
  token?: string;
  rest?: REST;
};

function resolveToken(explicit?: string) {
  const cfgToken = loadConfig().discord?.token;
  const token = normalizeDiscordToken(
    explicit ?? process.env.DISCORD_BOT_TOKEN ?? cfgToken ?? undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord sends",
    );
  }
  return token;
}

function normalizeReactionEmoji(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji required");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed;
  return encodeURIComponent(identifier);
}

function parseRecipient(raw: string): DiscordRecipient {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Discord sends");
  }
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return { kind: "user", id: mentionMatch[1] };
  }
  if (trimmed.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length) };
  }
  if (trimmed.startsWith("channel:")) {
    return { kind: "channel", id: trimmed.slice("channel:".length) };
  }
  if (trimmed.startsWith("discord:")) {
    return { kind: "user", id: trimmed.slice("discord:".length) };
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1);
    if (!/^\d+$/.test(candidate)) {
      throw new Error(
        "Discord DMs require a user id (use user:<id> or a <@id> mention)",
      );
    }
    return { kind: "user", id: candidate };
  }
  return { kind: "channel", id: trimmed };
}

async function resolveChannelId(
  rest: REST,
  recipient: DiscordRecipient,
): Promise<{ channelId: string; dm?: boolean }> {
  if (recipient.kind === "channel") {
    return { channelId: recipient.id };
  }
  const dmChannel = (await rest.post(Routes.userChannels(), {
    body: { recipient_id: recipient.id },
  })) as { id: string };
  if (!dmChannel?.id) {
    throw new Error("Failed to create Discord DM channel");
  }
  return { channelId: dmChannel.id, dm: true };
}

async function sendDiscordText(
  rest: REST,
  channelId: string,
  text: string,
  replyTo?: string,
) {
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const messageReference = replyTo ? { message_id: replyTo } : undefined;
  if (text.length <= DISCORD_TEXT_LIMIT) {
    const res = (await rest.post(Routes.channelMessages(channelId), {
      body: { content: text, message_reference: messageReference },
    })) as { id: string; channel_id: string };
    return res;
  }
  const chunks = chunkText(text, DISCORD_TEXT_LIMIT);
  let last: { id: string; channel_id: string } | null = null;
  let isFirst = true;
  for (const chunk of chunks) {
    last = (await rest.post(Routes.channelMessages(channelId), {
      body: {
        content: chunk,
        // Only the first chunk should be a reply; subsequent chunks are regular messages
        message_reference: isFirst ? messageReference : undefined,
      },
    })) as { id: string; channel_id: string };
    isFirst = false;
  }
  if (!last) {
    throw new Error("Discord send failed (empty chunk result)");
  }
  return last;
}

async function sendDiscordMedia(
  rest: REST,
  channelId: string,
  text: string,
  mediaUrl: string,
  replyTo?: string,
) {
  const media = await loadWebMedia(mediaUrl);
  const caption =
    text.length > DISCORD_TEXT_LIMIT ? text.slice(0, DISCORD_TEXT_LIMIT) : text;
  const messageReference = replyTo ? { message_id: replyTo } : undefined;
  const res = (await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: caption || undefined,
      message_reference: messageReference,
    },
    files: [
      {
        data: media.buffer,
        name: media.fileName ?? "upload",
      },
    ],
  })) as { id: string; channel_id: string };
  if (text.length > DISCORD_TEXT_LIMIT) {
    const remaining = text.slice(DISCORD_TEXT_LIMIT).trim();
    if (remaining) {
      // Remaining text is not a reply; only the first message with media is the reply
      await sendDiscordText(rest, channelId, remaining);
    }
  }
  return res;
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts = {},
): Promise<DiscordSendResult> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient);
  let result:
    | { id: string; channel_id: string }
    | { id: string | null; channel_id: string };

  if (opts.mediaUrl) {
    result = await sendDiscordMedia(
      rest,
      channelId,
      text,
      opts.mediaUrl,
      opts.replyTo,
    );
  } else {
    result = await sendDiscordText(rest, channelId, text, opts.replyTo);
  }

  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? channelId),
  };
}

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const encoded = normalizeReactionEmoji(emoji);
  await rest.put(Routes.channelMessageReaction(channelId, messageId, encoded));
  return { ok: true };
}
