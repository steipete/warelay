import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  type CommandInteractionOption,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";

import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { DiscordSlashCommandConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose, warn } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageDiscord } from "./send.js";
import { normalizeDiscordToken } from "./token.js";

export type MonitorDiscordOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  slashCommand?: DiscordSlashCommandConfig;
  mediaMaxMb?: number;
  historyLimit?: number;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

export type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};

export type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  users?: Array<string | number>;
  channels?: Record<string, { allow?: boolean; requireMention?: boolean }>;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
};

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = loadConfig();
  const token = normalizeDiscordToken(
    opts.token ??
      process.env.DISCORD_BOT_TOKEN ??
      cfg.discord?.token ??
      undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord gateway",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const dmConfig = cfg.discord?.dm;
  const guildEntries = cfg.discord?.guilds;
  const allowFrom = dmConfig?.allowFrom;
  const slashCommand = resolveSlashCommandConfig(
    opts.slashCommand ?? cfg.discord?.slashCommand,
  );
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? cfg.discord?.historyLimit ?? 20,
  );
  const dmEnabled = dmConfig?.enabled ?? true;
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const logger = getChildLogger({ module: "discord-auto-reply" });
  const guildHistories = new Map<string, DiscordHistoryEntry[]>();

  client.once(Events.ClientReady, () => {
    runtime.log?.(`logged in as ${client.user?.tag ?? "unknown"}`);
    if (slashCommand.enabled) {
      void ensureSlashCommand(client, slashCommand, runtime);
    }
  });

  client.on(Events.Error, (err) => {
    runtime.error?.(danger(`client error: ${String(err)}`));
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.author) return;

      // Discord.js typing excludes GroupDM for message.channel.type; widen for runtime check.
      const channelType = message.channel.type as ChannelType;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGuildMessage = Boolean(message.guild);
      if (isGroupDm && !groupDmEnabled) return;
      if (isDirectMessage && !dmEnabled) return;
      const botId = client.user?.id;
      const wasMentioned =
        !isDirectMessage && Boolean(botId && message.mentions.has(botId));
      const attachment = message.attachments.first();
      const baseText =
        message.content?.trim() ||
        (attachment ? inferPlaceholder(attachment) : "") ||
        message.embeds[0]?.description ||
        "";

      const guildInfo = isGuildMessage
        ? resolveDiscordGuildEntry({
            guild: message.guild,
            guildEntries,
          })
        : null;
      if (
        isGuildMessage &&
        guildEntries &&
        Object.keys(guildEntries).length > 0 &&
        !guildInfo
      ) {
        logVerbose(
          `Blocked discord guild ${message.guild?.id ?? "unknown"} (not in discord.guilds)`,
        );
        return;
      }

      const channelName =
        (isGuildMessage || isGroupDm) && "name" in message.channel
          ? message.channel.name
          : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const guildSlug =
        guildInfo?.slug ||
        (message.guild?.name ? normalizeDiscordSlug(message.guild.name) : "");
      const channelConfig = isGuildMessage
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: message.channelId,
            channelName,
            channelSlug,
          })
        : null;

      const groupDmAllowed =
        isGroupDm &&
        resolveGroupDmAllow({
          channels: groupDmChannels,
          channelId: message.channelId,
          channelName,
          channelSlug,
        });
      if (isGroupDm && !groupDmAllowed) return;

      if (isGuildMessage && channelConfig?.allowed === false) {
        logVerbose(
          `Blocked discord channel ${message.channelId} not in guild channel allowlist`,
        );
        return;
      }

      if (isGuildMessage && historyLimit > 0 && baseText) {
        const history = guildHistories.get(message.channelId) ?? [];
        history.push({
          sender: message.member?.displayName ?? message.author.tag,
          body: baseText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
        });
        while (history.length > historyLimit) history.shift();
        guildHistories.set(message.channelId, history);
      }

      const resolvedRequireMention =
        channelConfig?.requireMention ?? guildInfo?.requireMention ?? true;
      if (isGuildMessage && resolvedRequireMention) {
        if (botId && !wasMentioned) {
          logger.info(
            {
              channelId: message.channelId,
              reason: "no-mention",
            },
            "discord: skipping guild message",
          );
          return;
        }
      }

      if (isGuildMessage) {
        const userAllow = guildInfo?.users;
        if (Array.isArray(userAllow) && userAllow.length > 0) {
          const users = normalizeDiscordAllowList(userAllow, [
            "discord:",
            "user:",
          ]);
          const userOk =
            !users ||
            allowListMatches(users, {
              id: message.author.id,
              name: message.author.username,
              tag: message.author.tag,
            });
          if (!userOk) {
            logVerbose(
              `Blocked discord guild sender ${message.author.id} (not in guild users allowlist)`,
            );
            return;
          }
        }
      }

      if (isDirectMessage && Array.isArray(allowFrom) && allowFrom.length > 0) {
        const allowList = normalizeDiscordAllowList(allowFrom, [
          "discord:",
          "user:",
        ]);
        const permitted =
          allowList &&
          allowListMatches(allowList, {
            id: message.author.id,
            name: message.author.username,
            tag: message.author.tag,
          });
        if (!permitted) {
          logVerbose(
            `Blocked unauthorized discord sender ${message.author.id} (not in allowFrom)`,
          );
          return;
        }
      }

      const media = await resolveMedia(message, mediaMaxBytes);
      const text =
        message.content?.trim() ??
        media?.placeholder ??
        message.embeds[0]?.description ??
        "";
      if (!text) return;

      const fromLabel = isDirectMessage
        ? buildDirectLabel(message)
        : buildGuildLabel(message);
      const groupRoom =
        isGuildMessage && channelSlug ? `#${channelSlug}` : undefined;
      const groupSubject = isDirectMessage ? undefined : groupRoom;
      const textWithId = `${text}\n[discord message id: ${message.id} channel: ${message.channelId}]`;
      let combinedBody = formatAgentEnvelope({
        surface: "Discord",
        from: fromLabel,
        timestamp: message.createdTimestamp,
        body: textWithId,
      });
      let shouldClearHistory = false;
      if (!isDirectMessage) {
        const history =
          historyLimit > 0 ? (guildHistories.get(message.channelId) ?? []) : [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((entry) =>
              formatAgentEnvelope({
                surface: "Discord",
                from: fromLabel,
                timestamp: entry.timestamp,
                body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
              }),
            )
            .join("\n");
          combinedBody = `[Chat messages since your last reply - for context]\n${historyText}\n\n[Current message - respond to this]\n${combinedBody}`;
        }
        const name = message.author.tag;
        const id = message.author.id;
        combinedBody = `${combinedBody}\n[from: ${name} id:${id}]`;
        shouldClearHistory = true;
      }

      const ctxPayload = {
        Body: combinedBody,
        From: isDirectMessage
          ? `discord:${message.author.id}`
          : `group:${message.channelId}`,
        To: isDirectMessage
          ? `user:${message.author.id}`
          : `channel:${message.channelId}`,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName: message.member?.displayName ?? message.author.tag,
        GroupSubject: groupSubject,
        GroupRoom: groupRoom,
        GroupSpace: isGuildMessage ? guildSlug || undefined : undefined,
        Surface: "discord" as const,
        WasMentioned: wasMentioned,
        MessageSid: message.id,
        Timestamp: message.createdTimestamp,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
      };

      if (isDirectMessage) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "discord",
          to: `user:${message.author.id}`,
        });
      }

      if (isVerbose()) {
        const preview = combinedBody.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        {
          onReplyStart: () => sendTyping(message),
        },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        target: ctxPayload.To,
        token,
        runtime,
        originalMessageId: ctxPayload.MessageSid,
      });
      if (isGuildMessage && shouldClearHistory && historyLimit > 0) {
        guildHistories.set(message.channelId, []);
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!slashCommand.enabled) return;
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== slashCommand.name) return;
      if (interaction.user?.bot) return;

      const channelType = interaction.channel?.type as ChannelType | undefined;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const isDirectMessage =
        !interaction.inGuild() && channelType === ChannelType.DM;
      const isGuildMessage = interaction.inGuild();

      if (isGroupDm && !groupDmEnabled) return;
      if (isDirectMessage && !dmEnabled) return;

      if (isGuildMessage) {
        const guildInfo = resolveDiscordGuildEntry({
          guild: interaction.guild ?? null,
          guildEntries,
        });
        if (
          guildEntries &&
          Object.keys(guildEntries).length > 0 &&
          !guildInfo
        ) {
          logVerbose(
            `Blocked discord guild ${interaction.guildId ?? "unknown"} (not in discord.guilds)`,
          );
          return;
        }
        const channelName =
          interaction.channel && "name" in interaction.channel
            ? interaction.channel.name
            : undefined;
        const channelSlug = channelName
          ? normalizeDiscordSlug(channelName)
          : "";
        const channelConfig = resolveDiscordChannelConfig({
          guildInfo,
          channelId: interaction.channelId,
          channelName,
          channelSlug,
        });
        if (channelConfig?.allowed === false) {
          logVerbose(
            `Blocked discord channel ${interaction.channelId} not in guild channel allowlist`,
          );
          return;
        }
        const userAllow = guildInfo?.users;
        if (Array.isArray(userAllow) && userAllow.length > 0) {
          const users = normalizeDiscordAllowList(userAllow, [
            "discord:",
            "user:",
          ]);
          const userOk =
            !users ||
            allowListMatches(users, {
              id: interaction.user.id,
              name: interaction.user.username,
              tag: interaction.user.tag,
            });
          if (!userOk) {
            logVerbose(
              `Blocked discord guild sender ${interaction.user.id} (not in guild users allowlist)`,
            );
            return;
          }
        }
      } else if (isGroupDm) {
        const channelName =
          interaction.channel && "name" in interaction.channel
            ? interaction.channel.name
            : undefined;
        const channelSlug = channelName
          ? normalizeDiscordSlug(channelName)
          : "";
        const groupDmAllowed = resolveGroupDmAllow({
          channels: groupDmChannels,
          channelId: interaction.channelId,
          channelName,
          channelSlug,
        });
        if (!groupDmAllowed) return;
      } else if (isDirectMessage) {
        if (Array.isArray(allowFrom) && allowFrom.length > 0) {
          const allowList = normalizeDiscordAllowList(allowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted =
            allowList &&
            allowListMatches(allowList, {
              id: interaction.user.id,
              name: interaction.user.username,
              tag: interaction.user.tag,
            });
          if (!permitted) {
            logVerbose(
              `Blocked unauthorized discord sender ${interaction.user.id} (not in allowFrom)`,
            );
            return;
          }
        }
      }

      const prompt = resolveSlashPrompt(interaction.options.data);
      if (!prompt) {
        await interaction.reply({
          content: "Message required.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: slashCommand.ephemeral });

      const userId = interaction.user.id;
      const ctxPayload = {
        Body: prompt,
        From: `discord:${userId}`,
        To: `slash:${userId}`,
        ChatType: "direct",
        SenderName: interaction.user.username,
        Surface: "discord" as const,
        WasMentioned: true,
        MessageSid: interaction.id,
        Timestamp: interaction.createdTimestamp,
        SessionKey: `${slashCommand.sessionPrefix}:${userId}`,
      };

      const replyResult = await getReplyFromConfig(ctxPayload, undefined, cfg);
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];

      await deliverSlashReplies({
        replies,
        interaction,
        ephemeral: slashCommand.ephemeral,
      });
    } catch (err) {
      runtime.error?.(danger(`slash handler failed: ${String(err)}`));
      if (interaction.isRepliable()) {
        const content = "Sorry, something went wrong handling that command.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      }
    }
  });

  await client.login(token);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void client.destroy();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      client.off(Events.Error, onError);
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    client.on(Events.Error, onError);
  });
}

async function resolveMedia(
  message: import("discord.js").Message,
  maxBytes: number,
): Promise<DiscordMediaInfo | null> {
  const attachment = message.attachments.first();
  if (!attachment) return null;
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download discord attachment: HTTP ${res.status}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer,
    headerMime: attachment.contentType ?? res.headers.get("content-type"),
    filePath: attachment.name ?? attachment.url,
  });
  const saved = await saveMediaBuffer(buffer, mime, "inbound", maxBytes);
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: inferPlaceholder(attachment),
  };
}

function inferPlaceholder(attachment: import("discord.js").Attachment): string {
  const mime = attachment.contentType ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function buildDirectLabel(message: import("discord.js").Message) {
  const username = message.author.tag;
  return `${username} id:${message.author.id}`;
}

function buildGuildLabel(message: import("discord.js").Message) {
  const channelName =
    "name" in message.channel ? message.channel.name : message.channelId;
  return `${message.guild?.name ?? "Guild"} #${channelName} id:${message.channelId}`;
}

export function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
): DiscordAllowList | null {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  let allowAll = false;

  for (const rawEntry of raw) {
    let entry = String(rawEntry).trim();
    if (!entry) continue;
    if (entry === "*") {
      allowAll = true;
      continue;
    }
    for (const prefix of prefixes) {
      if (entry.toLowerCase().startsWith(prefix)) {
        entry = entry.slice(prefix.length);
        break;
      }
    }
    const mentionMatch = entry.match(/^<[@#][!]?(\d+)>$/);
    if (mentionMatch?.[1]) {
      ids.add(mentionMatch[1]);
      continue;
    }
    entry = entry.trim();
    if (entry.startsWith("@") || entry.startsWith("#")) {
      entry = entry.slice(1);
    }
    if (/^\d+$/.test(entry)) {
      ids.add(entry);
      continue;
    }
    const normalized = normalizeDiscordName(entry);
    if (normalized) names.add(normalized);
    const slugged = normalizeDiscordSlug(entry);
    if (slugged) names.add(slugged);
  }

  if (!allowAll && ids.size === 0 && names.size === 0) return null;
  return { allowAll, ids, names };
}

function normalizeDiscordName(value?: string | null) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

export function normalizeDiscordSlug(value?: string | null) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  text = text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return text;
}

export function allowListMatches(
  allowList: DiscordAllowList,
  candidates: {
    id?: string;
    name?: string | null;
    tag?: string | null;
  },
) {
  if (allowList.allowAll) return true;
  const { id, name, tag } = candidates;
  if (id && allowList.ids.has(id)) return true;
  const normalizedName = normalizeDiscordName(name);
  if (normalizedName && allowList.names.has(normalizedName)) return true;
  const normalizedTag = normalizeDiscordName(tag);
  if (normalizedTag && allowList.names.has(normalizedTag)) return true;
  const slugName = normalizeDiscordSlug(name);
  if (slugName && allowList.names.has(slugName)) return true;
  const slugTag = normalizeDiscordSlug(tag);
  if (slugTag && allowList.names.has(slugTag)) return true;
  return false;
}

export function resolveDiscordGuildEntry(params: {
  guild: import("discord.js").Guild | null;
  guildEntries: Record<string, DiscordGuildEntryResolved> | undefined;
}): DiscordGuildEntryResolved | null {
  const { guild, guildEntries } = params;
  if (!guild || !guildEntries || Object.keys(guildEntries).length === 0) {
    return null;
  }
  const guildId = guild.id;
  const guildSlug = normalizeDiscordSlug(guild.name);
  const direct = guildEntries[guildId];
  if (direct) {
    return {
      id: guildId,
      slug: direct.slug ?? guildSlug,
      requireMention: direct.requireMention,
      users: direct.users,
      channels: direct.channels,
    };
  }
  if (guildSlug && guildEntries[guildSlug]) {
    const entry = guildEntries[guildSlug];
    return {
      id: guildId,
      slug: entry.slug ?? guildSlug,
      requireMention: entry.requireMention,
      users: entry.users,
      channels: entry.channels,
    };
  }
  const matchBySlug = Object.entries(guildEntries).find(([, entry]) => {
    const entrySlug = normalizeDiscordSlug(entry.slug);
    return entrySlug && entrySlug === guildSlug;
  });
  if (matchBySlug) {
    const entry = matchBySlug[1];
    return {
      id: guildId,
      slug: entry.slug ?? guildSlug,
      requireMention: entry.requireMention,
      users: entry.users,
      channels: entry.channels,
    };
  }
  return null;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug?: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channelEntries = guildInfo?.channels;
  if (channelEntries && Object.keys(channelEntries).length > 0) {
    const entry =
      channelEntries[channelId] ??
      (channelSlug
        ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
        : undefined) ??
      (channelName
        ? channelEntries[normalizeDiscordSlug(channelName)]
        : undefined);
    if (!entry) return { allowed: false };
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
    };
  }
  return { allowed: true };
}

export function resolveGroupDmAllow(params: {
  channels: Array<string | number> | undefined;
  channelId: string;
  channelName?: string;
  channelSlug?: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) return true;
  const allowList = normalizeDiscordAllowList(channels, ["channel:"]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: channelId,
    name: channelSlug || channelName,
  });
}

async function ensureSlashCommand(
  client: Client,
  slashCommand: Required<DiscordSlashCommandConfig>,
  runtime: RuntimeEnv,
) {
  try {
    const appCommands = client.application?.commands;
    if (!appCommands) {
      runtime.error?.(danger("discord slash commands unavailable"));
      return;
    }
    const existing = await appCommands.fetch();
    const hasCommand = Array.from(existing.values()).some(
      (entry) => entry.name === slashCommand.name,
    );
    if (hasCommand) return;
    await appCommands.create({
      name: slashCommand.name,
      description: "Ask Clawdis a question",
      options: [
        {
          name: "prompt",
          description: "What should Clawdis help with?",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    });
    runtime.log?.(`registered discord slash command /${slashCommand.name}`);
  } catch (err) {
    const status = (err as { status?: number | string })?.status;
    const code = (err as { code?: number | string })?.code;
    const message = String(err);
    const isRateLimit =
      status === 429 || code === 429 || /rate ?limit/i.test(message);
    const text = `discord slash command setup failed: ${message}`;
    if (isRateLimit) {
      logVerbose(text);
      runtime.error?.(warn(text));
    } else {
      runtime.error?.(danger(text));
    }
  }
}

function resolveSlashCommandConfig(
  raw: DiscordSlashCommandConfig | undefined,
): Required<DiscordSlashCommandConfig> {
  return {
    enabled: raw ? raw.enabled !== false : false,
    name: raw?.name?.trim() || "clawd",
    sessionPrefix: raw?.sessionPrefix?.trim() || "discord:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}

function resolveSlashPrompt(
  options: readonly CommandInteractionOption[],
): string | undefined {
  const direct = findFirstStringOption(options);
  if (direct) return direct;
  return undefined;
}

function findFirstStringOption(
  options: readonly CommandInteractionOption[],
): string | undefined {
  for (const option of options) {
    if (typeof option.value === "string") {
      const trimmed = option.value.trim();
      if (trimmed) return trimmed;
    }
    if (option.options && option.options.length > 0) {
      const nested = findFirstStringOption(option.options);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function sendTyping(message: Message) {
  try {
    const channel = message.channel;
    if (channel.isSendable()) {
      await channel.sendTyping();
    }
  } catch {
    /* ignore */
  }
}

async function deliverReplies({
  replies,
  target,
  token,
  runtime,
  originalMessageId,
}: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  runtime: RuntimeEnv;
  /** Discord message ID to reply to (creates native reply link for the first message only) */
  originalMessageId?: string;
}) {
  // Track whether we've sent the first message (only the first should be a reply)
  let isFirstMessage = true;
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, 2000)) {
        await sendMessageDiscord(target, chunk, {
          token,
          replyTo: isFirstMessage ? originalMessageId : undefined,
        });
        isFirstMessage = false;
      }
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageDiscord(target, caption, {
          token,
          mediaUrl,
          replyTo: isFirstMessage ? originalMessageId : undefined,
        });
        isFirstMessage = false;
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

async function deliverSlashReplies({
  replies,
  interaction,
  ephemeral,
}: {
  replies: ReplyPayload[];
  interaction: import("discord.js").ChatInputCommandInteraction;
  ephemeral: boolean;
}) {
  const messages: string[] = [];
  for (const payload of replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text =
      textRaw && textRaw !== SILENT_REPLY_TOKEN ? textRaw : undefined;
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [
      text ?? "",
      ...mediaList.map((url) => url.trim()).filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n");
    if (!combined) continue;
    for (const chunk of chunkText(combined, 2000)) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    await interaction.editReply({
      content: "No response was generated for that command.",
    });
    return;
  }

  const [first, ...rest] = messages;
  await interaction.editReply({ content: first });
  for (const message of rest) {
    await interaction.followUp({ content: message, ephemeral });
  }
}
